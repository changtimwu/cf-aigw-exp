# Plan: add OpenAI Realtime API (`gpt-realtime-whisper`) support

**Status:** Spike complete. Plan revised based on what actually works
on the wire. The original plan (proxy through CF AI Gateway, same
pattern as REST) **does not work today** — see findings below.

Sources:
- https://developers.openai.com/api/docs/models/gpt-realtime-whisper
- https://developers.openai.com/api/docs/guides/realtime-transcription
- https://developers.openai.com/api/docs/guides/realtime-websocket
- https://developers.cloudflare.com/ai-gateway/usage/websockets-api/realtime-api/
- https://developers.cloudflare.com/workers/runtime-apis/websockets/

## Why this matters

The user's existing "Whisper" usage is actually `gpt-realtime-whisper`,
OpenAI's streaming speech-to-text model. Runs over WebSocket, not the
REST endpoint we currently use for `whisper-1`. Pricing $0.017/min
audio. Enables live-caption-style UX.

## Spike findings (verified empirically, see `scripts/spike-realtime*.ts`)

### 1. OpenAI's GA Realtime shape (works direct, doesn't work through CF gateway today)

The `OpenAI-Beta: realtime=v1` header is **deprecated**. Server replies:
> "The Realtime Beta API is no longer supported. Please use
> /v1/realtime for the GA API."

So the GA shape is:
- URL: `wss://api.openai.com/v1/realtime?intent=transcription`
  (for transcription-only sessions; uses
  `realtime.transcription_session` object server-side)
  — *or* — `wss://api.openai.com/v1/realtime?model=<session-model>`
  for bidirectional realtime where transcription is one input mode.
- Headers: `Authorization: Bearer <key>` only. **No `OpenAI-Beta`.**
- The `gpt-realtime-whisper` model is NOT a session model. It goes
  inside `audio.input.transcription.model`. The error if you pass
  it as the session model:
  > "Model 'gpt-realtime-whisper' is a transcription model and
  > cannot be used as the realtime session model. Use a realtime
  > model for the session model. Pass this transcription model as
  > audio.input.transcription.model instead."

### 2. Minimal working `session.update` for transcription

`scripts/spike-realtime-direct.ts` produced a full word-by-word
transcript with this:

```json
{
  "type": "session.update",
  "session": {
    "type": "transcription",
    "audio": {
      "input": {
        "transcription": { "model": "gpt-realtime-whisper", "language": "en" }
      }
    }
  }
}
```

Do **not** override `turn_detection` for `gpt-realtime-whisper` — it
errors with "Turn detection is not supported for this transcription
model." The server applies a sensible default on its own when you
use `?intent=transcription`.

### 3. Event taxonomy (observed, GA shape, transcription session)

Server → client events seen end-to-end:
- `session.created` — handshake
- `session.updated` — config accepted
- `input_audio_buffer.speech_started` / `.speech_stopped` —
  server VAD detection
- `input_audio_buffer.committed` — server has a finalized chunk
- `conversation.item.added` / `.done` — bookkeeping
- `conversation.item.input_audio_transcription.delta` — word-by-word
  partial transcripts. Payload has `item_id`, `content_index`,
  `delta` (a string fragment with leading space typically).
- `conversation.item.input_audio_transcription.completed` —
  final transcript for a committed audio segment. Payload has
  `item_id`, `content_index`, `transcript` (full string), and
  **a `usage` field**:
  ```json
  "usage": {
    "type": "tokens",
    "total_tokens": 0,
    "input_tokens": 0,
    "input_token_details": { "text_tokens": 0, "audio_tokens": 0 },
    "output_tokens": 0
  }
  ```
  The fields exist but were **all zero** in our test session — may
  be preview-period behavior, may be the field isn't populated for
  transcription-only sessions. Needs confirmation in production
  before relying on it for billing.

`rate_limits.updated` was **never emitted** during the transcription
session, despite being documented. The plan to meter via that event
needs to change.

### 4. CF AI Gateway's WebSocket proxy does NOT work with the current GA shape

Every gateway test (BYOK and passthrough, with and without
`OpenAI-Beta`, with `?intent=transcription` and with
`?model=gpt-realtime`) ended one of two ways:
- `?intent=transcription` → HTTP **500** with body
  `{"code":2002,"message":"Internal server error"}` — gateway's WS
  router doesn't know about this query param.
