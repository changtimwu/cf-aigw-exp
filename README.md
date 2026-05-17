# cf-aigw-exp

**Status:** Phase 5b (realtime transcription + per-session audio-seconds metering) — experimental, not for production use.

A proof-of-concept for routing an internal OpenAI-powered desktop app's
traffic through [Cloudflare AI Gateway][cfaigw] as it transitions from
in-house tool to commercial product. The driving requirement: stop
embedding a fixed OpenAI key in every shipped binary, and centrally
control who can use the service, with what budget, and for which models
— with usage tracked atomically across streaming and non-streaming
chat alike.

[cfaigw]: https://www.cloudflare.com/products/ai-gateway/

See [SCALING.md](SCALING.md) for the architecture's actual ceilings,
[REALTIME_BYPASS.md](REALTIME_BYPASS.md) for why realtime WS
traffic skips AI Gateway today, and
[OPERATIONS.md](OPERATIONS.md) for day-to-day commands against the
deployed Worker.

## Why this exists

The original app talks to OpenAI directly (GPT-4o for chat, Whisper for
audio transcription). Once the app ships to external customers, a
single embedded key is no longer viable — it can be extracted, abused,
or starve real users. The decision was to keep the OpenAI relationship
**centralized at the vendor (us)** rather than asking each customer to
bring their own OpenAI account. Cloudflare AI Gateway is the proxy
layer; a Cloudflare Worker in front of it adds per-user auth, quotas,
and model allow-listing.

## Architecture (Phase 4 — implemented)

```
┌──────────────┐   Bearer aigwk_…   ┌──────────────────────────┐   cf-aig-auth   ┌──────────────┐   upstream    ┌────────┐
│ desktop app  │ ──────────────────▶│ Cloudflare Worker        │ ───────────────▶│ Cloudflare   │ ─────────────▶│ OpenAI │
│ (per user)   │  per-user API key  │ (this repo)              │  gateway token  │ AI Gateway   │  stored key   └────────┘
└──────────────┘                    │  • auth   (KV)           │                 │ (BYOK)       │
                                    │  • model allow-list      │                 └──────────────┘
                                    │  • budget check (DO)     │
                                    │  • SSE-tee usage track   │
                                    │  • admin under /admin/*  │
                                    └──────────────────────────┘
                                              │
                                              └─ Durable Object per `sub` for atomic counters
```

Phase 1 (direct probe → AI Gateway) is still supported as a diagnostic
path — set `CF_WORKER_URL` to enable Phase 4 routing, leave it empty
for direct mode.

## Roadmap

| Phase | Scope                                                                                          | Status                       |
| ----- | ---------------------------------------------------------------------------------------------- | ---------------------------- |
| 1     | Validate the proxy path. Chat, streaming chat, Whisper all work through AI Gateway BYOK.        | done                         |
| 2     | Cloudflare Worker for per-user JWT auth.                                                        | done (superseded by Phase 3) |
| 3     | KV-backed user store, opaque API keys, model allow-list, token budget, revocation, admin CLI.   | done                         |
| 4     | Durable Objects for atomic per-user counters; streaming chat token accounting via SSE tee.      | done                         |
| 5a    | Realtime WebSocket (`gpt-realtime-whisper`) transcription. Worker dials OpenAI direct           | done                         |
|       | (bypasses AI Gateway — see [REALTIME_BYPASS.md](REALTIME_BYPASS.md)).                           |                              |
| **5b**| Realtime audio-seconds accounting. Worker counts base64-decoded PCM bytes per session and       | ← we are here                |
|       | flushes to a new `audio_seconds_used` field in the per-user DO.                                 |                              |
| 6     | Real login flow, per-org admin, billing, AI Gateway logs reconciliation, DO Hibernation API     | not yet                      |
|       | for realtime sessions at scale.                                                                 |                              |

## Quick start

### Prerequisites

- Node.js ≥ 20
- `wrangler` installed and (for deploy) `wrangler login` run
- A Cloudflare account on **Workers Paid** (Durable Objects require it)
- An OpenAI key with `gpt-4o-mini` + `whisper-1` access, stored as a
  Provider Key inside your AI Gateway (BYOK)

### 1. Local end-to-end loop

```bash
npm install

cp .env.example .env             # fill direct-mode vars (CF_AIGW_TOKEN etc — same as Phase 1)

# .dev.vars holds local Worker secrets — replace ADMIN_TOKEN with a real random string.

npm run worker:dev               # wrangler dev on http://localhost:8787, local KV + DO

# In another shell:
export CF_WORKER_URL=http://localhost:8787

# Provision a user; the response includes the api_key (shown ONCE).
npm run admin -- create-user --sub alice \
  --models gpt-4o-mini,whisper-1,gpt-realtime-whisper \
  --budget 50000 --audio-budget 600
# → { user: {...}, api_key: "aigwk_…" }

export USER_API_KEY=aigwk_…      # paste from above

npm run probe:chat               # non-streaming — increments tokens_used
npm run probe:stream             # streaming — ALSO increments tokens_used (Phase 4)
npm run probe:whisper            # Whisper-1 REST — no token count to track
npm run probe:realtime           # gpt-realtime-whisper WS — Phase 5a; not metered yet

npm run admin -- get-user --sub alice    # tokens_used reflects all chat traffic
npm run admin -- list-users
npm run admin -- reset-usage --sub alice
npm run admin -- revoke-user --sub alice # subsequent calls → 403 user_revoked
```

