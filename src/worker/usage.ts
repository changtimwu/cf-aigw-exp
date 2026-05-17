import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";

// Per-user usage counter held in a Durable Object. One DO instance per
// `sub`, keyed via `env.USAGE.idFromName(sub)`. The DO model serialises
// reads/writes to one instance — no rate limit, atomic.
//
// Storage layout (per DO):
//   tokens_used:     number
//   last_request_at: number  (seconds since epoch)

export type UsageState = {
  tokens_used: number;
  last_request_at: number;
};

export class UsageCounter extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    // Alias to keep the helper bodies untouched after the base-class refactor.
    const state = this.ctx;
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/increment": {
        if (request.method !== "POST") return json(405, { error: "method" });
        const body = (await request.json()) as { tokens?: number };
        const tokens = typeof body.tokens === "number" ? body.tokens : 0;
        const prev = (await state.storage.get<number>("tokens_used")) ?? 0;
        const next: UsageState = {
          tokens_used: prev + tokens,
          last_request_at: Math.floor(Date.now() / 1000),
        };
        await state.storage.put(next);
        return json(200, next);
      }
      case "/get": {
        if (request.method !== "GET") return json(405, { error: "method" });
        const tokens_used = (await state.storage.get<number>("tokens_used")) ?? 0;
        const last_request_at = (await state.storage.get<number>("last_request_at")) ?? 0;
        return json(200, { tokens_used, last_request_at });
      }
      case "/reset": {
        if (request.method !== "POST") return json(405, { error: "method" });
        await state.storage.deleteAll();
        return json(200, { tokens_used: 0, last_request_at: 0 });
      }
      default:
        return json(404, { error: "not_found" });
    }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// --- helpers used from the main Worker handler ---

function stub(env: Env, sub: string): DurableObjectStub {
  const id = env.USAGE.idFromName(sub);
  return env.USAGE.get(id);
}

export async function getUsage(env: Env, sub: string): Promise<UsageState> {
  const res = await stub(env, sub).fetch("https://do/get");
  return (await res.json()) as UsageState;
}

export async function incrementUsageDO(
  env: Env,
  sub: string,
  tokens: number,
): Promise<UsageState> {
  if (tokens <= 0) return getUsage(env, sub);
  const res = await stub(env, sub).fetch("https://do/increment", {
    method: "POST",
    body: JSON.stringify({ tokens }),
    headers: { "content-type": "application/json" },
  });
  return (await res.json()) as UsageState;
}

export async function resetUsageDO(env: Env, sub: string): Promise<UsageState> {
  const res = await stub(env, sub).fetch("https://do/reset", { method: "POST" });
  return (await res.json()) as UsageState;
}
