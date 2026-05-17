# cf-aigw-exp

**Status:** Phase 3 (per-user API keys + quota in front of AI Gateway) — experimental, not for production use.

A proof-of-concept for routing an internal OpenAI-powered desktop app's
traffic through [Cloudflare AI Gateway][cfaigw] as it transitions from
in-house tool to commercial product. The driving requirement: stop
embedding a fixed OpenAI key in every shipped binary, and centrally
control who can use the service, with what budget, and for which models.

[cfaigw]: https://www.cloudflare.com/products/ai-gateway/

## Why this exists

The original app talks to OpenAI directly (GPT-4o for chat, Whisper for
audio transcription). Once the app ships to external customers, a
single embedded key is no longer viable — it can be extracted, abused,
or starve real users. The decision was to keep the OpenAI relationship
**centralized at the vendor (us)** rather than asking each customer to
bring their own OpenAI account. Cloudflare AI Gateway is the proxy
layer; a Cloudflare Worker in front of it adds per-user auth, quotas,
and model allow-listing.

## Architecture (Phase 3 — implemented)

```
┌──────────────┐   Bearer aigwk_…   ┌──────────────────────┐   cf-aig-auth   ┌──────────────┐   upstream    ┌────────┐
│ desktop app  │ ──────────────────▶│ Cloudflare Worker    │ ───────────────▶│ Cloudflare   │ ─────────────▶│ OpenAI │
│ (per user)   │  per-user API key  │ (this repo)          │  gateway token  │ AI Gateway   │  stored key   └────────┘
└──────────────┘                    │   • auth (KV)        │                 │ (BYOK)       │
                                    │   • model allow-list │                 └──────────────┘
                                    │   • token budget     │
                                    │   • usage tracking   │
                                    └──────────────────────┘
                                              │
                                              └─ /admin/* (x-admin-token) for
                                                 provisioning + revocation
```

Phase 1 (direct probe → AI Gateway) is still supported as a diagnostic
path — set `CF_WORKER_URL` to enable Phase 3 routing, leave it empty
for the direct mode.

## Roadmap

| Phase | Scope                                                                                          | Status                       |
| ----- | ---------------------------------------------------------------------------------------------- | ---------------------------- |
| 1     | Validate the proxy path. Chat, streaming chat, Whisper all work through AI Gateway BYOK.        | done                         |
| 2     | Cloudflare Worker for per-user JWT auth. App carries a per-user token, not the gateway token.   | done (now superseded)        |
| **3** | KV-backed user store, opaque API keys, model allow-list, token budget, revocation, admin CLI.   | ← we are here                |
| 4     | Login flow (signup, password/OAuth), streaming token accounting, Whisper time-based quota,      | not yet                      |
|       | per-org admin separation, billing integration.                                                  |                              |

## Quick start

### Prerequisites

- Node.js ≥ 20
- `wrangler` installed and `wrangler login` run (only needed to deploy)
- A Cloudflare account (Account ID is in `.env.example`)
- An OpenAI key with `gpt-4o-mini` + `whisper-1` access, stored as a
  Provider Key inside your AI Gateway (BYOK setup — see Phase 1 doc)

### 1. Local end-to-end loop

```bash
npm install

# .env: set the direct-mode vars first (CF_AIGW_TOKEN, etc — same as Phase 1)
cp .env.example .env

# .dev.vars: replace the placeholder ADMIN_TOKEN with a real random string.
# The CF_AIGW_TOKEN there is what the Worker uses server-side.

npm run worker:dev          # starts wrangler dev on http://localhost:8787 with local KV

# In another shell:
export CF_WORKER_URL=http://localhost:8787

# Provision a user; the response includes the api_key (shown ONCE).
npm run admin -- create-user --sub alice --models gpt-4o-mini,whisper-1 --budget 50000
# → { user: {...}, api_key: "aigwk_…" }

export USER_API_KEY=aigwk_…          # paste from above

npm run probe:chat                   # runs through the Worker; usage is tracked
npm run probe:stream                 # streaming chat (token usage NOT tracked, see gaps below)
npm run probe:whisper                # Whisper transcription (token usage not tracked — Whisper has no token count)

npm run admin -- get-user --sub alice    # see tokens_used update after each chat
npm run admin -- list-users
npm run admin -- reset-usage --sub alice
npm run admin -- revoke-user --sub alice # subsequent calls return 403 user_revoked
```

### 2. Deploy to Cloudflare

```bash
wrangler login                                              # one-time
wrangler kv namespace create USERS                          # prints an id
# Edit wrangler.toml — replace the placeholder id with the printed one

wrangler secret put CF_AIGW_TOKEN < /dev/tty                # paste your CF gateway token
wrangler secret put ADMIN_TOKEN  < /dev/tty                 # paste a fresh random secret

npm run worker:deploy                                       # prints the Worker URL

# From any host (with ADMIN_TOKEN exported):
export CF_WORKER_URL=https://cf-aigw-exp-worker.<subdomain>.workers.dev
export ADMIN_TOKEN=…
npm run admin -- create-user --sub <user>
```

