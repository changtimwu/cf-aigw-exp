# cf-aigw-exp

**Status:** Phase 2 (Worker auth in front of AI Gateway) — experimental, not for production use.

A proof-of-concept for routing an internal OpenAI-powered desktop app's
traffic through [Cloudflare AI Gateway][cfaigw] as it transitions from
in-house tool to commercial product. The driving requirement: stop
embedding a fixed OpenAI key in every shipped binary, and let one
central server hold the OpenAI key for all users.

[cfaigw]: https://www.cloudflare.com/products/ai-gateway/

## Why this exists

The original app talks to OpenAI directly (GPT-4o for chat, Whisper for
audio transcription). Once the app ships to external customers, a
single embedded key is no longer viable — it can be extracted, abused,
or starve real users. The decision was to keep the OpenAI relationship
**centralized at the vendor (us)** rather than asking each customer to
bring their own OpenAI account. Cloudflare AI Gateway is the proxy
layer; a thin Cloudflare Worker in front of it adds per-user auth.

## Architecture (Phase 2 — implemented)

```
┌──────────────┐    Bearer JWT     ┌─────────────────┐    cf-aig-auth    ┌──────────────┐    upstream    ┌────────┐
│ desktop app  │ ────────────────▶ │ Cloudflare      │ ────────────────▶ │ Cloudflare   │ ─────────────▶ │ OpenAI │
│ (per user)   │  (HS256, user_id) │ Worker          │   gateway token   │ AI Gateway   │  stored key    └────────┘
└──────────────┘                   │ (this repo)     │                   │ (BYOK)       │
                                   └─────────────────┘                   └──────────────┘
                                       │   ▲
                                       │   └─ holds gateway token (Worker secret)
                                       └────  validates HS256 JWT (Worker secret)
```

Phase 1 (direct probe → AI Gateway) is still supported by the same
probes — set `CF_WORKER_URL` to enable Phase 2 routing, leave it
empty for Phase 1.

## Roadmap

| Phase | Scope                                                                                          | This repo                    |
| ----- | ---------------------------------------------------------------------------------------------- | ---------------------------- |
| 1     | Validate the proxy path. Chat, streaming chat, Whisper all work through AI Gateway BYOK.        | done                         |
| **2** | Cloudflare Worker for per-user JWT auth. App carries a per-user token, not the gateway token.   | ← we are here                |
| 3     | Real user accounts (D1 / KV), login flow, per-user usage analytics, quota enforcement, model    | not yet                      |
|       | allow-listing, key revocation.                                                                 |                              |

## Quick start

### Prerequisites

- Node.js ≥ 20
- `wrangler` installed (`npm i -g wrangler` or via your package manager)
- A Cloudflare account (Account ID is filled into `.env.example`)
- An OpenAI key with `gpt-4o-mini` + `whisper-1` access

### 1. One-time AI Gateway setup (dashboard)

