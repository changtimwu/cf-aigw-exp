# CLAUDE.md

Guidance for Claude when working in this repo. The user-facing
overview lives in [README.md](README.md); this file captures the
decisions and conventions a future Claude session won't pick up
from the code alone.

## What this repo is

A small TypeScript proof-of-concept that proxies an OpenAI-using
desktop app's traffic through **Cloudflare AI Gateway**, with a
**Cloudflare Worker** in front of the gateway that does per-user
auth (KV-backed opaque API keys), model allow-listing, and token
budget enforcement. Exists because the app is being productized —
a fixed OpenAI key can no longer be embedded in distributed
binaries, and per-user controls are needed.

The repo currently implements **Phases 1, 2 (history), 3**:
- Phase 1: three probes that exercise AI Gateway directly with BYOK.
- Phase 2 (in git history, superseded): a Worker validating per-user
  HS256 JWTs. The KV-less version. Removed in Phase 3 because the
  opaque-API-key + KV-user-store pattern matches the desktop-app
  use case better. If you need to reintroduce JWTs (e.g. for a
  browser-based client with an external auth backend), git history
  has the working code.
- Phase 3: Worker with KV-backed user store, opaque API keys, model
  allow-list, token budget, revocation, admin endpoints + CLI.

Phase 4 (real login flow, streaming token accounting, Whisper
time-based quota) is intentionally out of scope.

## Architecture decisions (don't relitigate without asking)

- **BYOK interpretation is option B (vendor-held key), not option A
  (end-user-supplied key).** The company holds one OpenAI key
  centrally in Cloudflare; end users never paste an OpenAI key into
  the desktop app. Suggestions that route around this were ruled
  out at kickoff.
- **AI Gateway sits in front of OpenAI; the Worker sits in front of
  AI Gateway.** The OpenAI SDK on the client is kept as-is with a
  `baseURL` override.
- **Phase boundaries are deliberate.** Don't bolt a real login
  flow or streaming token accounting into Phase 3.
- **Authenticated Gateway is always on.** Every request from the
  Worker to AI Gateway carries `cf-aig-authorization`.
- **Auth is opaque API keys, not JWTs.** Long-lived, server-issued,
  revocable from KV without rotating any global secret. Matches the
  OpenAI/Stripe pattern users already know. Don't reintroduce JWTs
  for the primary auth path unless the requirements change.

## File map and conventions

- `src/worker/users.ts` — KV store helpers. The single source of
  truth for the user record shape (`User` type) and the KV layout:
    - `apikey:<sha256-hex>` → User JSON (hot-path auth lookup)
    - `sub:<sub>` → `<sha256-hex>` (admin lookup by username)
  Hash uses Web Crypto SHA-256 only — runtime-agnostic. API keys
  are `aigwk_` + 48 hex chars (24 random bytes). The plaintext key
  is shown only at creation time; subsequent reads return the hash.
- `src/worker/admin.ts` — `/admin/*` request handler. Reads
  `x-admin-token` header, dispatches to `users.ts`.
- `src/worker/index.ts` — main fetch handler. Order of operations
  matters and is load-bearing:
    1. `/admin/*` short-circuits to admin handler.
    2. Validate `Authorization: Bearer <api_key>`.
    3. Look up user; reject if missing / revoked / over budget.
    4. If chat completions: parse JSON body once, enforce
       `allowed_models`, then forward the buffered body.
    5. For other endpoints (Whisper multipart, etc.), stream the
       body through without parsing.
    6. Forward to AI Gateway with `cf-aig-authorization`, no
       `Authorization`.
    7. For non-streaming chat JSON responses: read body, extract
       `usage.total_tokens`, `ctx.waitUntil(incrementUsage(...))`,
       return the original body verbatim.
    8. For streaming or non-JSON: pass through, no usage tracking.
  Don't refactor this into "always read the response body" — that
  breaks SSE.
- `src/config.ts`, `src/client.ts`, `src/probe-*.ts` — probes are
  mode-agnostic; `CF_WORKER_URL` switches between direct AI Gateway
  and Worker. The probes' `USER_API_KEY` env var becomes the
  `Authorization` bearer token in worker mode.
