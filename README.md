# cf-aigw-exp

**Status:** Phase 1 (probes) — experimental, not for production use.

A proof-of-concept for routing an internal OpenAI-powered desktop app's
traffic through [Cloudflare AI Gateway][cfaigw] as it transitions from
in-house tool to commercial product. The driving requirement: stop
embedding a fixed OpenAI key in every shipped binary.

[cfaigw]: https://www.cloudflare.com/products/ai-gateway/

## Why this exists

The original app talks to OpenAI directly (GPT-4o for chat, Whisper for
audio transcription). Once the app ships to external customers, a
single embedded key is no longer viable — it can be extracted, abused,
or starve real users. The decision was to keep the OpenAI relationship
**centralized at the vendor (us)** rather than asking each customer to
bring their own OpenAI account. Cloudflare AI Gateway is the proxy
layer that makes that practical: caching, logging, rate-limiting and
cost tracking come for free, the OpenAI SDK only needs a `baseURL`
override on the client side, and the upstream key lives server-side.

## Architecture (target end-state)

```
┌──────────────┐    user-auth    ┌─────────────────┐    cf-aig-auth    ┌──────────────┐    upstream    ┌────────┐
│ desktop app  │ ──────────────▶ │ Cloudflare      │ ────────────────▶ │ Cloudflare   │ ─────────────▶ │ OpenAI │
│ (per user)   │   JWT / token   │ Worker (auth,   │   gateway token   │ AI Gateway   │  stored key    └────────┘
└──────────────┘                 │ quotas, audit)  │                   │ (BYOK)       │
                                 └─────────────────┘                   └──────────────┘
```

In Phase 1 the Worker is omitted — the probes hit the gateway
directly with a developer-held gateway token. Phase 2 introduces the
Worker so the desktop app stops carrying the gateway token too.

## Roadmap

| Phase | Scope                                                                                           | This repo            |
| ----- | ----------------------------------------------------------------------------------------------- | -------------------- |
| **1** | Validate the proxy path. Chat, streaming chat, and Whisper all work through CF AI Gateway BYOK. | ← we are here        |
| 2     | Add a Cloudflare Worker for per-user auth, quotas, kill switches. App carries a per-user token. | not yet              |
| 3     | Real user accounts (D1 / KV), login flow, per-user usage analytics, model allow-listing.        | not yet              |

Phase 1 is intentionally minimal: the goal is to prove the wire path
and the OpenAI SDK compatibility, not to design a production auth
layer.

## Quick start

### 1. One-time Cloudflare dashboard setup

> The CF API token in `.env` does not currently carry
> `AI Gateway: Edit` scope, so we set the gateway up by hand. This is
> one-time per environment.

1. Dashboard → **AI** → **AI Gateway** → **Create Gateway**, name it
   `aigw-exp-poc`. Copy the **Gateway ID** into `.env` as
   `CF_AIGW_ID`.
2. New gateway → **Settings** → **Authentication** → enable
   **Authenticated Gateway**, create a token, paste it into `.env` as
   `CF_AIGW_TOKEN`.
3. New gateway → **Provider Keys** (a.k.a. BYOK / Stored Keys) →
   **Add Key** → choose OpenAI, paste your real OpenAI key, save.
   Leave `OPENAI_API_KEY` empty in `.env` — the gateway substitutes
   the stored key.

If Provider Keys isn't on your plan, set `OPENAI_API_KEY=sk-...` in
`.env`; the probes will run in pass-through mode instead (see
[Two operating modes](#two-operating-modes)).

### 2. Install & run

```bash
npm install
npm run probe:chat      # one-shot chat completion via gpt-4o-mini
npm run probe:stream    # streaming chat completion; prints time-to-first-token
npm run probe:whisper   # Whisper transcription; needs an audio file in samples/
npm run probe:all       # all three, in order
```

After each successful probe, open **AI Gateway → Logs** in the
dashboard. The request should appear with model name, token counts,
and cost — that's the round-trip confirmation.

For the Whisper probe, drop any short `.wav` / `.mp3` / `.m4a` into
`samples/` (or set `AUDIO_PATH` in `.env`). Two to five seconds of
speech is enough.

## Two operating modes

The same probes work in either mode; only `.env` changes.

| Mode             | `OPENAI_API_KEY` | Who holds the OpenAI key | Notes                                                |
| ---------------- | ---------------- | ------------------------ | ---------------------------------------------------- |
| **BYOK**         | *empty*          | Cloudflare (stored key)  | The intended Phase 1 setup.                          |
| **Pass-through** | `sk-...` (real)  | the probe / app          | Fallback when BYOK isn't available, or for debugging |

Both modes still go through the same CF AI Gateway URL and require
`CF_AIGW_TOKEN` (the Authenticated Gateway header). The only
difference is whether the OpenAI key travels in the request or is
substituted on the gateway side.

## Layout

```
.
├── README.md             ← you are here
├── CLAUDE.md             ← guidance for future Claude sessions in this repo
├── .env.example          ← env template with the CF account ID prefilled
├── package.json          ← `tsx` + `openai` + `dotenv`, nothing else
├── tsconfig.json
├── src/
│   ├── config.ts         ← reads .env, computes the gateway base URL
│   ├── client.ts         ← single OpenAI client, wired to the gateway
│   ├── probe-chat.ts     ← chat.completions.create
│   ├── probe-stream.ts   ← streaming chat.completions
│   └── probe-whisper.ts  ← audio.transcriptions.create
└── samples/              ← audio inputs for the Whisper probe (.gitignored)
```

## What Phase 1 is NOT

- **Not** a per-user system. The CF gateway token in `.env` is a
  single shared credential — fine for a developer, not safe to ship
  in a desktop app.
- **Not** rate-limited per end user. Per-gateway limits exist; per-user
  enforcement waits for the Phase 2 Worker.
- **Not** cost-attributed per user. Logs show requests, not who made
  them.
- **Not** Whisper-streaming. Whisper is request/response only.

These are deliberate omissions, not bugs.

## License

Internal PoC — no license declared.