- `?model=<realtime-model>` → HTTP **101** upgrade succeeds, then
  immediate **WebSocket close code 1006** with no events. The
  connection is dropped before the server sends `session.created`.

This includes the exact model name from CF's own docs example
(`gpt-4o-realtime-preview-2024-12-17`). I believe CF AI Gateway's
WS proxy hasn't been updated for OpenAI's GA Realtime shape; the
docs example would have worked when the Beta shape was current.

**Direct connections to OpenAI from the same host work perfectly**,
so this is a CF-side issue, not network or OpenAI auth.

## Revised architecture

Because CF AI Gateway's WS proxy doesn't currently work for the GA
Realtime API, we have to bypass the gateway for realtime traffic
specifically:

```
                                                ┌───────────────────────────────┐
                                                │       /chat/completions       │
                                       ┌───────▶│       /audio/transcriptions   │ AI Gateway (BYOK, logs, caching)
                                       │  REST  │       (whisper-1, etc.)       │
┌──────────────┐   per-user API key    │        └───────────────────────────────┘
│ desktop app  │ ────────────────────▶ Worker
│ (per user)   │  Authorization: Bearer│        ┌───────────────────────────────┐
└──────────────┘                       │  WSS   │       /realtime               │
                                       └───────▶│       (gpt-realtime-whisper)  │ Direct to OpenAI (no gateway)
                                                └───────────────────────────────┘
```

Implications:

- **The Worker now needs a Worker-secret copy of the OpenAI API
  key** for realtime dialing. The same key remains stored in AI
  Gateway BYOK for REST. We're effectively storing the OpenAI key in
  two places until CF AI Gateway's WS proxy catches up.
- **Realtime traffic does NOT appear in AI Gateway logs/analytics.**
  Cost/usage attribution for realtime has to live in our DO counter
  alone (and the OpenAI dashboard upstream).
- **The Worker is the only metering point for realtime.** No
  retroactive reconciliation from gateway logs possible.

If CF later fixes the WS proxy, swapping the upstream URL back to
the gateway is a one-line change.

## Usage accounting strategy (revised)

Original plan B (count audio seconds) is now the **right** choice,
since:
- `rate_limits.updated` isn't emitted in transcription sessions
  empirically.
- `conversation.item.input_audio_transcription.completed.usage` has
  zero values in current tests.

Concrete approach for the Worker:
1. Count base64-decoded byte size of each `input_audio_buffer.append`
   we forward upstream.
2. Audio is 24 kHz mono PCM16 → 48 000 bytes/second.
3. After each `conversation.item.input_audio_transcription.completed`
   (or on socket close, whichever first), increment the DO counter by
   `floor(bytes_since_last_update / 48000 * COST_PER_SECOND_UNITS)`.
4. Track audio seconds (or normalized cost units) in the DO state
   alongside `tokens_used`. Both surface in the admin endpoints.

When `completed.usage` starts returning non-zero values in
production (or if OpenAI publishes a clearer billing event), we
switch to that.

## File-by-file change plan (revised)

### `src/worker/index.ts` (modified)
Add a WebSocket branch:
```ts
if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
  return handleRealtime(request, env, ctx);
}
```

### `src/worker/realtime.ts` (new)
- Validate `Authorization: Bearer <user-api-key>` from the upgrade
  request. (Workers honors arbitrary headers on WS upgrade — tested.)
- Apply revoke / model allow-list (model in query param or future
  default) / budget pre-check against DO.
