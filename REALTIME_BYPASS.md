# Realtime WebSocket bypass — why this isn't a hack

> Written for a non-engineer reviewer asking "why are you bypassing
> the layer you built around?" The short answer is that we still
> control the OpenAI key, just store it in one more place
> server-side, and the bypass reverses with a one-line change.

## TL;DR

To support the new live-transcription model
(`gpt-realtime-whisper`), we route those WebSocket sessions
**directly to OpenAI** instead of going through Cloudflare AI
Gateway like all our other traffic does. **The customer-facing
side is unchanged** — the desktop app still holds only its
per-user token, never an OpenAI key. The trade-off lives entirely
inside our Cloudflare infrastructure, and it reverses as soon as
Cloudflare fixes the issue that forced this.

## Background — what we built and why

Our architecture for everything except realtime audio:

1. Customer's desktop app talks **only** to our Cloudflare Worker,
   using a per-user token we issue (`aigwk_…`).
2. The Worker authenticates the user, checks their budget and
   model permissions, then forwards the request to Cloudflare AI
   Gateway.
3. AI Gateway holds our single OpenAI API key as a managed secret
   ("BYOK" — bring-your-own-key storage), substitutes it into the
   request, and forwards to OpenAI.
4. AI Gateway also gives us per-request logs, usage analytics,
   response caching, and cost tracking — all in one dashboard.

The customer's app never sees the OpenAI key. A leaked customer
install only exposes that one customer's per-user token, which we
can revoke instantly. **Solving this was the entire point of the
project.**

## What changed in May 2026

OpenAI rolled out a "GA" (general availability) version of its
Realtime audio API. As part of that rollout they:

- Restructured how transcription sessions are configured.
- Stopped accepting the older "beta" header
  (`OpenAI-Beta: realtime=v1`).
- Introduced a dedicated transcription endpoint path
  (`?intent=transcription`).

Cloudflare AI Gateway's WebSocket proxy was built for the older
beta shape. As of our testing, it hasn't been updated for the GA
shape. Every realtime connection through the gateway either:

- Returns HTTP 500 with "Internal server error" (for the new
  `?intent=transcription` path), or
- Upgrades successfully and then gets silently dropped before any
  data flows (for the older `?model=…` path).

Direct connections to OpenAI from the same machine work
perfectly — we have a working test script in the repo
(`scripts/spike-realtime-direct.ts`) that produces full
word-by-word transcripts. So this is a Cloudflare-side regression,
not an OpenAI issue or a network issue. Cloudflare's own public
documentation page for AI Gateway + Realtime still shows the
deprecated header, suggesting they haven't caught up yet.

We can't fix this from our side. We could wait for Cloudflare, but
their timeline is unknown and our product needs realtime
transcription to ship.

## Why bypassing is the right call, not a hack

The original concern this whole project addresses is: **don't
embed an OpenAI key in the customer's desktop app**. That concern
is about where the OpenAI key lives relative to the *customer*.
Bypassing AI Gateway is purely a *server-side* routing change.

| Concern                                                | Before bypass | After bypass |
| ------------------------------------------------------ | ------------- | ------------ |
| Customer's app holds an OpenAI key                     | No            | **No**       |
| A leaked customer install reveals our OpenAI key       | No            | **No**       |
| Per-user revoke works (instant)                        | Yes           | **Yes**      |
| Per-user budget enforcement                            | Yes           | **Yes**      |
| Per-user model permission                              | Yes           | **Yes**      |
| Per-user usage tracked                                 | Yes           | **Yes**      |
| OpenAI key stays inside Cloudflare's infrastructure    | Yes           | **Yes**      |

The OpenAI key still lives entirely server-side. The only change
is that it now lives in **two** server-side places inside
Cloudflare (the AI Gateway stored-keys feature *and* a Worker
secret), instead of one. Both are inaccessible to customers.

In security terms, the attack surface for the *customer-facing*
risk is unchanged. We've added one more thing to rotate when we
rotate the OpenAI key — that's the entire delta.

## What we actually lose

To be straight about the costs:

1. **AI Gateway analytics don't cover realtime traffic.**
   Cloudflare's per-request dashboard won't show audio minutes,
   cost, or latency for realtime sessions. Two replacement
   sources:
   - Our own per-user usage counter (already built, lives in
     Cloudflare Durable Objects).
   - OpenAI's billing dashboard.
   The graphs are split across two places until the bypass is
   removed.

2. **A second OpenAI-key copy to rotate.** When we rotate the
   OpenAI key, we update both the AI Gateway stored key and the
   Worker secret. ~30 seconds of additional work per rotation.
   Documented in the runbook.

3. **AI Gateway caching and retries don't apply to realtime.**
   This isn't a real loss in practice — caching streaming audio
   sessions is meaningless, and automatic retries of a long-running
   audio session would corrupt the session anyway.

That's the full bill. There is no security cost.

## Reversibility

When (or if) Cloudflare ships a fix for their Realtime WebSocket
proxy, the migration back is:

1. Change one upstream URL string in `src/worker/realtime.ts`
   (point at the gateway instead of OpenAI direct).
2. Delete the duplicate `OPENAI_API_KEY` secret on the Worker
   (`wrangler secret delete OPENAI_API_KEY`).
3. Redeploy.

Realtime traffic immediately re-joins the AI Gateway dashboard.
No code restructuring, no data migration, no customer-visible
change. We watch the Cloudflare changelog and revisit on each
update.

## Decision

Implement the bypass now. The first patch (Phase 5a) makes
realtime work end-to-end with all per-user controls intact. A
follow-up (Phase 5b) wires the realtime sessions into the
existing per-user usage counter so the budget is enforced for
audio time too. The bypass stays in place until Cloudflare
catches up.

## If your engineering lead pushes back

The likely objections and the short responses:

| Objection                                            | Response                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| "Why are we storing the OpenAI key twice?"           | Same string, two Cloudflare-managed locations. Both invisible to customers. The redundancy is the cost of working around the gateway regression. |
| "Won't this skew our cost accounting?"               | No. The per-user counter and OpenAI's bill are both source-of-truth. AI Gateway logs are nice-to-have; OpenAI's bill is authoritative. |
| "What if Cloudflare never fixes it?"                 | We stay on the bypass. The bypass is a complete solution on its own — it's not a fragile workaround that needs the gateway to come back. |
| "Could we self-host the gateway logic in the Worker?" | Yes — for realtime specifically, the Worker is already in the data path, so adding session logging there is a small extension of Phase 5b's metering work. We do it if Cloudflare drags. |
