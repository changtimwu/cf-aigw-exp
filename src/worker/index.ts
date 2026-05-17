import type { Env } from "./env.js";
import { handleAdmin } from "./admin.js";
import { handleRealtime } from "./realtime.js";
import { getUserByApiKey, type UserRecord } from "./users.js";
import { getUsage, incrementUsageDO } from "./usage.js";

export { UsageCounter } from "./usage.js";

// Phase 4 Worker: per-user API key auth (KV) + atomic per-user usage
// counters (Durable Objects). Tracks token usage for both non-streaming
// and streaming chat completions. Forwards approved requests to CF AI
// Gateway with BYOK substitution.
//
// Incoming public traffic:  POST <worker>/chat/completions, /audio/transcriptions, etc.
//                           Authorization: Bearer <user-api-key>
// Incoming admin traffic:   anything under /admin/* with x-admin-token header.
// Outgoing to gateway:      cf-aig-authorization: Bearer <gateway-token>
//                           no Authorization (BYOK substitution requires it absent;
//                           see project-byok-header-quirk memory).

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Realtime WebSocket sessions bypass AI Gateway and dial OpenAI direct;
    // see REALTIME_BYPASS.md for the rationale. Any WS upgrade is treated as
    // a realtime request regardless of path.
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return handleRealtime(request, env, ctx);
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith("/admin")) {
      return handleAdmin(request, env);
    }

    // --- per-user auth ---
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      return jsonError(401, "missing_authorization");
    }
    const apiKey = authHeader.slice(7).trim();
    const user = await getUserByApiKey(env, apiKey);
    if (!user) return jsonError(401, "invalid_api_key");
    if (user.revoked) return jsonError(403, "user_revoked");

    // Budget check uses the Durable Object — atomic, not subject to
    // KV's 1-write/sec/key cap. See SCALING.md for context.
    if (user.token_budget > 0) {
      const usage = await getUsage(env, user.sub);
      if (usage.tokens_used >= user.token_budget) {
        return jsonError(429, "budget_exceeded");
      }
    }

    // --- request body shaping ---
    // For chat completions: parse to enforce allow-list AND inject
    // `stream_options.include_usage` so streaming responses emit a
    // final usage chunk we can parse.
    // Other endpoints (Whisper multipart): stream the body through.
    let forwardBody: BodyInit | null = null;
    let isStreamingChat = false;
    if (request.method !== "GET" && request.method !== "HEAD") {
      if (url.pathname === "/chat/completions") {
        const text = await request.text();
        let parsed: { model?: string; stream?: boolean; stream_options?: { include_usage?: boolean } };
        try {
          parsed = JSON.parse(text);
        } catch {
          return jsonError(400, "invalid_json");
        }
        if (
          user.allowed_models.length > 0 &&
          (!parsed.model || !user.allowed_models.includes(parsed.model))
        ) {
          return jsonError(403, "model_not_allowed");
        }
        if (parsed.stream === true) {
          isStreamingChat = true;
          parsed.stream_options = { ...(parsed.stream_options ?? {}), include_usage: true };
        }
        forwardBody = JSON.stringify(parsed);
      } else {
        forwardBody = request.body;
      }
    }

    // --- forward to AI Gateway ---
    const upstream = new URL(
      `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AIGW_ID}/openai${url.pathname}${url.search}`,
    );
    const fwdHeaders = new Headers(request.headers);
    fwdHeaders.delete("authorization");
    fwdHeaders.delete("host");
    fwdHeaders.delete("cookie");
    // The OpenAI SDK may have set content-length for the original body;
    // we rewrote chat bodies so let fetch recalculate.
    if (url.pathname === "/chat/completions") fwdHeaders.delete("content-length");
    fwdHeaders.set("cf-aig-authorization", `Bearer ${env.CF_AIGW_TOKEN}`);
    fwdHeaders.set("cf-aig-metadata", JSON.stringify({ user: user.sub }));

    const upstreamRes = await fetch(upstream.toString(), {
      method: request.method,
      headers: fwdHeaders,
      body: forwardBody,
    });

    // --- response: usage tracking + pass-through ---
    if (isStreamingChat && upstreamRes.body && upstreamRes.ok) {
      // Tee: one branch streams to the client, the other parses SSE
      // server-side for the usage chunk.
      const [clientBranch, parseBranch] = upstreamRes.body.tee();
      ctx.waitUntil(parseSseUsage(parseBranch, env, user));
      return new Response(clientBranch, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: responseHeaders(upstreamRes.headers, user),
      });
    }

    if (
      url.pathname === "/chat/completions" &&
      upstreamRes.ok &&
      (upstreamRes.headers.get("content-type") ?? "").includes("application/json")
    ) {
      const buf = await upstreamRes.text();
      try {
        const parsed = JSON.parse(buf) as { usage?: { total_tokens?: number } };
        const used = parsed.usage?.total_tokens ?? 0;
        if (used > 0) {
          ctx.waitUntil(incrementUsageDO(env, user.sub, used));
        }
      } catch {
        // Don't fail the request because usage parsing failed.
      }
      return new Response(buf, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: responseHeaders(upstreamRes.headers, user),
      });
    }

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: responseHeaders(upstreamRes.headers, user),
    });
  },
} satisfies ExportedHandler<Env>;

// Parse an OpenAI SSE stream looking for the final chunk that carries
// `usage`. Emitted by OpenAI when the request had
// `stream_options.include_usage: true` (we inject this above).
async function parseSseUsage(stream: ReadableStream, env: Env, user: UserRecord): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const event = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const line = event.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data) as { usage?: { total_tokens?: number } };
          const used = j.usage?.total_tokens ?? 0;
          if (used > 0) {
            await incrementUsageDO(env, user.sub, used);
          }
        } catch {
          // Ignore malformed lines; keep reading.
        }
      }
    }
  } catch {
    // Stream errors don't fail the request; usage just doesn't get counted.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function responseHeaders(src: Headers, user: UserRecord): Headers {
  const h = new Headers(src);
  for (const [k, v] of Object.entries(corsHeaders())) h.set(k, v);
  h.set("x-user", user.sub);
  return h;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, x-admin-token",
  };
}

function jsonError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}