- Dial OpenAI direct:
  ```ts
  const upstreamUrl = `wss://api.openai.com/v1/realtime?intent=transcription`;
  const upstreamRes = await fetch(upstreamUrl, {
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    method: "GET",
    // Workers fetch upgrades to WS when given an Upgrade header — see CF docs
  });
  const upstreamWs = upstreamRes.webSocket;
  upstreamWs.accept();
  ```
- Create client-side `WebSocketPair`, pump both directions.
- On each forwarded `input_audio_buffer.append`, decode base64
  length, accumulate bytes in a session-local counter.
- On each server-side `conversation.item.input_audio_transcription.completed`,
  flush the accumulated counter to the DO (via
  `ctx.waitUntil`).

### `src/worker/users.ts`
Add `gpt-realtime-whisper` to `DEFAULT_ALLOWED_MODELS`.

### `src/worker/usage.ts`
Extend `UsageState` with `audio_seconds_used: number`. Add an
`incrementAudio` helper.

### `src/worker/admin.ts`
Admin endpoint responses now include the new field. No other change.

### `src/worker/env.ts`, `wrangler.toml`, `.dev.vars`
- Add `OPENAI_API_KEY` as a Worker secret. Used only for the
  realtime upstream dial.
- Note in CLAUDE.md: this duplicates the BYOK key. Should be the
  same value. Future cleanup if CF gateway WS proxy works.

### `src/probe-realtime.ts` (new)
Uses `ws` package, sends `samples/hello-24k.pcm`, logs deltas. Same
shape as `scripts/spike-realtime.ts` but pointing at our Worker.

### `package.json` (already in tree from spike)
`ws` and `@types/ws` are devDeps. Move them to dependencies? No —
probe and spike are dev-time tools; the desktop app uses its own WS
client.

### Documentation
- `README.md`: add Realtime section. Note the CF gateway limitation
  and why we go direct.
- `CLAUDE.md`: WebSocket handling conventions, the audio-byte
  counting pattern, the dual-storage-of-OpenAI-key reality.
- `SCALING.md`: realtime sessions hold a Worker invocation open. At
  scale, switch to Durable Objects with the Hibernation API.
- Keep `REALTIME_PLAN.md` as a permanent record of why we chose
  the bypass path.

## Risks resolved by the spike

| Question                                              | Answer                              |
| ----------------------------------------------------- | ----------------------------------- |
| BYOK + WebSocket through AI Gateway?                  | Doesn't work today (HTTP 500 / 1006)|
| `rate_limits.updated` payload?                        | Not emitted in transcription session|
| `OpenAI-Beta: realtime=v1` still needed?              | No — deprecated, must be omitted    |
| `gpt-realtime-whisper` as `?model=` param?            | Rejected — it's a transcription model, not a session model |
| GA endpoint for transcription-only?                   | `?intent=transcription`             |
| Default `turn_detection`?                             | Don't override for gpt-realtime-whisper |
| Token usage in `completed.usage`?                     | Field exists, values were zero in test — unreliable today |

## Revised phasing

### Phase 5a — Realtime passthrough (direct to OpenAI), still small
- Worker secret holding the OpenAI key
- WS upgrade handler that dials OpenAI direct (bypassing AI Gateway)
- Per-user API key auth on upgrade
- `gpt-realtime-whisper` in default allow-list
- Probe using `ws` against the Worker
- README + CLAUDE.md updates noting the bypass

### Phase 5b — Audio-seconds metering
- Decode-and-count `input_audio_buffer.append` payloads as bytes flow
- Flush to DO counter on `completed` events
- Add `audio_seconds_used` to UsageState; admin surfaces it
- Optional pre-flight budget enforcement (separate audio_budget?
  or convert to a normalized "cost units" field — design call)

### Phase 5c — Reconnect AI Gateway when CF supports it
- One-line URL change in `realtime.ts`
- Delete the Worker's OpenAI key secret
- Realtime joins AI Gateway logging/analytics

### Phase 6 (defer until needed) — Durable Object + Hibernation
- Long-lived sessions move into a DO using
  `state.acceptWebSocket()` instead of holding a Worker isolate

## Effort estimate (revised)

| Block                                | Estimate   |
| ------------------------------------ | ---------- |
| Worker WS handler + auth             | 2–3 h      |
| Direct OpenAI upstream dial          | 1–2 h      |
| Probe + sample audio                 | 30 min     |
| Audio-seconds metering               | 2–3 h      |
| Docs (README/CLAUDE/SCALING update)  | 1 h        |
| **Total to 5a + 5b**                 | ~1 day     |

The CF gateway limitation isn't blocking — bypassing is mechanical.
The real cost is the duplicate-key reality and the loss of gateway
logging for realtime traffic. Both reversible if CF catches up.
