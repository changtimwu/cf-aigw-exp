import { verifyJWT } from "../jwt.js";
import type { Env } from "./env.js";

// Phase 2 Worker: per-user auth + transparent proxy to CF AI Gateway.
//
// Incoming:  POST <worker>/chat/completions, /audio/transcriptions, etc.
//            Authorization: Bearer <user-jwt>
// Outgoing:  POST gateway.ai.cloudflare.com/v1/<acct>/<gw>/openai/<path>
//            cf-aig-authorization: Bearer <gateway-token>
//            (no Authorization header — required for BYOK substitution; see
//             project-byok-header-quirk memory.)

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 1. Validate per-user JWT.
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      return jsonError(401, "missing_authorization");
    }
    const token = authHeader.slice(7).trim();
    const claims = await verifyJWT(token, env.JWT_SECRET);
    if (!claims) {
      return jsonError(401, "invalid_or_expired_token");
    }

    // 2. Build upstream URL: anything after the Worker's hostname is
    // appended verbatim to the gateway's /openai path. So a client baseURL
    // of `https://worker.dev` produces `gateway.../openai/chat/completions`.
    const inUrl = new URL(request.url);
    const upstream = new URL(
      `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AIGW_ID}/openai${inUrl.pathname}${inUrl.search}`,
    );

    // 3. Build outgoing headers. Drop incoming Authorization (it was the
    // user JWT, not for upstream). Drop Host (fetch will set it). Inject
    // the CF gateway auth header. Add a per-user tag so AI Gateway logs
    // attribute the spend.
    const fwdHeaders = new Headers(request.headers);
    fwdHeaders.delete("authorization");
    fwdHeaders.delete("host");
    fwdHeaders.delete("cookie");
    fwdHeaders.set("cf-aig-authorization", `Bearer ${env.CF_AIGW_TOKEN}`);
    fwdHeaders.set("cf-aig-metadata", JSON.stringify({ user: claims.sub }));

    // 4. Forward, streaming both directions.
    const upstreamRes = await fetch(upstream.toString(), {
      method: request.method,
      headers: fwdHeaders,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    });

    // 5. Pass response through. Don't buffer — keep streams streaming.
    const resHeaders = new Headers(upstreamRes.headers);
    for (const [k, v] of Object.entries(corsHeaders())) resHeaders.set(k, v);
    resHeaders.set("x-user", claims.sub);

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: resHeaders,
    });
  },
} satisfies ExportedHandler<Env>;

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
  };
}

function jsonError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}