After deploy, the desktop app needs only:
- The Worker URL (public — not a secret)
- A per-user API key (provisioned via `admin -- create-user`)

It does not need `CF_AIGW_TOKEN`, `OPENAI_API_KEY`, `ADMIN_TOKEN`, or
`CLOUDFLARE_API_TOKEN`.

## Admin endpoints

All require `x-admin-token: <ADMIN_TOKEN>`.

| Method  | Path                              | Body                                          | Notes                                  |
| ------- | --------------------------------- | --------------------------------------------- | -------------------------------------- |
| POST    | `/admin/users`                    | `{ sub, allowed_models?, token_budget? }`     | Returns user + the api_key (shown once)|
| GET     | `/admin/users`                    | —                                             | Lists all users                        |
| GET     | `/admin/users/:sub`               | —                                             | One user                               |
| DELETE  | `/admin/users/:sub`               | —                                             | Marks revoked=true (key invalidated)   |
| POST    | `/admin/users/:sub/reset-usage`   | —                                             | Sets tokens_used=0                     |

Defaults on create: `allowed_models=["gpt-4o-mini","whisper-1"]`,
`token_budget=100000`. An empty `allowed_models` array means
unrestricted; `token_budget=0` means unlimited.

## Direct-to-AI-Gateway (still supported)

Useful for diagnosing whether a problem is in the gateway or in the
Worker. Leave `CF_WORKER_URL` empty; the probes go straight to
AI Gateway with `cf-aig-authorization`:

```bash
unset CF_WORKER_URL
npm run probe:chat
```

Two sub-modes for direct (controlled by `OPENAI_API_KEY` in `.env`):

| Mode             | `OPENAI_API_KEY` | Who holds the OpenAI key | Notes                                                |
| ---------------- | ---------------- | ------------------------ | ---------------------------------------------------- |
| **BYOK**         | *empty*          | Cloudflare (stored key)  | The intended setup.                                  |
| Pass-through     | `sk-...` (real)  | the probe / app          | Fallback when BYOK isn't available, or for debugging |

In Worker mode, the question goes away: the Worker always uses BYOK
against the gateway.

## Layout

```
.
├── README.md
├── CLAUDE.md
├── wrangler.toml                ← Worker config + KV binding
├── tsconfig.json                ← Node side (probes + admin CLI)
├── tsconfig.worker.json         ← Workers runtime side
├── .env.example                 ← probes' env template
├── .dev.vars                    ← local Worker secrets (gitignored)
├── package.json
├── src/
│   ├── config.ts                ← probes' env reader; picks direct/worker
│   ├── client.ts                ← OpenAI client wired to either backend
│   ├── probe-chat.ts
│   ├── probe-stream.ts
│   ├── probe-whisper.ts
│   └── worker/
│       ├── index.ts             ← Worker entrypoint (auth + proxy + usage)
│       ├── admin.ts             ← /admin/* handlers
│       ├── users.ts             ← KV store helpers; opaque api_key model
│       └── env.ts               ← Env bindings (KV + secrets)
├── scripts/
│   └── admin.ts                 ← CLI client for /admin/* endpoints
└── samples/                     ← Whisper audio inputs (gitignored)
```

## Phase 3 known gaps

- **Streaming token accounting.** Streaming chat (`stream: true`)
  passes through unread to keep SSE flowing; tokens for those
  requests are not counted in `tokens_used`. Workaround: require
  `stream_options.include_usage` and parse the final chunk —
  deferred to Phase 4.
- **Whisper quota.** Whisper has no token count, so it doesn't
  consume budget. A real product would count audio seconds (the
  response doesn't carry it; would need to inspect upload size or
  AI Gateway's logs). Deferred.
- **No login flow.** API keys are provisioned by an operator
  running `admin -- create-user`. There is no signup, password,
  OAuth, or token refresh. A real product needs that layer; this
  PoC assumes keys arrive out-of-band (like OpenAI's own model).
- **Admin endpoints share the Worker.** Same Worker serves public
  and admin traffic, gated by `x-admin-token`. Production would
  ideally put admin on a separate Worker with IP/mTLS gating.
- **KV write rate.** Workers KV is rate-limited to ~1 write/sec
  per key. Per-user usage updates use the user's KV entry as the
  write target; very high traffic from one user would lag.
  Production would move counters to Durable Objects.
- **No secret rotation flow.** Rotating `ADMIN_TOKEN` or
  `CF_AIGW_TOKEN` requires `wrangler secret put` and a redeploy.
  Rotating a user's API key requires revoking + creating a new
  user (or extending the admin endpoints — easy follow-up).

## License

Internal PoC — no license declared.
