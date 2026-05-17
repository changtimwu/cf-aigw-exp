import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";

// Per-user usage counter held in a Durable Object. One DO instance per
// `sub`, keyed via `env.USAGE.idFromName(sub)`. Atomic — no rate limit.
//
// Storage layout (per DO):
//   tokens_used:        number  (REST chat tokens, sum)
//   audio_seconds_used: number  (realtime audio time, sum) — Phase 5b
//   last_request_at:    number  (seconds since epoch)

export type UsageState = {
  tokens_used: number;
  audio_seconds_used: number;
  last_request_at: number;
};

export class UsageCounter extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const state = this.ctx;
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/increment": {
        if (request.method !== "POST") return json(405, { error: "method" });
        const body = (await request.json()) as { tokens?: number };
        const tokens = typeof body.tokens === "number" ? body.tokens : 0;
        const cur = await readState(state);
        const next: UsageState = {
          ...cur,
          tokens_used: cur.tokens_used + tokens,
          last_request_at: Math.floor(Date.now() / 1000),
        };
        await state.storage.put(next);
        return json(200, next);
      }
      case "/increment-audio": {
        if (request.method !== "POST") return json(405, { error: "method" });
        const body = (await request.json()) as { seconds?: number };
        const seconds = typeof body.seconds === "number" ? body.seconds : 0;
        const cur = await readState(state);
        const next: UsageState = {
          ...cur,
          audio_seconds_used: cur.audio_seconds_used + seconds,
          last_request_at: Math.floor(Date.now() / 1000),
        };
        await state.storage.put(next);
        return json(200, next);
      }
      case "/get": {
        if (request.method !== "GET") return json(405, { error: "method" });
        return json(200, await readState(state));
      }
      case "/reset": {
        if (request.method !== "POST") return json(405, { error: "method" });
        await state.storage.deleteAll();
        return json(200, {
          tokens_used: 0,
          audio_seconds_used: 0,
          last_request_at: 0,
        } satisfies UsageState);
      }
      default:
        return json(404, { error: "not_found" });
    }
  }
}

async function readState(state: DurableObjectState): Promise<UsageState> {
  return {
    tokens_used: (await state.storage.get<number>("tokens_used")) ?? 0,
    audio_seconds_used: (await state.storage.get<number>("audio_seconds_used")) ?? 0,
    last_request_at: (await state.storage.get<number>("last_request_at")) ?? 0,
  };
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

export async function incrementAudioDO(
  env: Env,
  sub: string,
  seconds: number,
): Promise<UsageState> {
  if (seconds <= 0) return getUsage(env, sub);
  const res = await stub(env, sub).fetch("https://do/increment-audio", {
    method: "POST",
    body: JSON.stringify({ seconds }),
    headers: { "content-type": "application/json" },
  });
  return (await res.json()) as UsageState;
}

export async function resetUsageDO(env: Env, sub: string): Promise<UsageState> {
  const res = await stub(env, sub).fetch("https://do/reset", { method: "POST" });
  return (await res.json()) as UsageState;
}