- `scripts/admin.ts` — Node CLI that talks to the Worker's
  `/admin/*` endpoints with `x-admin-token`. Reads `.dev.vars` for
  local convenience.
- `wrangler.toml` — declares the `USERS` KV namespace. Local
  `wrangler dev` ignores the `id` value, but **before deploy you
  must** run `wrangler kv namespace create USERS` and substitute
  the printed id.
- `.dev.vars` — gitignored. Local-only Worker secrets.

ES modules, strict TypeScript, no test framework yet. If tests get
added later, prefer `node --test` over a dependency.

## Non-obvious gotchas — preserve these

### 1. BYOK requires no `Authorization` header

CF AI Gateway's Stored Keys feature substitutes the upstream
provider key only when the client sends **no** `Authorization`
header. If `Authorization` is present, the gateway forwards its
value verbatim and never touches the stored key.

In the Worker (`src/worker/index.ts`), the incoming `authorization`
header (the user's API key) is **deleted** before forwarding to
the gateway. Don't change that.

In direct mode (`src/client.ts`), the OpenAI SDK's auto-generated
`Authorization` header is stripped by passing
`Authorization: null` in `defaultHeaders` — the SDK's
`applyHeadersMut` (`node_modules/openai/core.js` ~line 848) treats
`null` as "delete this header." The CF gateway auth header
(`cf-aig-authorization`) is always sent regardless.

### 2. wrangler runtime lags the calendar

`compatibility_date` in `wrangler.toml` must be a date the installed
wrangler runtime supports. If you bump it ahead of the runtime's
build date you get `"This Worker requires compatibility date X,
but the newest date supported by this server binary is Y"`. Fix
is to either upgrade wrangler or set a date the local binary
actually knows. Currently pinned to `2026-04-28`.

### 3. KV id field is required even for local dev

`wrangler dev` rejects a `kv_namespaces` entry without an `id`, but
ignores the *value* for local — any non-empty placeholder works.
The placeholder must be replaced with a real namespace id before
`wrangler deploy`. See README for the create-namespace command.

### 4. Usage tracking only covers non-streaming chat

The Worker can only parse `usage.total_tokens` from buffered
JSON responses. Streaming responses (SSE) are passed through
unread; Whisper has no token field. This is intentional in
Phase 3 — fixing it requires either teeing the SSE stream and
parsing the `[DONE]`-preceding chunk (with
`stream_options.include_usage`), or relying on AI Gateway's own
logging API. Both are Phase 4 work.

## Environment quirks

- The working directory exists at two paths that **share the same
  inode** (`/ssd/devhome/work/github/cf-aigw-exp` and
  `/home/timwu/work/github/cf-aigw-exp`). Prefer the `/ssd/...` path.
- `CLOUDFLARE_API_TOKEN` in `.env` is reused as `CF_AIGW_TOKEN`
  (the runtime gateway-auth header). That's PoC-only; a production
  deployment should give the gateway-auth role only `AI Gateway:
  Run` and store it via `wrangler secret put CF_AIGW_TOKEN`.
- `wrangler` and `cloudflared` are installed locally. `wrangler dev`
  works without `wrangler login` so long as secrets are in
  `.dev.vars`; deploy needs login.
- `.dev.vars` carries both `CF_AIGW_TOKEN` and `ADMIN_TOKEN`. The
  admin CLI reads `ADMIN_TOKEN` from there too, which is convenient
  locally but means whoever can read the repo on this host has
  admin access. In production the operator runs `admin` from a
  shell where `ADMIN_TOKEN` is exported, not from a checked-out
  `.dev.vars`.

## Working style for this user

- Comfortable with CLI tooling. Wants Claude to make reasonable
  calls and proceed without clarifying questions for every step.
- Prefers concrete next-steps over open-ended prompts. When
  proposing a multi-phase plan, give Phase N concretely and just
  outline Phase N+1.
- Terse responses. Code-level detail in code; narrative in
  README/CLAUDE.md, not in chat output.
