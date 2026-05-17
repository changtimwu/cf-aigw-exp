import type { Env } from "./env.js";
import { getUserByApiKey } from "./users.js";
import { getUsage } from "./usage.js";

// Phase 5a: realtime (gpt-realtime-whisper) WebSocket handler.
//
// Why this bypasses AI Gateway: see REALTIME_BYPASS.md. CF AI Gateway's
// WebSocket proxy doesn't currently route the GA Realtime shape; every
// path tested either returns 500 or upgrades and immediately drops the
// connection. We dial OpenAI directly using a Worker-secret copy of the
// OpenAI API key. The desktop app's per-user authentication is preserved
// — only this hop changes.
//
// Phase 5a does NOT meter audio time against the per-user budget yet —
// the budget pre-check still runs, but a realtime-only user could exceed
// the budget without their counter incrementing. Phase 5b wires the
// usage counter into the SSE-equivalent (audio bytes counted as they
// flow through the Worker).

// Note: Workers fetch() accepts only http/https URLs even for WebSocket
// upgrades — the scheme is https; the Upgrade header opts into WS.
const OPENAI_REALTIME_HOST = "https://api.openai.com/v1/realtime";

// Models we permit as the "session" of a realtime connection. The current
// transcription model goes into session.update.audio.input.transcription.model
// (not validated here — it's inside the user-controlled WS payload).
// Allow-list match below: the user must have one of these in
// `allowed_models` to open a realtime socket at all.
const REALTIME_MODEL_NAMES = new Set(["gpt-realtime-whisper", "gpt-realtime"]);

export async function handleRealtime(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
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
  // Realtime sessions are gated as a whole: the user must have *some*
  // realtime model in their allow-list to open a WS. Specific
  // transcription model selection happens later in session.update and
  // is not enforced here (would require parsing every client message).
  if (user.allowed_models.length > 0) {
    const allowed = user.allowed_models.some((m) => REALTIME_MODEL_NAMES.has(m));
    if (!allowed) return wsRejection(403, "model_not_allowed");
  }

  // --- budget pre-check ---
  // Phase 5a: counter is not updated by realtime, so this check just
  // prevents brand-new realtime sessions when the user is already over
  // from prior REST usage.
  if (user.token_budget > 0) {
    const usage = await getUsage(env, user.sub);
    if (usage.tokens_used >= user.token_budget) {
      return wsRejection(429, "budget_exceeded");
    }
  }

  // --- upstream upgrade ---
  const inUrl = new URL(request.url);
  // Forward the client's query string verbatim — covers ?intent=transcription
  // (transcription-only sessions) and ?model=<realtime-model> (bidirectional).
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

  // --- pump both directions ---
  // Use addEventListener so we can install close/error handlers cleanly.
  server.addEventListener("message", (e) => {
    try {
      upstream.send(e.data);
    } catch {
      // upstream may have closed; ignore — close handler below tears down
    }
  });
  upstream.addEventListener("message", (e) => {
    try {
      server.send(e.data);
    } catch {
      // server may have closed
    }
  });

  // Close propagation: when one side closes, close the other with the same
  // code/reason so the client gets a meaningful close frame.
  server.addEventListener("close", (e) => {
    safeClose(upstream, e.code, e.reason);
  });
  upstream.addEventListener("close", (e) => {
    safeClose(server, e.code, e.reason);
  });
  server.addEventListener("error", () => safeClose(upstream, 1011, "client_error"));
  upstream.addEventListener("error", () => safeClose(server, 1011, "upstream_error"));

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
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
