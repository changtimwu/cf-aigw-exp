# CLAUDE.md

Guidance for Claude when working in this repo. The user-facing
overview lives in [README.md](README.md); capacity ceilings live in
[SCALING.md](SCALING.md). This file captures the decisions and
conventions a future Claude session won't pick up from the code alone.

## What this repo is

A TypeScript proof-of-concept that proxies an OpenAI-using desktop
app's traffic through **Cloudflare AI Gateway**, with a
**Cloudflare Worker** in front that does per-user auth (KV-backed
opaque API keys), model allow-listing, token budget enforcement,
and atomic per-user usage counting in **Durable Objects** —
including streaming chat. Exists because the app is being
productized.

The repo implements **Phases 1, 2 (history), 3, 4**:
- Phase 1: probes against AI Gateway with BYOK.
- Phase 2 (superseded, in git history): Worker validating per-user
  HS256 JWTs. The KV-less version. Replaced because opaque API keys
  + KV match the desktop-app use case better.
- Phase 3: Worker with KV-backed users, opaque API keys, model
  allow-list, token budget, revocation, admin endpoints. Counters
  lived in KV — limited to ~1 write/sec per user.
- Phase 4: per-user counters move to a Durable Object (atomic, no
  rate limit). Streaming chat token accounting added via SSE tee.

Phase 5 (real login flow, Whisper time-based quota, per-org admin,
billing) is intentionally out of scope.

## Architecture decisions (don't relitigate without asking)

- **BYOK interpretation is option B (vendor-held key), not option A.**
  Company holds one OpenAI key centrally in CF; end users never paste
  one into the app.
- **AI Gateway sits in front of OpenAI; the Worker sits in front of
  AI Gateway.** The OpenAI SDK on the client is kept as-is with a
  `baseURL` override.
- **Phase boundaries are deliberate.** Don't bolt a real login flow
  into Phase 4.
- **Authenticated Gateway is always on.** Every request from the
  Worker to AI Gateway carries `cf-aig-authorization`.
- **Auth is opaque API keys, not JWTs.** Long-lived, server-issued,
  revocable from KV. Don't reintroduce JWTs as the primary auth path.
- **KV is for static identity + config. Durable Objects are for live
  counters.** Don't move counters back into the KV record — that
  reintroduces the 1 write/sec/key cap (see SCALING.md).
- **Streaming chat must be counted.** Don't refactor the SSE tee
  out of `src/worker/index.ts` without replacing it with another
  mechanism (e.g. AI Gateway logs reconciliation).

## File map and conventions

- `src/worker/users.ts` — KV-only. `UserRecord` is identity + config
  (no counters). KV layout:
    - `apikey:<sha256-hex>` → UserRecord JSON
    - `sub:<sub>` → `<sha256-hex>`
  API keys are `aigwk_` + 48 hex chars (24 random bytes). Plaintext
  shown only at creation; storage holds the hash.
- `src/worker/usage.ts` — `UsageCounter` (Durable Object class,
  extends `DurableObject` from `cloudflare:workers`) + helpers
  `getUsage` / `incrementUsageDO` / `resetUsageDO`. The DO accepts
  fetch requests at `/get`, `/increment`, `/reset`. One DO per
  `sub`, addressed by `env.USAGE.idFromName(sub)`.
- `src/worker/admin.ts` — `/admin/*` handler. Reads
  `x-admin-token`. Merges UserRecord (KV) with UsageState (DO) on
  every response.
- `src/worker/index.ts` — main fetch handler. Order of operations
  matters and is load-bearing:
    1. `/admin/*` short-circuits to admin handler.
    2. Validate `Authorization: Bearer <api_key>`.
    3. Look up UserRecord in KV; reject if missing/revoked.
    4. Read UsageState from DO; reject if budget exceeded.
    5. If chat completions: parse JSON body, enforce
       `allowed_models`, **inject `stream_options.include_usage`**
       when stream=true, re-serialize.
    6. For other endpoints, stream `request.body` through unread.
    7. Forward to AI Gateway with `cf-aig-authorization`, no
       `Authorization`.
    8. If non-streaming JSON chat response: read body, extract
       `usage.total_tokens`, `ctx.waitUntil(incrementUsageDO(...))`,
       return original body.
    9. If streaming chat: `body.tee()`; one branch streams to
       client; the other parses SSE in `ctx.waitUntil` and calls
       `incrementUsageDO` when the usage chunk is seen.
    10. Otherwise (Whisper, etc): pass through, no usage tracking.
  Don't refactor "always read response body" — breaks SSE.
