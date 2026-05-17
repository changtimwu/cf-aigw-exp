import type { Env } from "./env.js";
import {
  createUser,
  getUserBySub,
  listUsers,
  resetUsage,
  revokeUser,
  HttpError,
} from "./users.js";

// Admin endpoints. All require `x-admin-token: <ADMIN_TOKEN>`. Routes:
//   POST   /admin/users                  body: { sub, allowed_models?, token_budget? }
//   GET    /admin/users
//   GET    /admin/users/:sub
//   DELETE /admin/users/:sub             marks revoked=true (does not erase)
//   POST   /admin/users/:sub/reset-usage
//
// The admin surface lives on the same Worker as the public API; in
// production these would ideally be on a separate Worker with IP/mTLS
// gating. Noted as a Phase-3 gap.
export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const supplied = request.headers.get("x-admin-token");
  if (!supplied || supplied !== env.ADMIN_TOKEN) {
    return jsonError(401, "admin_unauthorized");
  }

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["admin", "users", ...]
  if (parts[0] !== "admin" || parts[1] !== "users") {
    return jsonError(404, "not_found");
  }

  try {
    if (parts.length === 2) {
      if (request.method === "POST") return await postUsers(request, env);
      if (request.method === "GET") return await getUsers(env);
      return jsonError(405, "method_not_allowed");
    }
    const sub = parts[2];
    if (parts.length === 3) {
      if (request.method === "GET") return await getOne(env, sub!);
      if (request.method === "DELETE") return await revoke(env, sub!);
      return jsonError(405, "method_not_allowed");
    }
    if (parts.length === 4 && parts[3] === "reset-usage" && request.method === "POST") {
      return await reset(env, sub!);
    }
    return jsonError(404, "not_found");
  } catch (err) {
    if (err instanceof HttpError) return jsonError(err.status, err.code);
    return jsonError(500, "internal_error");
  }
}

async function postUsers(request: Request, env: Env): Promise<Response> {
  let body: { sub?: string; allowed_models?: string[]; token_budget?: number };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_json");
  }
  if (typeof body.sub !== "string" || body.sub.length === 0) {
    return jsonError(400, "missing_sub");
  }
  const out = await createUser(env, {
    sub: body.sub,
    allowed_models: body.allowed_models,
    token_budget: body.token_budget,
  });
  return json(201, out);
}

async function getUsers(env: Env): Promise<Response> {
  const users = await listUsers(env);
  return json(200, { users });
}

async function getOne(env: Env, sub: string): Promise<Response> {
  const user = await getUserBySub(env, sub);
  if (!user) return jsonError(404, "user_not_found");
  return json(200, { user });
}

async function revoke(env: Env, sub: string): Promise<Response> {
  const user = await revokeUser(env, sub);
  if (!user) return jsonError(404, "user_not_found");
  return json(200, { user });
}

async function reset(env: Env, sub: string): Promise<Response> {
  const user = await resetUsage(env, sub);
  if (!user) return jsonError(404, "user_not_found");
  return json(200, { user });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(status: number, code: string): Response {
  return json(status, { error: { code } });
}
