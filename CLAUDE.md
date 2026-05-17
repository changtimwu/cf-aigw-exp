# CLAUDE.md

Guidance for Claude when working in this repo. The user-facing
overview lives in [README.md](README.md); this file captures the
decisions and conventions a future Claude session won't pick up
from the code alone.

## What this repo is

A small TypeScript proof-of-concept that proxies an OpenAI-using
desktop app's traffic through **Cloudflare AI Gateway**, with a
**Cloudflare Worker** in front of the gateway for per-user auth.
It exists because the app is being productized — a fixed OpenAI
key can no longer be embedded in distributed binaries.

The repo currently implements **Phases 1 and 2**:
- Phase 1: three probes (`probe-chat`, `probe-stream`,
  `probe-whisper`) that exercise the gateway directly with BYOK.
- Phase 2: a Cloudflare Worker that validates per-user HS256 JWTs
  and forwards to the gateway, plus a JWT minting CLI.

Phase 3 (real user accounts, persistent revocation, per-user
quotas) is intentionally out of scope.

## Architecture decisions (don't relitigate without asking)

- **BYOK interpretation is option B (vendor-held key), not option A
  (end-user-supplied key).** The company holds one OpenAI key
  centrally in Cloudflare; end users never paste an OpenAI key into
  the desktop app. Suggestions that route around this — e.g.
  "let the user bring their own key" UI flows — were explicitly
  ruled out at project kickoff.
- **AI Gateway sits in front of OpenAI; the Worker sits in front of
  AI Gateway.** The OpenAI SDK on the client is kept as-is with a
  `baseURL` override — this minimises rewrite of the existing
  desktop app code.
- **Phase boundaries are deliberate.** Don't bolt a persistent
  user store or per-user quotas into Phase 2 just because it's
  "obviously needed". That's Phase 3's whole point.
- **Authenticated Gateway is always on.** Every request from the
  Worker to AI Gateway carries `cf-aig-authorization`. Code that
  bypasses this header is wrong.

## File map and conventions

- `src/jwt.ts` — HS256 sign/verify using **only Web Crypto**, so the
  same source runs in both Workers runtime and Node 20+ runtime
  (used by the CLI). Do **not** introduce a Node-specific crypto
  call here; it would break the Worker build.
- `src/config.ts` — single source of env reading for the probes.
  New env vars go here, never read directly from `process.env` in
  probe files.
- `src/client.ts` — single `OpenAI` client. Picks one of three
  configurations based on env:
    1. Worker mode (`CF_WORKER_URL` set): user JWT as `apiKey`,
       no `cf-aig-authorization` from client.
    2. Direct BYOK (`CF_WORKER_URL` empty, `OPENAI_API_KEY` empty):
       `Authorization` header stripped, `cf-aig-authorization` set.
    3. Direct pass-through (`CF_WORKER_URL` empty,
       `OPENAI_API_KEY` set): real OpenAI key forwarded.
- `src/probe-*.ts` — `tsx` entrypoints, mode-agnostic. They print
  "Backend: …" and "Mode: …" so it's obvious which path is being
  exercised. New probes follow the same shape and register in
  `package.json` as `probe:<name>`.
- `src/worker/` — Worker source, isolated under its own tsconfig
  (`tsconfig.worker.json`) so Node and Workers types don't fight.
  When adding a new shared module (used by both Worker and Node),
  add it to `tsconfig.worker.json`'s `include` list explicitly.
- `scripts/issue-token.ts` — Node CLI that signs JWTs using the
  same `JWT_SECRET` the Worker verifies with. Reads `.dev.vars` for
  local convenience. In a real product this lives wherever the
  user-account system runs, not in this repo.
- `samples/` — Whisper audio inputs. Gitignored except `.gitkeep`.
- `.env` — gitignored. `.env.example` is the template.
- `.dev.vars` — gitignored. Local Worker secrets only; production
  secrets go via `wrangler secret put`.

ES modules, strict TypeScript, no test framework yet. If tests get
added later, prefer `node --test` over a dependency.

## Two non-obvious gotchas — preserve these

### 1. BYOK requires no `Authorization` header

CF AI Gateway's Stored Keys feature substitutes the upstream
provider key only when the client sends **no** `Authorization`
header. If `Authorization` is present, the gateway forwards its
value verbatim and never touches the stored key.

The OpenAI SDK unconditionally sets `Authorization: Bearer <apiKey>`,
so in BYOK mode `src/client.ts` passes `Authorization: null` in
`defaultHeaders` — the SDK's `applyHeadersMut`
(`node_modules/openai/core.js` ~line 848) treats `null` as
"delete this header." The CF gateway auth header
(`cf-aig-authorization`) is always sent regardless.

This applies to the Worker too: `src/worker/index.ts` deletes the
incoming `authorization` header (which was the user JWT) before
forwarding to the gateway. Don't change that.

### 2. wrangler runtime lags the calendar

`compatibility_date` in `wrangler.toml` must be a date the installed
wrangler runtime supports. If you bump it ahead of the runtime's
build date you get `"This Worker requires compatibility date X, but
the newest date supported by this server binary is Y"`. Fix is to
either upgrade wrangler or set a date the local binary actually
knows.

## Environment quirks

- The working directory exists at two paths that **share the same
  inode** (`/ssd/devhome/work/github/cf-aigw-exp` and
  `/home/timwu/work/github/cf-aigw-exp`). Prefer the `/ssd/...` path.
- `CLOUDFLARE_API_TOKEN` in `.env` carries AI Gateway scopes —
  enough to list gateways and (likely) modify them. It is currently
  also reused as `CF_AIGW_TOKEN` (the runtime gateway auth). That's
  PoC-only; a production deployment should give the gateway-auth
  role only `AI Gateway: Run`, which is what the Phase 2 Worker
  would consume from `wrangler secret put CF_AIGW_TOKEN`.
- `wrangler` and `cloudflared` are installed locally. `wrangler dev`
  works without `wrangler login` so long as secrets are in
  `.dev.vars`; deploy needs login.

## Working style for this user

- Comfortable with CLI tooling, wants Claude to make reasonable
  calls and proceed without asking clarifying questions for every
  step.
- Prefer pasting concrete next-steps over open-ended prompts. When
  proposing a multi-phase plan, give Phase N concretely and just
  outline Phase N+1.
- Terse responses. Code-level detail in code; narrative in
  README/CLAUDE.md, not in chat output.
