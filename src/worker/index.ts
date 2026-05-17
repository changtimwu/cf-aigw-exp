import type { Env } from "./env.js";
import { handleAdmin } from "./admin.js";
import {
  getUserByApiKey,
  hashApiKey,
  incrementUsage,
  type User,
} from "./users.js";

// Phase 3 Worker: per-user API key auth backed by Workers KV, plus admin
// endpoints. Forwards approved requests to CF AI Gateway and tracks usage
// for non-streaming chat completions.
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
    if (user.token_budget > 0 && user.tokens_used >= user.token_budget) {
      return jsonError(429, "budget_exceeded");
    }

    // --- model allow-list (chat completions only — Whisper sends multipart) ---
    let forwardBody: BodyInit | null = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      if (url.pathname === "/chat/completions") {
        const text = await request.text();
        try {
          const parsed = JSON.parse(text) as { model?: string };
          if (
            user.allowed_models.length > 0 &&
            (!parsed.model || !user.allowed_models.includes(parsed.model))
          ) {
            return jsonError(403, "model_not_allowed");
          }
        } catch {
          return jsonError(400, "invalid_json");
        }
        forwardBody = text;
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
    fwdHeaders.set("cf-aig-authorization", `Bearer ${env.CF_AIGW_TOKEN}`);
    fwdHeaders.set("cf-aig-metadata", JSON.stringify({ user: user.sub }));

    const upstreamRes = await fetch(upstream.toString(), {
      method: request.method,
      headers: fwdHeaders,
      body: forwardBody,
    });

    // --- usage tracking (non-streaming chat only) ---
    // Streaming responses pass through unread so SSE keeps streaming; tokens
    // for those requests are not counted yet (Phase 3 gap).
    const isStream =
      (upstreamRes.headers.get("content-type") ?? "").includes("event-stream");
    if (
      !isStream &&
      url.pathname === "/chat/completions" &&
      upstreamRes.ok &&
      (upstreamRes.headers.get("content-type") ?? "").includes("application/json")
    ) {
      const buf = await upstreamRes.text();
      try {
        const parsed = JSON.parse(buf) as { usage?: { total_tokens?: number } };
        const used = parsed.usage?.total_tokens ?? 0;
        if (used > 0) {
          ctx.waitUntil(incrementUsageBg(env, user, apiKey, used));
        }
      } catch {
        // Don't fail the whole request just because usage parsing failed.
      }
      const resHeaders = withCors(upstreamRes.headers);
      resHeaders.set("x-user", user.sub);
      return new Response(buf, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: resHeaders,
      });
    }

    const resHeaders = withCors(upstreamRes.headers);
    resHeaders.set("x-user", user.sub);
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: resHeaders,
    });
  },
} satisfies ExportedHandler<Env>;

async function incrementUsageBg(env: Env, user: User, apiKey: string, addedTokens: number) {
  const hash = await hashApiKey(apiKey);
  await incrementUsage(env, user, hash, addedTokens);
}

function withCors(src: Headers): Headers {
  const h = new Headers(src);
  for (const [k, v] of Object.entries(corsHeaders())) h.set(k, v);
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