Same as Phase 1 — see [Phase 1 quick-start](#phase-1-direct-to-ai-gateway-still-supported).

Create gateway `aigw-exp-poc`, enable Authenticated Gateway, store
your OpenAI key in Provider Keys (BYOK).

### 2. Phase 2: run the Worker locally

```bash
npm install
cp .env.example .env             # fill in CF_AIGW_TOKEN etc as in Phase 1
# Edit .dev.vars and replace JWT_SECRET with a real random string
npm run worker:dev               # starts wrangler dev on http://localhost:8787

# In another shell:
export CF_WORKER_URL=http://localhost:8787
export USER_JWT=$(npm run --silent issue:token -- --sub alice --ttl 24h)
npm run probe:chat
npm run probe:stream
npm run probe:whisper
```

When `CF_WORKER_URL` is set, the probes use it as the OpenAI
`baseURL` and send `Authorization: Bearer $USER_JWT`. The Worker
validates the JWT, strips that header, attaches
`cf-aig-authorization` from its own secret, and forwards to AI
Gateway. The desktop client never sees the gateway token or the
OpenAI key.

### Deploy to Cloudflare (optional)

```bash
wrangler login                                # one-time
wrangler secret put CF_AIGW_TOKEN < /dev/tty  # paste your CF_AIGW_TOKEN
wrangler secret put JWT_SECRET < /dev/tty     # paste a fresh random secret
npm run worker:deploy
# wrangler will print the public Worker URL — use that as CF_WORKER_URL
```

After deploy, your desktop app needs only:
- The Worker URL (public — no secret)
- A per-user JWT (issued by your auth system after login)

It no longer needs `CF_AIGW_TOKEN`, no `OPENAI_API_KEY`, no
`CLOUDFLARE_API_TOKEN`.

### Phase 1: direct-to-AI-Gateway (still supported)

Useful for diagnosing whether a problem is in the gateway or in the
Worker. Leave `CF_WORKER_URL` empty in `.env`; the probes go straight
to AI Gateway with `cf-aig-authorization`:

```bash
unset CF_WORKER_URL
npm run probe:chat
```

See [Two operating modes](#two-operating-modes) for the direct-mode
sub-options.

## Two operating modes (direct only)

When running Phase 1 (no Worker), the probes can use either of two
direct-mode setups:

| Mode             | `OPENAI_API_KEY` | Who holds the OpenAI key | Notes                                                |
| ---------------- | ---------------- | ------------------------ | ---------------------------------------------------- |
| **BYOK**         | *empty*          | Cloudflare (stored key)  | The intended setup.                                  |
| Pass-through     | `sk-...` (real)  | the probe / app          | Fallback when BYOK isn't available, or for debugging |

In Phase 2 (Worker), the question goes away: the Worker always uses
BYOK against the gateway. The probes' `OPENAI_API_KEY` is irrelevant.

## Issuing JWTs

`scripts/issue-token.ts` mints an HS256 token signed with `JWT_SECRET`
from `.dev.vars` (or the `JWT_SECRET` env var):

```bash
npm run issue:token -- --sub alice --ttl 24h
# prints the JWT to stdout
```

`--sub` is the per-user identifier (free-form). `--ttl` accepts
`Ns`, `Nm`, `Nh`, `Nd`. The Worker logs the `sub` into AI Gateway
metadata so requests are attributable per user.

In production, JWT issuance moves wherever your real auth system
lives (this script is just for local testing).

## Layout

```
.
├── README.md
├── CLAUDE.md
├── wrangler.toml                ← Worker config
├── tsconfig.json                ← Node side (probes + scripts)
├── tsconfig.worker.json         ← Workers runtime (Worker + shared jwt.ts)
├── .env.example
├── .dev.vars                    ← local Worker secrets (gitignored)
├── package.json
├── src/
│   ├── jwt.ts                   ← HS256 sign/verify, runtime-agnostic
│   ├── config.ts                ← probes' env reader; picks direct/worker
│   ├── client.ts                ← OpenAI client wired to either backend
│   ├── probe-chat.ts
│   ├── probe-stream.ts
│   ├── probe-whisper.ts
│   └── worker/
│       ├── index.ts             ← Worker entrypoint (auth + proxy)
│       └── env.ts               ← Env binding types
├── scripts/
│   └── issue-token.ts           ← CLI to mint per-user JWTs
└── samples/                     ← Whisper audio inputs (gitignored)
```

## What Phase 2 still does NOT do

- **No persistent user store.** Tokens are signed with a shared
  symmetric secret; revoking a single user means rotating the secret
  (which invalidates everyone). Phase 3 adds D1/KV for per-user keys
  and revocation.
- **No per-user quotas.** AI Gateway's per-gateway rate-limits work,
  but the Worker doesn't enforce per-`sub` request or token budgets
  yet.
- **No login flow / token refresh.** `issue:token` is a manual mint.
- **No model allow-listing.** A user JWT can request any model the
  gateway permits.

These belong to Phase 3.

## License

Internal PoC — no license declared.
