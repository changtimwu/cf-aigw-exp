# Demo client — for the desktop app team

Goal: prove that switching your existing OpenAI SDK code to use our
central Worker is a **2-line change per client construction**. Everything
else — model names, request shapes, response shapes, streaming
patterns, the SDK methods you call — stays identical.

## The whole diff, in one screenshot

```diff
// Chat / streaming / Whisper-1 (REST)
- const openai = new OpenAI({ apiKey: "sk-..." });
+ const openai = new OpenAI({ apiKey: USER_API_KEY, baseURL: WORKER_URL });

// Realtime (WebSocket)
- const ws = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription",
-                          { headers: { Authorization: `Bearer sk-...` }});
+ const ws = new WebSocket(`${WORKER_URL_WS}/v1/realtime?intent=transcription`,
+                          { headers: { Authorization: `Bearer ${USER_API_KEY}` }});
```

That's it. Same `openai.chat.completions.create(...)`. Same
`openai.audio.transcriptions.create(...)`. Same SSE iteration. Same
realtime WebSocket events.

## What you need from us

- **`WORKER_URL`** — the public URL of our deployed Worker.
  Today: `https://cf-aigw-exp-worker.changtimwu.workers.dev`
- **`USER_API_KEY`** — the per-user token we issue you. Starts with
  `aigwk_…`. Pass it where you used to pass the OpenAI key.

No OpenAI key in the app. Ever. If a customer's install is leaked,
the worst-case is one customer's quota gets burned — and we can
revoke the key in O(1).

## Quick start

```bash
cp .env.example .env             # fill in WORKER_URL + USER_API_KEY
npm install
npm run demo:chat                # non-streaming chat completion
npm run demo:stream              # streaming chat completion
npm run demo:whisper             # Whisper-1 transcription (REST) — uses hello.wav
npm run demo:realtime            # gpt-realtime-whisper (WS)       — uses hello-24k.pcm
```

Two sample audio files ship with the folder:
- `hello.wav` — 16 kHz mono PCM wav, ~11 seconds (JFK quote). For
  the Whisper-1 REST demo; OpenAI accepts any wav/mp3/m4a/webm.
- `hello-24k.pcm` — same audio resampled to 24 kHz mono PCM16 raw,
  the exact format the realtime API requires.

Point them elsewhere via `WHISPER_AUDIO_PATH` and
`REALTIME_AUDIO_PATH` respectively.

## What stays the same vs your current code

- All OpenAI SDK methods you call.
- Model names (`gpt-4o-mini`, `whisper-1`, `gpt-realtime-whisper`).
- Request bodies (the JSON you send is the JSON OpenAI receives).
- Response shapes (the JSON you parse is the JSON OpenAI emits).
- Streaming patterns — `for await (const chunk of stream)` works
  unchanged for chat. The realtime WS event names
  (`session.update`, `input_audio_buffer.append`,
  `conversation.item.input_audio_transcription.delta`, etc.) are
  identical to OpenAI's GA Realtime API.
- Audio formats — 24 kHz mono PCM16 for realtime, same files you'd
  send to OpenAI direct.

## What's new from your perspective

The only meaningful change beyond `baseURL`+`apiKey` is **a handful
of new HTTP error codes** the Worker may emit. Handle 401/403/429
gracefully:

| Status | Body `error.code`           | When                                                    | What to do                                    |
| ------ | --------------------------- | ------------------------------------------------------- | --------------------------------------------- |
| 401    | `missing_authorization`     | No `Authorization: Bearer aigwk_…` header               | Re-prompt for license / re-login              |
| 401    | `invalid_api_key`           | Key not found / format wrong                            | Re-prompt for license                         |
| 403    | `user_revoked`              | Key valid but admin revoked the user                    | Tell user to contact support                  |
| 403    | `model_not_allowed`         | Model isn't in this user's allow-list                   | Surface a "feature not enabled" message       |
| 429    | `budget_exceeded`           | User over their chat token budget                       | Surface a "monthly limit reached" message     |
| 429    | `audio_budget_exceeded`     | User over their realtime audio-seconds budget           | Same, scoped to live-transcription            |
| 502    | `upstream_*`                | OpenAI or AI Gateway returned an error                  | Treat like an upstream OpenAI error; retry    |

All other errors (5xx that aren't 502, network timeouts) you can
handle exactly like you handled them when calling OpenAI directly —
they have the same shapes.

## Limitations to know about

- **Streaming chat usage** is only tracked when the response
  includes a usage chunk. The Worker injects
  `stream_options: { include_usage: true }` for you, so you don't
  need to. (But don't override it to `false`.)
- **Realtime audio rate is assumed 24 kHz mono PCM16** for billing
  purposes. If you send other rates the bill is wrong; we'll fix
  on our side when needed.
- **Realtime budget is pre-flight only.** A session that's already
  open won't be terminated mid-stream when the user crosses their
  audio-seconds limit; the *next* upgrade attempt returns 429.

## Files in this folder

```
demo-chat.ts        Non-streaming chat completion (~40 lines)
demo-stream.ts      Streaming chat completion (~40 lines)
demo-whisper.ts     Whisper-1 transcription (~35 lines)
demo-realtime.ts    gpt-realtime-whisper over WebSocket (~80 lines)
.env.example        Env template
package.json        Standalone — copy this folder into your project as a
                    starting point if you like
tsconfig.json
```

Each `.ts` file leads with a `// BEFORE / AFTER` block showing the
exact diff so you can eyeball the migration cost in seconds.
