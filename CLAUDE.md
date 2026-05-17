# CLAUDE.md

Guidance for Claude when working in this repo. The user-facing
overview lives in [README.md](README.md); capacity ceilings live in
[SCALING.md](SCALING.md); the realtime-bypass rationale (written
for non-engineer reviewers) lives in
[REALTIME_BYPASS.md](REALTIME_BYPASS.md). This file captures the
decisions and conventions a future Claude session won't pick up
from the code alone.

## What this repo is

A TypeScript proof-of-concept that proxies an OpenAI-using desktop
app's traffic through **Cloudflare AI Gateway**, with a
**Cloudflare Worker** in front that does per-user auth (KV-backed
opaque API keys), model allow-listing, token budget enforcement,
and atomic per-user usage counting in **Durable Objects**. Phase
5a added a **realtime WebSocket** path for `gpt-realtime-whisper`
that bypasses AI Gateway for one specific reason (see
REALTIME_BYPASS.md). The repo exists because the underlying
desktop app is being productized.

The repo implements **Phases 1, 2 (history), 3, 4, 5a**:
- Phase 1: REST probes against AI Gateway with BYOK.
- Phase 2 (superseded, in git history): Worker validating per-user
  HS256 JWTs.
- Phase 3: Worker with KV users, opaque API keys, model
  allow-list, token budget, revocation, admin endpoints.
- Phase 4: atomic per-user counters via Durable Object; streaming
  chat token accounting via SSE tee.
- Phase 5a: realtime WebSocket transcription. The Worker dials
  OpenAI direct (`https://api.openai.com/v1/realtime`) using a
  Worker-secret copy of the OpenAI key, because CF AI Gateway's
  WS proxy doesn't currently route OpenAI's GA Realtime shape.

Phase 5b (audio-seconds metering for realtime) and Phase 6 (real
login flow, DO Hibernation API for realtime, AI Gateway log
reconciliation) are out of scope.

## Architecture decisions (don't relitigate without asking)

- **BYOK interpretation is option B (vendor-held key), not option A.**
  Company holds one OpenAI key centrally; end users never paste one.
- **REST goes through AI Gateway; realtime bypasses.** Phase 5a's
  bypass is a workaround for a gateway regression — not a permanent
  architectural split. When CF fixes WS proxying, swap the
  upstream URL in `realtime.ts` to point at the gateway and delete
  the duplicate Worker secret. See REALTIME_BYPASS.md.
- **The OpenAI key lives in two places under Phase 5a.** AI Gateway
  BYOK (for REST) AND a Worker secret named `OPENAI_API_KEY` (for
  realtime). These must hold the same value; rotation procedure
  updates both.
- **Auth is opaque API keys, not JWTs.** Long-lived, server-issued,
  revocable from KV. Don't reintroduce JWTs.
- **KV = static identity + config. DO = live counters.** Don't
  move counters back into KV (re-introduces 1 write/sec/key cap).
- **Streaming chat must be counted.** Don't refactor the SSE tee
  out of `index.ts` without replacing it with another mechanism.

## File map and conventions

- `src/worker/users.ts` — KV. `UserRecord` is identity + config.
  Default `allowed_models` includes `gpt-realtime-whisper` now.
- `src/worker/usage.ts` — `UsageCounter` Durable Object + helpers.
- `src/worker/admin.ts` — `/admin/*` handlers; merges KV+DO views.
- `src/worker/realtime.ts` — Phase 5a. WS upgrade → auth →
  pre-checks → upstream `fetch(https://..., { Upgrade: "websocket" })`
  → `WebSocketPair` → bidirectional pump. **No usage metering yet**
  (Phase 5b will add audio-byte counting).
- `src/worker/index.ts` — main handler. Order of operations is
  load-bearing:
    1. OPTIONS → CORS.
    2. **`Upgrade: websocket` header → realtime handler.** This
       runs before all REST routing.
    3. `/admin/*` → admin handler.
    4. REST auth, body shaping, proxy, usage tracking.
- `src/probe-realtime.ts` — `ws`-based client. Sends a 24 kHz
  mono PCM16 file as base64-encoded `input_audio_buffer.append`
  events.
- `scripts/spike-realtime*.ts` — empirical research that informed
  Phase 5a. Kept in tree so the bypass decision is reproducible.

ES modules, strict TypeScript, no test framework yet.

