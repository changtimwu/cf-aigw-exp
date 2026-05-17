# CLAUDE.md

Guidance for Claude when working in this repo. The user-facing
overview lives in [README.md](README.md); this file captures the
decisions and conventions a future Claude session won't pick up
from the code alone.

## What this repo is

A small TypeScript proof-of-concept that proxies an OpenAI-using
desktop app's traffic through **Cloudflare AI Gateway**. It exists
because the app is being productized — a fixed OpenAI key can no
longer be embedded in distributed binaries.

The current contents are **Phase 1**: three probes (`probe-chat`,
`probe-stream`, `probe-whisper`) that exercise the gateway directly.
There is no Cloudflare Worker yet, no end-user auth, no per-user
quotas, and no front-end. Those belong to Phase 2 / 3 and are
intentionally out of scope.

## Architecture decisions (don't relitigate without asking)

- **BYOK interpretation is option B (vendor-held key), not option A
  (end-user-supplied key).** The company holds one OpenAI key
  centrally in Cloudflare; end users never paste an OpenAI key into
  the desktop app. Suggestions that route around this — e.g.
  "let the user bring their own key" UI flows — were explicitly
  ruled out at project kickoff.
- **AI Gateway sits in front of OpenAI, the OpenAI SDK is kept on
  the client.** The OpenAI SDK is reused as-is with a `baseURL`
  override; this minimises rewrite of the existing desktop app code.
- **Phase boundaries are deliberate.** Don't bolt a Worker /
  user-account system into Phase 1 just because it's "obviously
  needed eventually". Adding the Worker is Phase 2's whole point.
- **Authenticated Gateway is always on.** Every request carries
  `cf-aig-authorization: Bearer <CF_AIGW_TOKEN>`. Code that bypasses
  this header is wrong.

## File map and conventions

- `src/config.ts` — single source of env reading. New env vars go
  here, never read directly from `process.env` in probe files.
- `src/client.ts` — single `OpenAI` client instance, wired to the
  gateway. Probes import it; they should not construct their own
  client.
- `src/probe-*.ts` — each probe is a self-contained `tsx` entrypoint:
  prints what it's about to do, sends one request, prints meta
  (timing, tokens, model). When adding a probe, follow the same
  shape and register it in `package.json` scripts as `probe:<name>`.
- `samples/` — audio inputs for the Whisper probe. Gitignored except
  for `.gitkeep`. Don't commit real audio.
- `.env` — gitignored. `.env.example` is the template and **does**
  carry the CF account ID (not a secret).

ES modules, strict TypeScript, no test framework yet. If tests get
added later, prefer `node --test` over pulling in a dependency.

## Two-mode client gotcha

`src/client.ts` supports two modes selected by whether
`OPENAI_API_KEY` is set:

- empty → **BYOK** (gateway holds the OpenAI key; the SDK still
  needs *some* `apiKey` string, we pass `sk-byok-placeholder`)
- non-empty → **pass-through** (gateway forwards the client's key
  upstream)

Don't refactor this into "always require a real OpenAI key" — the
whole point is that BYOK lets us *not* hold one client-side. If you
need a third mode, add it without removing either of the existing
two.

It is currently **unconfirmed** whether CF AI Gateway's BYOK feature
covers Whisper (multipart audio upload) on every account plan. If
`probe-whisper` fails in BYOK mode, try it again with
`OPENAI_API_KEY` set; that tells us whether it's a BYOK-coverage
issue or a wire-format issue.

## Environment quirks

- The working directory exists at two paths that **share the same
  inode** (`/ssd/devhome/work/github/cf-aigw-exp` and
  `/home/timwu/work/github/cf-aigw-exp`). Treat them as one
  location; prefer the `/ssd/...` path in absolute references.
- The local `.env`'s `CLOUDFLARE_API_TOKEN` currently does **not**
  have `AI Gateway: Edit` scope, so management endpoints
  (`/accounts/.../ai-gateway/gateways`) return auth errors. Gateway
  creation/configuration is done via the dashboard. If a Phase 2
  task needs API-driven gateway management, ask the user to widen
  the token's scope rather than working around it.
- `wrangler` and `cloudflared` are installed on this host. Phase 2
  will use `wrangler`.

## Working style for this user

- The user is comfortable with CLI tooling and wants Claude to make
  reasonable calls and proceed without asking clarifying questions
  for every step.
- Prefer pasting concrete next-steps over open-ended "what would
  you like to do" prompts. When proposing a multi-phase plan, give
  Phase N concretely and just outline Phase N+1.
- Terse responses preferred over long explainers. Code-level detail
  in code, narrative in README / CLAUDE.md, not in chat output.
