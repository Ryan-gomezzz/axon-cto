# Operations

Env vars, scripts, dev loop, observability, shutdown, troubleshooting.

---

## Env vars

Validated by Zod at gateway boot in [packages/shared/src/env.ts](../packages/shared/src/env.ts). Missing a required one means the gateway throws on startup — by design.

### Required

| Var | Where it's used | Notes |
|---|---|---|
| `LLM_API_KEY` | Together.ai / OpenRouter auth | Passed to the OpenAI SDK as `apiKey`. |
| `TELEGRAM_BOT_TOKEN` | `TelegramClient` constructor | Use the **demo** bot for the demo, the **dev** bot for development. Two separate bots. |
| `TELEGRAM_CHAT_ID` | default chat for `telegram.send` | Your own chat id during dev; the demo audience chat for the demo. |
| `GITHUB_TOKEN` | Octokit (incident enrich, pr realtime, pr digest, rollback issue creation) | Needs `repo` scope at minimum. For rollback issue creation, also `issues:write`. |
| `GITHUB_ORG` | Octokit owner argument | e.g. `samsung-sri`. |
| `GITHUB_REPO` | Octokit repo argument | The single repo Axon watches in this build. Multi-repo support is a future change. |
| `SENTRY_WEBHOOK_SECRET` | HMAC verify on `/webhook/sentry` | Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Configure Sentry to use the same value. |
| `GITHUB_WEBHOOK_SECRET` | HMAC verify on `/webhook/github` | Same procedure as Sentry. **Different value from `GITHUB_TOKEN`.** Webhook secrets and PATs are not the same thing. |
| `LINEAR_API_KEY` | Linear GraphQL auth in the morning brief | Linear's API auth header is `Authorization: <key>` — no `Bearer` prefix. |

### Optional (with defaults)

| Var | Default | Notes |
|---|---|---|
| `LLM_BASE_URL` | `https://api.together.xyz/v1` | Override to `https://openrouter.ai/api/v1` if you want OpenRouter. |
| `LLM_MODEL_INCIDENT` | `nvidia/Llama-3.1-Nemotron-70B-Instruct-HF` | The "Sonnet-tier" slot. Used by the incident commander only. |
| `LLM_MODEL_ROUTINE` | `nvidia/Nemotron-Mini-4B-Instruct` | The "Haiku-tier" slot. Used by the brief, PR digest, and sprint risk. |
| `KG_DB_PATH` | `./data/axon.db` | Set to an absolute path to avoid cwd ambiguity. The gateway and the seed CLI must both resolve to the same file — see `decisions.md` if you hit this. |
| `PORT` | `3000` | Demo machine often has 3000 occupied; this checkout uses `3030`. |
| `LOG_LEVEL` | `info` | `debug`, `trace`, etc. — pino levels. |
| `LOG_FILE` | unset | When set, pino multistreams to both stdout and the file. `demo/fire-webhook.ts` tails this for SLA timing. |
| `NODE_ENV` | `development` | The error handler in `server.ts` only includes stack frames when this is `development`. |

### Optional, not in the validated schema

These are read directly from `process.env` by skills that can degrade gracefully if they're absent:

| Var | Used by | Notes |
|---|---|---|
| `SENTRY_AUTH_TOKEN` | morning brief, incident recovery monitor | Sentry REST API auth. Without it, Sentry fetcher returns `ok:false` and recovery polling is a no-op. |
| `SENTRY_ORG`, `SENTRY_PROJECT` | same | Used to build the `/api/0/projects/{org}/{project}/issues/` URL. |
| `TELEGRAM_ESCALATION_CHAT_ID` | incident `escalate` action | When unset, the escalate button reports "not configured". |

---

## Scripts

All run from the repo root.

| Command | What it does |
|---|---|
| `pnpm install` | Install everything. Compiles the `better-sqlite3` native binding — needs build tools. |
| `pnpm seed` | Wipe + reseed the KG. Produces 52 nodes / 65 edges in `data/axon.db`. |
| `pnpm dev` | `tsx watch packages/gateway/src/main.ts`. Watches all workspace files; restarts on change. |
| `pnpm test` | Vitest in band per package. Runs all 127 tests. |
| `pnpm typecheck` | `tsc --noEmit` per package. |
| `pnpm build` | `tsc` per package. Produces `dist/` per package. **Not used by `pnpm dev` or the demo.** Save for later when we ship a built artifact. |

