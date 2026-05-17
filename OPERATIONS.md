# Operations runbook

Day-to-day commands for the deployed Worker. The deployed instance,
secrets, and per-user state all live in Cloudflare; this repo is
the source code that produced them.

## Deployed instance

| What                     | Value                                                       |
| ------------------------ | ----------------------------------------------------------- |
| Worker URL               | `https://cf-aigw-exp-worker.changtimwu.workers.dev`         |
| CF Account               | `15bfe332876061d9a548a4f3d6835657`                          |
| KV namespace (`USERS`)   | `dae44091b36542d3928f1107e944ccae`                          |
| Durable Object class     | `UsageCounter` (migration tag `v1`)                         |
| Wrangler config          | [`wrangler.toml`](wrangler.toml)                            |

## Setup once per shell

```bash
# Never commit ADMIN_TOKEN. Get it from your password manager.
export ADMIN_TOKEN='<the admin token saved at deploy time>'
export CF_WORKER_URL=https://cf-aigw-exp-worker.changtimwu.workers.dev
```

If you lose `ADMIN_TOKEN`, **rotate it** — the value isn't
recoverable from the dashboard:

```bash
NEW=$(openssl rand -hex 32)
echo "$NEW" | wrangler secret put ADMIN_TOKEN
echo "New ADMIN_TOKEN: $NEW   <-- save now"
```

## User management

```bash
# Provision a user. The api_key is shown ONCE in the response.
npm run admin -- create-user --sub <name> \
  --models gpt-4o-mini,whisper-1,gpt-realtime-whisper \
  --budget 50000 --audio-budget 600

# Defaults if flags omitted: all three models above, token_budget=100000,
# audio_seconds_budget=600 (10 min). Set either budget to 0 for unlimited.

# Inspect / list
npm run admin -- list-users
npm run admin -- get-user --sub <name>

# Revoke (invalidates the api_key without deleting the user record)
npm run admin -- revoke-user --sub <name>

# Reset both counters (tokens_used + audio_seconds_used) to 0.
# Use at billing-period rollovers, or after a refund.
npm run admin -- reset-usage --sub <name>
```

## Smoke-test the prod Worker

After provisioning a user and capturing the `api_key`:

```bash
export USER_API_KEY=aigwk_…
npm run probe:chat                              # REST chat → AI Gateway
npm run probe:stream                            # REST streaming chat → AI Gateway
AUDIO_PATH=samples/hello-24k.pcm \
  npm run probe:realtime                        # WS → OpenAI direct (bypass)
npm run admin -- get-user --sub <name>          # see usage tick up
```

## Rolling the OpenAI key

Phase 5a's bypass means the OpenAI key lives in **two** places.
Both must be updated, in this order, to avoid a window where realtime
breaks:

```bash
# 1. Update AI Gateway's stored key in the dashboard:
#    AI Gateway → aigw-exp-poc → Provider Keys → OpenAI → Edit
#    Paste the new sk-... and save. REST traffic switches immediately.

# 2. Update the Worker secret used for realtime upstream:
echo "<new sk-...>" | wrangler secret put OPENAI_API_KEY
#    Wrangler triggers a deploy; new realtime sessions use the new key.

# 3. Revoke the old OpenAI key in OpenAI's dashboard.
```

When CF AI Gateway fixes its WebSocket proxy, step 2 goes away —
the Worker will read the gateway's stored key like REST already does.
See [REALTIME_BYPASS.md](REALTIME_BYPASS.md).

## Rolling the CF AI Gateway auth token

```bash
# 1. CF Dashboard → AI Gateway → aigw-exp-poc → Settings → Authentication
#    Generate a new gateway token. Copy it.

# 2. Push it to the Worker:
echo "<new cfut_...>" | wrangler secret put CF_AIGW_TOKEN

# 3. Delete the old gateway token in the AI Gateway settings.
```

## Re-deploying

```bash
# Typecheck (Node + Worker) and deploy.
npm run typecheck
wrangler deploy
```

Wrangler reads `CLOUDFLARE_API_TOKEN` from `.env` for auth. That
token currently needs: **AI Gateway: Edit**, **Workers Scripts:
Edit**, **Workers KV Storage: Edit**, **Account Settings: Read**.

## Watching prod

| What            | Where                                                       |
| --------------- | ----------------------------------------------------------- |
| REST per-request logs, costs, latency | CF dashboard → AI Gateway → `aigw-exp-poc` → Logs |
| Worker request logs / errors          | CF dashboard → Workers & Pages → `cf-aigw-exp-worker` → Logs |
| Per-user usage (tokens + audio)        | `npm run admin -- get-user --sub <name>` |
| Realtime cost                          | OpenAI billing dashboard (AI Gateway logs don't cover the bypass) |

## Tearing it down

```bash
# Delete the Worker
wrangler delete

# Delete the KV namespace (irreversible — wipes all user records)
wrangler kv namespace delete --namespace-id dae44091b36542d3928f1107e944ccae

# Local cleanup
rm -rf .wrangler/
```
