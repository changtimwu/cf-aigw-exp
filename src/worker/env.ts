import type { UsageCounter } from "./usage.js";

export interface Env {
  // Plain vars (set in wrangler.toml [vars] or .dev.vars).
  CF_ACCOUNT_ID: string;
  CF_AIGW_ID: string;

  // Secrets (set via `wrangler secret put` for prod, .dev.vars for local).
  CF_AIGW_TOKEN: string;
  ADMIN_TOKEN: string;

  // KV namespace holding per-user identity + config.
  // Layout:
  //   apikey:<sha256-hex>  → UserRecord JSON  (hot path; auth lookup)
  //   sub:<sub>            → <sha256-hex>     (admin lookup by username)
  USERS: KVNamespace;

  // Durable Object: per-user usage counter, atomic. See src/worker/usage.ts.
  USAGE: DurableObjectNamespace<UsageCounter>;
}