Skill-level CLIs:

```bash
pnpm exec tsx packages/brief/src/cli/run-now.ts        # morning brief
pnpm exec tsx packages/pr/src/cli/run-now.ts           # PR digest
pnpm exec tsx packages/sprint/src/cli/run-now.ts       # sprint risk
pnpm exec tsx demo/fire-webhook.ts                     # synthetic incident
pnpm exec tsx demo/add-skill.ts standup                # extensibility flex
```

---

## The dev loop

Three terminals, in this order:

1. **Gateway terminal** — `pnpm dev`. Leave running.
2. **CLI / curl terminal** — fire webhooks, trigger CLIs. The first thing you'll do here is run `pnpm seed` once, then start trying things.
3. **Telegram on phone or second monitor** — see the actual user-facing output.

`tsx watch` restarts on any file change in the workspace. After a restart you'll see "tsx restart" then a fresh "gateway listening" line. Crons re-register on every restart (so the `cron registered` log appears every time).

When you change `.env`, `tsx watch` does **not** restart — it doesn't watch dotfiles. Stop and restart `pnpm dev` manually.

---

## Verifying a clean boot

The boot log is the receipt. After `pnpm dev`, you should see (in order, ignoring polling-error noise from invalid Telegram tokens):

```
◇ injected env (16) from .env
{ component:'scheduler', cron_name:'morning-brief', cron:'0 8 * * *',    timezone:'Asia/Kolkata', msg:'cron registered' }
{ component:'scheduler', cron_name:'pr-digest',     cron:'0 18 * * 1-5', timezone:'Asia/Kolkata', msg:'cron registered' }
{ component:'scheduler', cron_name:'sprint-risk',   cron:'0 9 * * 1-5',  timezone:'Asia/Kolkata', msg:'cron registered' }
{ component:'scheduler', cron_name:'morning-brief', cron:'0 8 * * *',    timezone:'Asia/Kolkata', msg:'cron registered (next fire computed by node-cron at runtime)' }
{ component:'scheduler', cron_name:'pr-digest',     cron:'0 18 * * 1-5', timezone:'Asia/Kolkata', msg:'cron registered (next fire computed by node-cron at runtime)' }
{ component:'scheduler', cron_name:'sprint-risk',   cron:'0 9 * * 1-5',  timezone:'Asia/Kolkata', msg:'cron registered (next fire computed by node-cron at runtime)' }
{ component:'gateway', port:3030, node_env:'development', registered_jobs:['github-event','brief','incident','pr-realtime'], msg:'gateway listening' }
```

Smoke checks:

```bash
curl -sS http://localhost:3030/healthz                  # → {"status":"ok","uptime":N}
curl -sS http://localhost:3030/demo/kg-snapshot         # → { nodes: [...50], edges: [...50] }
```

---

## Observability

### Structured logging

Every log line is a single-line pino JSON object with `component` and (where applicable) `traceId`. The keys you'll grep for:

- `component`: `gateway`, `queue`, `scheduler`, `incident`, `brief`, `pr`, `pr-realtime`, `pr-digest`, `sprint`.
- `traceId`: `t-<ms>-<counter>-<hex6>`. Generated at the trigger; propagates via `AsyncLocalStorage` through async chains.
- `msg`: free-text; the canonical messages are stable enough to grep for (`'gateway listening'`, `'incident pipeline first-token sent'`, `'morning brief delivered'`, etc.).

### LOG_FILE

Set `LOG_FILE=./data/gateway.log` and pino multistreams to both stdout and that file. `demo/fire-webhook.ts` tails it for the `incident pipeline first-token sent` line matching its trace id, then prints the SLA result.

### Stage timings

The incident pipeline emits one structured line per run with full stage breakdown:

