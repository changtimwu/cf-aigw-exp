import type { Env } from "./env.js";
import { getUserByApiKey } from "./users.js";
import { getUsage, incrementAudioDO } from "./usage.js";

// Phase 5a/5b: realtime (gpt-realtime-whisper) WebSocket handler.
//
// 5a: per-user auth on upgrade; bypass AI Gateway and dial OpenAI direct;
//     bidirectional pump. See REALTIME_BYPASS.md.
// 5b: count audio bytes flowing client→upstream (base64-decoded length of
//     each input_audio_buffer.append.audio), flush to the per-user
//     Durable Object on each conversation.item.input_audio_transcription
//     .completed event. Audio assumed 24 kHz mono PCM16 → 48 000 B/s.

// Note: Workers fetch() accepts only http/https URLs even for WebSocket
// upgrades — the scheme is https; the Upgrade header opts into WS.
const OPENAI_REALTIME_HOST = "https://api.openai.com/v1/realtime";

const REALTIME_MODEL_NAMES = new Set(["gpt-realtime-whisper", "gpt-realtime"]);

// 24 kHz mono PCM16 = 24000 samples/s × 2 bytes/sample × 1 channel = 48 000 B/s.
// We hardcode this for now. Clients can specify other rates in
// session.update.audio.input.format.rate; supporting that means parsing
// session.update on the way through and tracking per-session — deferred.
const PCM16_24K_MONO_BYTES_PER_SECOND = 48_000;

export async function handleRealtime(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // --- auth ---
  const auth = request.headers.get("authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) {
    return wsRejection(401, "missing_authorization");
  }
  const apiKey = auth.slice(7).trim();
  const user = await getUserByApiKey(env, apiKey);
  if (!user) return wsRejection(401, "invalid_api_key");
  if (user.revoked) return wsRejection(403, "user_revoked");

  // --- model allow-list ---
  // The transcription model is set later in session.update.audio.input
  // .transcription.model — not enforced here (would require parsing every
  // client message). Gate at the session level instead: user must have
  // at least one realtime model in allowed_models.
  if (user.allowed_models.length > 0) {
    const allowed = user.allowed_models.some((m) => REALTIME_MODEL_NAMES.has(m));
    if (!allowed) return wsRejection(403, "model_not_allowed");
  }

  // --- budget pre-check (both kinds) ---
  // Pre-flight only; once the session is open, audio counted mid-session can
  // overshoot before the next session is blocked. Same model as Phase 4
  // streaming chat.
  const usage = await getUsage(env, user.sub);
  if (user.token_budget > 0 && usage.tokens_used >= user.token_budget) {
    return wsRejection(429, "budget_exceeded");
  }
  if ((user.audio_seconds_budget ?? 0) > 0 && usage.audio_seconds_used >= user.audio_seconds_budget) {
    return wsRejection(429, "audio_budget_exceeded");
  }

  // --- upstream upgrade ---
  const inUrl = new URL(request.url);
  const upstreamUrl = `${OPENAI_REALTIME_HOST}${inUrl.search}`;
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: { code: "upstream_fetch_failed", message: String(err) } }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  if (upstreamRes.status !== 101 || !upstreamRes.webSocket) {
    let body = "";
    try {
      body = await upstreamRes.text();
    } catch {
      /* ignore */
    }
    return new Response(
      JSON.stringify({
        error: {
          code: "upstream_upgrade_failed",
          status: upstreamRes.status,
          body: body.slice(0, 500),
        },
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
  const upstream = upstreamRes.webSocket;

  // --- client-side pair ---
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  upstream.accept();

  // --- session-local audio byte counter (Phase 5b) ---
  // Accumulates client→upstream PCM bytes between two
  // conversation.item.input_audio_transcription.completed events
  // (i.e. per audio segment as defined by server VAD + commit).
  // Flushed to the DO on each completed event.
  let pendingAudioBytes = 0;

  // --- pump: client → upstream (count audio bytes) ---
  server.addEventListener("message", (e) => {
    if (typeof e.data === "string") {
      const t = peekType(e.data);
      if (t === "input_audio_buffer.append") {
        const b64 = peekAudio(e.data);
        if (b64) pendingAudioBytes += base64DecodedLength(b64);
      }
    }
    try {
      upstream.send(e.data);
    } catch {
      // upstream may have closed; close handler tears down
    }
  });

  // --- pump: upstream → client (flush on completed) ---
  upstream.addEventListener("message", (e) => {
    if (typeof e.data === "string") {
      const t = peekType(e.data);
      if (t === "conversation.item.input_audio_transcription.completed" && pendingAudioBytes > 0) {
        const seconds = pendingAudioBytes / PCM16_24K_MONO_BYTES_PER_SECOND;
        pendingAudioBytes = 0;
        ctx.waitUntil(incrementAudioDO(env, user.sub, seconds));
      }
    }
    try {
      server.send(e.data);
    } catch {
      // server may have closed
    }
  });

  // --- close propagation ---
  // On either close, flush whatever pending bytes are left (the client
  // may have disconnected mid-segment before the completed event fires).
  const flushIfPending = () => {
    if (pendingAudioBytes > 0) {
      const seconds = pendingAudioBytes / PCM16_24K_MONO_BYTES_PER_SECOND;
      pendingAudioBytes = 0;
      ctx.waitUntil(incrementAudioDO(env, user.sub, seconds));
    }
  };

  server.addEventListener("close", (e) => {
    flushIfPending();
    safeClose(upstream, e.code, e.reason);
  });
  upstream.addEventListener("close", (e) => {
    flushIfPending();
    safeClose(server, e.code, e.reason);
  });
  server.addEventListener("error", () => {
    flushIfPending();
    safeClose(upstream, 1011, "client_error");
  });
  upstream.addEventListener("error", () => {
    flushIfPending();
    safeClose(server, 1011, "upstream_error");
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

// JSON.parse on every message is fine for our throughput (audio chunks are
// ~100ms apart), but we can avoid the structural cost by peeking just at
// the type field with a string search. Falls back to JSON.parse on near-miss.
function peekType(data: string): string | null {
  // Tight check first — OpenAI events serialise the type field early.
  const m = data.match(/"type"\s*:\s*"([^"]+)"/);
  return m ? m[1]! : null;
}

function peekAudio(data: string): string | null {
  // Extract the audio field's string value — base64, no escapes to worry
  // about. Match `"audio":"<…>"` non-greedily.
  const m = data.match(/"audio"\s*:\s*"([^"]+)"/);
  return m ? m[1]! : null;
}

function base64DecodedLength(b64: string): number {
  // Length of decoded bytes from a base64 string. Each 4 chars → 3 bytes,
  // minus padding `=`s.
  const len = b64.length;
  if (len === 0) return 0;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (len * 3) / 4 - padding;
}

function safeClose(ws: WebSocket, code: number, reason: string) {
  try {
    ws.close(code, reason);
  } catch {
    // already closed
  }
}

function wsRejection(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
