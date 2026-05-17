import type { UsageCounter } from "./usage.js";

export interface Env {
  // Plain vars (set in wrangler.toml [vars] or .dev.vars).
  CF_ACCOUNT_ID: string;
  CF_AIGW_ID: string;

  // Secrets (set via `wrangler secret put` for prod, .dev.vars for local).
  CF_AIGW_TOKEN: string;
  ADMIN_TOKEN: string;
  // Phase 5a: real OpenAI key, used only for realtime WS upstream because
  // CF AI Gateway's WebSocket proxy doesn't currently route the GA Realtime
  // shape. See REALTIME_BYPASS.md. Same value as the AI Gateway's stored
  // OpenAI key; rotate both together. REST traffic continues through the
  // gateway and never reads this value.
  OPENAI_API_KEY: string;

  // KV namespace holding per-user identity + config.
  USERS: KVNamespace;

  // Durable Object: per-user atomic usage counter. See src/worker/usage.ts.
  USAGE: DurableObjectNamespace<UsageCounter>;
}
