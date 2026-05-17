# Scaling and bottleneck analysis

A read of where this stack actually has ceilings, ordered by how likely
you are to hit each one in practice. Captures the architecture's known
limits at the time of writing — review when CF or OpenAI change their
quotas, or when this repo's implementation changes (especially around
KV-write hot paths).

## TL;DR

**The Cloudflare Worker itself is almost certainly not the bottleneck.**
Workers are not single servers — each request runs in a V8 isolate at
whichever Cloudflare POP the user hits, and the platform scales
horizontally across hundreds of locations. CF reports their network
serves millions of req/sec across customers. For your traffic, treat
per-Worker concurrency as effectively unbounded.

The real ceilings, in order:

1. OpenAI tier rate limits
2. AI Gateway per-gateway rate limits (configurable)
3. Workers KV per-key write rate (~1/sec) — affects only the usage counter
4. Workers KV per-namespace caps, fetch subrequest timeout, CPU per request

The current implementation hits (3) before any of the others on a
single high-traffic user; (1) dominates everything else.

## Per-request resource budget (Workers Standard / paid plan)

| Resource              | Limit                                          | What our handler uses          |
| --------------------- | ---------------------------------------------- | ------------------------------ |
| CPU time              | 30 s                                           | ~10–30 ms (KV + JSON + headers) |
| Wall time             | 30 s default fetch; longer for streamed responses | bounded by upstream            |
| Subrequests           | 1000                                           | 1 KV read + 1 fetch (+1 KV write on chat) |
| Request body          | 100 MB                                         | streamed for Whisper, buffered for chat   |
| Memory                | 128 MB                                         | trivial unless chat bodies get huge       |

Free-tier limits are much tighter (10 ms CPU, 50 subrequests). This
stack assumes the paid plan; the Durable Objects added in Phase 4
require it anyway.

## The real bottlenecks

### 1. OpenAI tier rate limits (dominant)

Whisper-1 RPM by tier (subject to change):

| Tier   | Whisper-1 RPM | Sustained ≈ RPS |
| ------ | ------------- | --------------- |
| 1      | 50            | 0.8             |
| 2      | 500           | 8               |
| 3      | 5,000         | 80              |
| 4      | 10,000        | 160             |
| 5      | 30,000+       | 500+            |

For chat completions the limit is **tokens per minute** (TPM), not
just requests. Your real ceiling depends on prompt + completion size,
not request count alone.

This dominates everything else. Your throughput is the OpenAI tier
you're on, period — until you hit (2) or (3).

### 2. AI Gateway per-gateway rate limits

Configurable in the AI Gateway settings ("Rate limits" tab). Default is
unlimited. Set this if you want to put a hard cap on spend regardless
of OpenAI's tier limits.

### 3. Workers KV per-key write rate (~1/sec)

This is the only limit that the **current implementation** specifically
exacerbates. The per-user usage counter is one KV entry per user
(`apikey:<hash>` → record). Workers KV rate-limits writes to a single
key at roughly **1 write/sec globally**, last-write-wins.

So in Phase 3:

- A single user doing >1 non-streaming chat/sec will have **some
  usage-counter updates dropped**. Reads stay consistent eventually;
  the counter just under-counts.
- It does **not** rate-limit Whisper or streaming chat because those
  paths don't write KV at all (different gap — see "Known gaps" in
  the README).
- It does **not** rate-limit across users — 1000 different users each
  at 1 chat/sec is fine.

**Phase 4 lifts this**: per-user counters move into a Durable Object
keyed by `sub`. DO storage operations are atomic and not subject to
the KV per-key rate limit. The KV record keeps only static config
(allowed_models, token_budget, revoked).

### 4. Other Workers limits (typically not in your way)

- **KV reads:** ~1000/sec per Worker isolate, much higher globally,
  edge-cached. The auth lookup per request is cheap.
- **Fetch subrequest timeout:** 30 s default. Long Whisper audio (~30+
  seconds of speech) may approach this. Bump in `wrangler.toml` if
  you have multi-minute audio files.