### 2. Deploy to Cloudflare

```bash
wrangler login                                              # one-time
wrangler kv namespace create USERS                          # prints an id
# Edit wrangler.toml — replace the placeholder id with the printed one

wrangler secret put CF_AIGW_TOKEN < /dev/tty
wrangler secret put ADMIN_TOKEN  < /dev/tty

npm run worker:deploy                                       # prints the Worker URL
# Durable Object class `UsageCounter` is migrated automatically per
# the [[migrations]] tag in wrangler.toml.

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

All require `x-admin-token: <ADMIN_TOKEN>`. Responses combine the KV
record with live `tokens_used` / `last_request_at` from the per-user
Durable Object.

| Method  | Path                              | Body                                          | Notes                                  |
| ------- | --------------------------------- | --------------------------------------------- | -------------------------------------- |
| POST    | `/admin/users`                    | `{ sub, allowed_models?, token_budget?, audio_seconds_budget? }` | Returns user + the api_key (shown once) |
| GET     | `/admin/users`                    | —                                             | Lists all users with usage             |
| GET     | `/admin/users/:sub`               | —                                             | One user                               |
| DELETE  | `/admin/users/:sub`               | —                                             | Marks revoked=true (key invalidated)   |
| POST    | `/admin/users/:sub/reset-usage`   | —                                             | Clears the DO counter for that user    |

Defaults on create:
`allowed_models=["gpt-4o-mini","whisper-1","gpt-realtime-whisper"]`,
`token_budget=100000`, `audio_seconds_budget=600` (10 minutes).
An empty `allowed_models` array means unrestricted; either budget
set to `0` means unlimited for that dimension.

## How usage is counted

| Path                          | Counted?                                                  | Mechanism                                                  |
| ----------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| Non-streaming chat completion | Yes                                                       | Parse `usage.total_tokens` from JSON response              |
| Streaming chat completion     | Yes (Phase 4)                                             | Worker injects `stream_options.include_usage`, tees the    |
|                               |                                                           | SSE response, parses the trailing chunk in `waitUntil`     |
| Whisper-1 transcription (REST)| No                                                        | Whisper response has no token field. Still requires valid  |
|                               |                                                           | API key but doesn't decrement budget.                      |
| Realtime transcription (WS)   | Yes (Phase 5b)                                            | Worker base64-counts each `input_audio_buffer.append`      |
|                               |                                                           | client→upstream; flushes to `audio_seconds_used` on the    |
|                               |                                                           | matching `conversation.item.input_audio_transcription      |
|                               |                                                           | .completed` event. Pre-flight rejects new sessions when    |
|                               |                                                           | `audio_seconds_used >= audio_seconds_budget`.              |
| Embeddings, other endpoints   | No (current code)                                         | Easy follow-up; same JSON-usage pattern as chat            |

Both chat paths land in the same per-user Durable Object via
`ctx.waitUntil(incrementUsageDO(...))`. Budget enforcement is
pre-request (one DO read), so a request is accepted iff the user's
counter was under budget at the start. A single in-flight request can
push the counter past budget; the *next* one returns 429.

## Direct-to-AI-Gateway (still supported)

Useful for diagnosing whether a problem is in the gateway or in the
Worker. Leave `CF_WORKER_URL` empty:

```bash
unset CF_WORKER_URL
npm run probe:chat
```

Two sub-modes for direct (controlled by `OPENAI_API_KEY` in `.env`):

| Mode             | `OPENAI_API_KEY` | Who holds the OpenAI key | Notes                                                |
| ---------------- | ---------------- | ------------------------ | ---------------------------------------------------- |
| **BYOK**         | *empty*          | Cloudflare (stored key)  | The intended setup.                                  |
| Pass-through     | `sk-...` (real)  | the probe / app          | Fallback when BYOK isn't available, or for debugging |

## Layout

```
.
├── README.md
├── CLAUDE.md
├── SCALING.md                   ← bottlenecks & throughput ceilings
├── wrangler.toml                ← Worker config: KV + Durable Object bindings + migrations
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
│   ├── probe-realtime.ts        ← Phase 5a: WS to Worker, stream PCM, log transcript
│   └── worker/
│       ├── index.ts             ← main handler: auth + body shaping + proxy + SSE tee
│       ├── admin.ts             ← /admin/* handlers
│       ├── realtime.ts          ← Phase 5a: WS upgrade → OpenAI Realtime (bypass)
│       ├── users.ts             ← KV store: identity + config (no counters)
│       ├── usage.ts             ← UsageCounter DO + getUsage/increment/reset helpers
│       └── env.ts               ← Env bindings (KV + DO + secrets)
├── scripts/
│   └── admin.ts                 ← CLI client for /admin/* endpoints
└── samples/                     ← Whisper audio inputs (gitignored)
```

## Realtime transcription (Phase 5a)

The Worker accepts WebSocket upgrades on any path. The body of the
URL doesn't matter to us — by convention the desktop app uses
`wss://<worker>/v1/realtime?intent=transcription` to match the
OpenAI URL shape.

```bash
# After provisioning a user with gpt-realtime-whisper in their allow-list:
npm run admin -- create-user --sub alice --models gpt-realtime-whisper,gpt-4o-mini
export CF_WORKER_URL=http://localhost:8787
export USER_API_KEY=aigwk_…

# Run the probe (uses samples/hello-24k.pcm — 24 kHz mono PCM16 raw)
AUDIO_PATH=samples/hello-24k.pcm npm run probe:realtime
```

Important details:

- The Worker validates the user's API key on the **WebSocket
  upgrade request** (`Authorization: Bearer <api_key>` header).
  After upgrade, the auth is established for the life of the
  socket.
- The Worker dials OpenAI directly at
  `https://api.openai.com/v1/realtime?...` because CF AI Gateway's
  WS proxy doesn't currently handle the GA Realtime shape. The
  Worker carries a copy of the OpenAI key as a secret
  (`OPENAI_API_KEY`) for this hop only. **REST traffic continues
  through AI Gateway**, unchanged. See
  [REALTIME_BYPASS.md](REALTIME_BYPASS.md).
- The client's query string is forwarded verbatim — works for both
  `?intent=transcription` (transcription-only sessions, which use
  `gpt-realtime-whisper` inside `session.update.audio.input.transcription.model`)
  and `?model=<realtime-session-model>` (bidirectional sessions).
- The Worker doesn't parse session.update payloads. The model
  allow-list check is "does the user have any realtime model in
  their list", which means a user who can use *any* realtime path
  can switch transcription models inside their session. Refinement
  is Phase 5b/6 work.
- Audio must be **24 kHz mono PCM16**, base64-encoded inside
  `input_audio_buffer.append` events. Convert with:
  ```
  ffmpeg -i input.wav -ar 24000 -ac 1 -f s16le samples/hello-24k.pcm
  ```

## Phase 5b known gaps

- **Audio rate is hardcoded to 24 kHz mono PCM16** in the
  audio-seconds math (`bytes / 48000`). Clients sending audio at
  another rate (e.g. 16 kHz mono PCM16 = 32 000 B/s) will be billed
  incorrectly. Fix: parse `session.update.audio.input.format.rate`
  on the way through and recompute per-session.
- **Pre-flight enforcement only.** Once a realtime session is
  established, mid-session audio that pushes the user over budget
  is still counted but not interrupted. Same shape as Phase 4's
  streaming chat enforcement. A new session after the overage is
  rejected.
- **No per-session-model enforcement.** We check that *some*
  realtime model is in the user's allow-list. The specific
  transcription model is in user-controlled
  `session.update.audio.input.transcription.model`, which we don't
  inspect.
- **Realtime traffic doesn't appear in AI Gateway dashboard.** It
  bypasses the gateway. OpenAI's billing dashboard and our DO
  counter are the metering sources of truth.
- **Mid-segment disconnects lose accuracy.** If the WS closes
  before the `completed` event for an in-flight audio segment, the
  Worker flushes whatever bytes accumulated — but those bytes may
  not have been fully processed upstream. Difference is small in
  practice; OpenAI's bill is still authoritative.

## Phase 4 known gaps

- **No login flow.** API keys are provisioned out-of-band by an
  operator running `admin -- create-user`. There is no signup,
  password, OAuth, or token-refresh endpoint. Deferred to Phase 5.
- **Whisper quota.** Whisper has no token count, so it doesn't
  consume budget. A real product would meter audio seconds (parse
  upload size or query AI Gateway logs). Deferred.
- **Admin endpoints share the Worker.** Same Worker serves public
  and admin traffic, gated by `x-admin-token`. Production should
  put admin on a separate Worker with IP/mTLS gating.
- **Usage parse is best-effort.** If the SSE tee parser hits a
  malformed chunk or the client disconnects very early, that
  request's tokens may not get counted. AI Gateway's own logs are
  the authoritative source; Phase 5 can reconcile from there.
- **No model allow-list for non-chat endpoints.** Whisper request
  parsing is multipart and not parsed in the Worker; any
  `whisper-1`-like model goes through if the path is right.

See [SCALING.md](SCALING.md) for capacity ceilings.

## License

Internal PoC — no license declared.