## Non-obvious gotchas — preserve these

### 1. BYOK requires no `Authorization` header (REST)
See unchanged section in prior CLAUDE.md generations. The Worker
strips client-supplied `authorization` before forwarding to AI
Gateway for REST; in direct-mode probes the SDK is told to set
`Authorization: null` in `defaultHeaders`.

### 2. wrangler runtime lags the calendar
`compatibility_date` must be a date the installed wrangler runtime
supports. Currently `2026-04-28`.

### 3. KV id is required even for local dev
`wrangler dev` rejects a `kv_namespaces` entry without an `id`;
any placeholder works locally. Replace before deploy.

### 4. Durable Objects require Workers Paid + migration tag
`[[migrations]]` in `wrangler.toml` is required for deploy.

### 5. SSE usage tracking depends on injected `stream_options`
The Worker injects `stream_options.include_usage: true` for
streaming chat. Don't strip it; OpenAI won't emit the usage chunk
otherwise.

### 6. Use `DurableObject` from `cloudflare:workers`
The DO class extends `DurableObject<Env>`. Plain-class shims fail
the workers-types brand check.

### 7. Realtime: `fetch()` requires `https://`, not `wss://`
Workers' `fetch()` only accepts http/https URLs. To open an
outgoing WebSocket, use `https://...` and add `Upgrade: websocket`
header. Took a wasted debug cycle in Phase 5a to find this — keep
the comment in `realtime.ts`.

### 8. Realtime: `OpenAI-Beta: realtime=v1` is deprecated
OpenAI removed the Beta header during the GA rollout. Don't send
it. `realtime.ts` deliberately does not. CF AI Gateway's docs
example still shows it — it's stale.

### 9. Realtime: `gpt-realtime-whisper` is NOT a session model
It goes inside
`session.update.audio.input.transcription.model`. The URL query is
either `?intent=transcription` (transcription-only) or
`?model=gpt-realtime` (bidirectional session, transcription as one
input mode). Don't put `gpt-realtime-whisper` in the URL param.

### 10. Realtime: don't override `turn_detection` for whisper
`gpt-realtime-whisper` rejects manually-set `turn_detection`
("Turn detection is not supported for this transcription model").
Keep the server's default. `probe-realtime.ts` and `realtime.ts`
both reflect this — only set `audio.input.transcription` in
session.update.

### 11. Realtime: `rate_limits.updated` does not fire (today)
We tested with full transcription sessions; no `rate_limits.updated`
event was ever emitted. The `completed.usage` field exists but
values were all zero in our tests. **Don't plan to meter via
either.** Phase 5b will count audio bytes flowing through the
Worker (24 kHz mono PCM16 → 48 000 B/s).

### 12. Audio format: 24 kHz mono PCM16
The probe expects `samples/hello-24k.pcm`. Generate from any wav:
`ffmpeg -i input.wav -ar 24000 -ac 1 -f s16le samples/hello-24k.pcm`.
The committed file is small enough to keep in the repo.

## Environment quirks

- Working directory exists at two paths sharing the same inode.
  Prefer `/ssd/...`.
- `.env` carries `OPENAI_API_KEY` for *probe* pass-through mode
  (REST only). `.dev.vars` carries `OPENAI_API_KEY` for the
  *Worker* (realtime upstream). Same value should appear in both
  files locally; same value should also be stored as AI Gateway
  BYOK in the dashboard. Three copies in dev, but the .env one is
  only used when you set `OPENAI_API_KEY` explicitly in probes
  (which you usually don't — BYOK is the default).
- `tmp/` is gitignored (the user keeps their OpenAI key there as
  `tmp/oai.env`). Don't `git add` anything under `tmp/`.
- `wrangler dev` works without `wrangler login`; deploy needs it.
- Wiping `.wrangler/` clears local KV + DO state.

## Working style for this user

- Comfortable with CLI tooling. Wants Claude to make reasonable
  calls and proceed without clarifying questions for every step.
- Prefers concrete next-steps over open-ended prompts.
- Terse responses. Code-level detail in code; narrative in
  README/CLAUDE.md/SCALING.md/REALTIME_BYPASS.md, not in chat.
- When proposing risky-looking architectural detours (like the
  realtime bypass), provide both the technical plan
  (REALTIME_PLAN.md) AND a non-engineer-facing rationale
  (REALTIME_BYPASS.md). His boss reads the latter.