```
{ component:'incident', traceId, incident_id,
  stage_ingest_ms, stage_enrich_ms, stage_synth_first_chunk_ms,
  total_ms, sla_60s, telegram_message_id }
```

If `total_ms > 60000`, that's the SLA missed. The fix is almost always either `enrich_ms` (parallelize Octokit, prune calls) or `stage_synth_first_chunk_ms` (lean the system prompt, switch to a faster model).

The other skills emit similar `elapsed_ms` lines so you can grep for slow-skill regressions.

### Pretty-printed logs

```bash
pnpm dev | pnpm exec pino-pretty
```

Or, for the file:

```bash
tail -f data/gateway.log | pnpm exec pino-pretty
```

`pino-pretty` is a `devDependency` of the root package.

---

## Shutdown

Send SIGTERM (Ctrl-C in dev sends SIGINT — same handler):

```
1. http server.close()           — stop accepting new requests
2. scheduler.stop()              — stop firing crons
3. recovery.stopAll('shutdown')  — clear every active polling timer
4. queue.drain()                 — wait for in-flight jobs (no new ones; http is closed)
5. telegram.stopPolling()        — close the bot polling driver
6. db.close()                    — release the SQLite handle
7. process.exit(0)
```

Idempotent on repeat signals. If you Ctrl-C twice, the second signal is ignored.

If the process won't exit cleanly:

- A leaked timer in a custom skill (most likely your own code; the recovery monitor is tested for this).
- A pending Telegram request that's waiting on a network response. The retry path has bounded delays (max 8s); after that the request rejects and the worker moves on.
- The bot polling driver (node-telegram-bot-api) — if `stopPolling` hangs, it's an upstream library issue. Hard-kill is fine in dev.

---

## Troubleshooting

### "Invalid environment configuration"

Pino's pre-init exception. The error message lists exactly which keys are missing or malformed. Check `.env`. After fixing, **restart** — `tsx watch` does not auto-pick-up dotenv changes.

### Webhook returns 401

HMAC mismatch. Common causes:

- `.env` has a different `SENTRY_WEBHOOK_SECRET` than what the upstream is signing with.
- You edited `.env` after the gateway booted; the gateway is using the value from the *previous* run's env. Restart.
- `curl` body has trailing whitespace your `node -e` HMAC computation doesn't account for.

### Webhook returns 200 but nothing happens

Either the queue handler isn't registered for that job type, or the handler ran and its log is buried under noise. Search `data/gateway.log` for the response's `traceId`:

```bash
grep '"traceId":"t-XXXX"' data/gateway.log
```

### `pnpm dev` looks fine but Telegram is silent

- Check `data/gateway.log` for `polling_error` (your bot token is invalid for polling).
- Check for `Telegram sendMessage HTTP 401/404` — bot token wrong, or chat id wrong.
- Run `pnpm exec tsx demo/add-skill.ts standup` — if that succeeds, your skill code has a bug; if it fails, your tokens are wrong.

### `kg-snapshot` returns empty

The gateway's KG is opening a different file than your `pnpm seed` writes to. Both should resolve `KG_DB_PATH` to the same absolute path. Set `KG_DB_PATH` to an absolute path in `.env`. The seed CLI also resolves to repo root via `import.meta.url` so it doesn't depend on cwd, but if you've set `KG_DB_PATH` it wins.

### Recovery monitor leaks timers

Should not happen — `RecoveryRegistry.stop()` clears the timer, and tests in [packages/incident/test/e2e.test.ts](../packages/incident/test/e2e.test.ts) assert this. If you change recovery.ts, run those tests.

### `pnpm test` hangs

Almost certainly a leaked timer or a never-resolving promise in a test. The `pr-realtime` and `incident` tests use `.unref()` on intentional long timers. If you copy-paste from those tests for a new skill, keep the unref.

### `better-sqlite3` install fails

Native binding compile failure. Install build tools:

- macOS: `xcode-select --install`
- Linux (Debian/Ubuntu): `sudo apt install build-essential python3`
- Windows: `npm install --global windows-build-tools` or just install Visual Studio Build Tools.

After installing, `rm -rf node_modules && pnpm install`.