- `src/config.ts`, `src/client.ts`, `src/probe-*.ts` — probes are
  mode-agnostic. `CF_WORKER_URL` switches between direct AI Gateway
  and the Worker. `USER_API_KEY` becomes the `Authorization` bearer
  token in worker mode.
- `scripts/admin.ts` — Node CLI talking to `/admin/*`. Reads
  `.dev.vars` for local convenience.
- `wrangler.toml` — declares `USERS` KV namespace, `USAGE` DO
  binding, and a `[[migrations]]` entry for `UsageCounter`. Before
  `wrangler deploy`, run `wrangler kv namespace create USERS` and
  substitute the printed id.
- `.dev.vars` — gitignored. Local-only Worker secrets.

ES modules, strict TypeScript, no test framework yet. If tests get
added later, prefer `node --test` over a dependency.

## Non-obvious gotchas — preserve these

### 1. BYOK requires no `Authorization` header

CF AI Gateway's Stored Keys feature substitutes the upstream
provider key only when the client sends **no** `Authorization`
header. In the Worker (`src/worker/index.ts`), the incoming
`authorization` header (the user's API key) is **deleted** before
forwarding. Don't change that. Also strip `content-length` for chat
because we rewrote the body — let fetch recalculate.

In direct mode (`src/client.ts`), the OpenAI SDK's auto-generated
`Authorization` header is suppressed by `Authorization: null` in
`defaultHeaders` — the SDK's `applyHeadersMut` treats null as
"delete this header." `cf-aig-authorization` is always sent.

### 2. wrangler runtime lags the calendar

`compatibility_date` must be a date the installed wrangler runtime
supports. Currently pinned to `2026-04-28`.

### 3. KV id is required even for local dev

`wrangler dev` rejects a `kv_namespaces` entry without an `id`, but
ignores the value for local — any non-empty placeholder works. Must
be replaced before `wrangler deploy`.

### 4. Durable Objects require Workers Paid + a migration entry

The `[[migrations]]` block in `wrangler.toml` is what tells
`wrangler deploy` to create the DO class. Without it, deploy fails.
DO is not on the Free plan; running `wrangler deploy` without the
paid plan will return an error.

### 5. Streaming usage tracking depends on injection

OpenAI streams `usage` only when the request opted in via
`stream_options: { include_usage: true }`. The Worker injects this
unconditionally for streaming chat (see `src/worker/index.ts`).
Don't strip the injection. If the SDK ever sends its own
`stream_options`, the Worker preserves them and just adds
`include_usage`.

### 6. Use `DurableObject` from `cloudflare:workers`, not a class shim

The `UsageCounter` class extends `DurableObject<Env>` imported from
`cloudflare:workers`. The older "plain class with state property"
form fails the `@cloudflare/workers-types` `DurableObjectBranded`
constraint. Don't downgrade to a plain class.

### 7. SSE parsing is best-effort

`parseSseUsage` in `src/worker/index.ts` reads the tee'd response
branch and looks for a `data: { ... usage: { ... } }` chunk before
`data: [DONE]`. If the upstream sends malformed chunks or the parse
crashes, we drop usage for that request silently. Don't throw out
of there — it shouldn't fail the user-facing response. Phase 5 can
reconcile from AI Gateway logs.

## Environment quirks

- Working directory exists at two paths sharing the same inode
  (`/ssd/devhome/work/github/cf-aigw-exp` and
  `/home/timwu/work/github/cf-aigw-exp`). Prefer `/ssd/...`.
- `CLOUDFLARE_API_TOKEN` in `.env` is reused as `CF_AIGW_TOKEN`
  (the runtime gateway-auth header). PoC-only — production should
  narrow it to `AI Gateway: Run` and store via
  `wrangler secret put CF_AIGW_TOKEN`.
- `.dev.vars` carries `CF_AIGW_TOKEN` and `ADMIN_TOKEN`. The admin
  CLI reads `ADMIN_TOKEN` from there — convenient locally, but
  whoever can read the repo on this host has admin access. In
  production the operator runs `admin` from a shell with
  `ADMIN_TOKEN` exported, not from `.dev.vars`.
- `wrangler` and `cloudflared` are installed locally. `wrangler dev`
  works without `wrangler login`; deploy needs login.
- Wiping `.wrangler/` clears local KV + DO state. Useful when
  schema changes (e.g. the Phase 3 → Phase 4 User record shift).

## Working style for this user

- Comfortable with CLI tooling. Wants Claude to make reasonable
  calls and proceed without clarifying questions for every step.
- Prefers concrete next-steps over open-ended prompts. When
  proposing a multi-phase plan, give Phase N concretely and just
  outline Phase N+1.
- Terse responses. Code-level detail in code; narrative in
  README/CLAUDE.md/SCALING.md, not in chat output.
