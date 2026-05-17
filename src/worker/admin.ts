import type { Env } from "./env.js";
import {
  createUser,
  getUserBySub,
  listUsers,
  revokeUser,
  HttpError,
  type UserRecord,
} from "./users.js";
import { getUsage, resetUsageDO, type UsageState } from "./usage.js";

// Admin endpoints. All require `x-admin-token: <ADMIN_TOKEN>`. Routes:
//   POST   /admin/users                  body: { sub, allowed_models?, token_budget? }
//   GET    /admin/users
//   GET    /admin/users/:sub
//   DELETE /admin/users/:sub             marks revoked=true (does not erase)
//   POST   /admin/users/:sub/reset-usage
//
// Responses combine the KV record with live usage from the per-user
// Durable Object so the operator sees a single coherent view.

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

function merge(record: UserRecord, usage: UsageState) {
  return { ...record, ...usage };
}

async function postUsers(request: Request, env: Env): Promise<Response> {
  let body: {
    sub?: string;
    allowed_models?: string[];
    token_budget?: number;
    audio_seconds_budget?: number;
  };
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
    audio_seconds_budget: body.audio_seconds_budget,
  });
  const usage = await getUsage(env, out.user.sub);
  return json(201, { user: merge(out.user, usage), api_key: out.api_key });
}

async function getUsers(env: Env): Promise<Response> {
  const records = await listUsers(env);
  const users = await Promise.all(
    records.map(async (r) => merge(r, await getUsage(env, r.sub))),
  );
  return json(200, { users });
}

async function getOne(env: Env, sub: string): Promise<Response> {
  const record = await getUserBySub(env, sub);
  if (!record) return jsonError(404, "user_not_found");
  const usage = await getUsage(env, sub);
  return json(200, { user: merge(record, usage) });
}

async function revoke(env: Env, sub: string): Promise<Response> {
  const record = await revokeUser(env, sub);
  if (!record) return jsonError(404, "user_not_found");
  const usage = await getUsage(env, sub);
  return json(200, { user: merge(record, usage) });
}

async function reset(env: Env, sub: string): Promise<Response> {
  const record = await getUserBySub(env, sub);
  if (!record) return jsonError(404, "user_not_found");
  const usage = await resetUsageDO(env, sub);
  return json(200, { user: merge(record, usage) });
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