- **Subrequest cap:** 1000 per request. We use 2–4.
- **CPU per request:** 30 s. We use milliseconds.

## Whisper specifically

Whisper is request/response, not streaming, so "concurrent
transcriptions in flight" is the relevant metric:

- **Per-request CPU on our Worker:** negligible. We don't parse the
  audio; the multipart body streams upstream verbatim (see
  `src/worker/index.ts` — non-chat paths pass `request.body` through
  without buffering).
- **Per-request wall time:** dominated by OpenAI Whisper processing.
  ~1 s for short clips, 5–10+ s for longer audio. The default fetch
  timeout (30 s) accommodates ~25 s of audio comfortably; beyond that,
  bump `compatibility_flags` / fetch timeout in `wrangler.toml`.
- **Concurrent in-flight on the Worker:** CF doesn't publish a hard
  number; the platform routinely handles thousands per POP. You will
  saturate OpenAI's tier before saturating the Worker.
- **Practical ceiling today:** the OpenAI tier you're on. Tier 2 →
  ~8 Whisper requests/sec sustained, more in bursts. Tier 3 → ~80/s.

"Whisper streams" in the *realtime streaming transcription* sense
(speech-in / partial-transcript-out) is **not** Whisper-1 — that's
the OpenAI Realtime API with `gpt-4o-transcribe` / `gpt-4o-mini-
transcribe`. Different protocol (WebSocket), different concurrency
model. This repo does not target it; would change the architecture
materially (the Worker would need to bridge WebSockets, not HTTP).

## Implementation-specific concerns

These come from this repo's code, not from CF/OpenAI:

- **Chat request body is buffered** (`src/worker/index.ts`,
  `/chat/completions` branch). Required for the model allow-list
  parse. Chat JSON bodies are tiny; not a real memory concern.
- **Non-streaming chat response body is buffered.** Required for the
  usage parse. Same — chat responses are small.
- **Streaming chat response body is teed** (Phase 4). The client
  branch flushes naturally; the parse branch sits in
  `ctx.waitUntil`. If the client disconnects mid-stream, the
  upstream and parse branches finish in the background. No memory
  spike — TransformStreams don't buffer the whole body.
- **Whisper body streams through** in both directions, no buffering.
- **Durable Objects are co-located.** A single user's DO lives in one
  region; their requests from elsewhere pay a round-trip to that
  region to hit the counter. Usually negligible compared to the
  OpenAI call but worth knowing.

## How to push the ceiling higher

In rough order of cost/benefit:

1. **Upgrade your OpenAI tier.** Usually the cheapest fix once
   you've hit (1).
2. **Tune AI Gateway rate limits.** Stops runaway clients from
   eating your OpenAI budget before tier limits fire.
3. **Cache repeated chat prompts in AI Gateway.** Free latency and
   cost reduction for hot completions; cache key includes the
   message list. Configure in the AI Gateway UI.
4. **Move metering off the hot path.** Use AI Gateway's logging
   API as the source of truth for usage; sample into a counter
   store on a cron, drop per-request writes entirely. Lower fidelity
   but unbounded throughput.
5. **Multi-region Durable Objects** (when supported) or shard the
   counter into N DOs per user and sum at read time. Worth it only
   above ~100 req/sec per user, which is well past most PoC needs.

## Order-of-magnitude examples

- **1 admin + 50 users, each doing ~10 chats/day, occasional Whisper
  uploads:** trivially fine on any OpenAI tier; KV counter is fine
  even without the Phase 4 DO.
- **1,000 active users, peak 100 concurrent chats:** comfortably
  inside Tier 2/3. DO counter handles per-user concurrency. Cost
  scales with OpenAI usage, not infrastructure.
- **One power user driving 10 chats/sec sustained:** Phase 3 KV
  counter under-counts; Phase 4 DO counter is fine.
- **10,000 concurrent Whisper uploads:** Worker capacity is fine.
  OpenAI Whisper at Tier 3 sustains ~80/s; you'd queue or throttle
  upstream. Add a back-pressure pattern in the Worker (return 429
  on AI Gateway 429s) — easy follow-up.
