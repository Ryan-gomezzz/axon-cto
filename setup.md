# Axon — Setup & Operations Guide

> A practical, top-to-bottom guide for getting Axon running and keeping it running.
> **Estimated time end-to-end (with all credentials in hand):** 30 minutes.

---

## Quick Reference (1-screen)

- **Prereqs:** Node 20+, pnpm 8+, build tools, ~30 min, ~$5 of Together.ai credit.
- **Total commands you'll run:** ~10 to first green Telegram message.
- **Smoke-test one-liner (after `.env` is set):**
  ```bash
  pnpm install && pnpm seed && pnpm typecheck && pnpm test
  ```
- **Hot URLs once running:**
  - `http://localhost:3030/healthz` — liveness
  - `http://localhost:3030/demo/kg-snapshot` — KG state for the viz
  - `http://localhost:3030/webhook/sentry` and `/webhook/github` — public-facing via ngrok

---

## Pre-flight checklist

Before you start cloning, gather these. Most failures during install come from missing items here, not from the code.

- [ ] Node 20+ installed
- [ ] pnpm 8+ installed
- [ ] Build tools for `better-sqlite3`'s native binding (per OS — see Part 1)
- [ ] A Together.ai account with ~$5 credit
- [ ] A Telegram account, plus a *dedicated* bot created via @BotFather
- [ ] A GitHub Personal Access Token (fine-grained or classic, with `repo` scope)
- [ ] One GitHub repo you can point Axon at (your own staging fork is fine)
- [ ] *(Optional)* A Sentry project for real incident webhooks
- [ ] *(Optional)* A Linear workspace + API key

---

## Part 1 — Prerequisites

### 1.1 Node 20+

Axon uses ESM-only modules and modern TypeScript features that require Node 20+.

```bash
# Check your Node version
node -v
```

Expected:

```
v20.11.1
```

(or any v20.x / v22.x)

> **If this fails:** install Node from [nodejs.org](https://nodejs.org/) or via `nvm install 20 && nvm use 20`.

### 1.2 pnpm 8+

The repo uses pnpm workspaces. npm and yarn will not work.

```bash
# Check pnpm
pnpm -v
```

Expected:

```
8.15.4
```

> **If this fails:** install with `npm install -g pnpm` or `corepack enable && corepack prepare pnpm@latest --activate`.

### 1.3 Build tools (for `better-sqlite3`)

The KG package compiles a native SQLite binding during install. This needs a working C/C++ toolchain. **macOS:**

```bash
xcode-select --install
```

**Linux (Debian/Ubuntu):**

```bash
sudo apt update && sudo apt install -y build-essential python3
```

**Windows:**

```powershell
npm install -g windows-build-tools
# or install Visual Studio 2022 Build Tools (C++ workload) manually
```

> **If this fails:** the symptom appears later as `gyp ERR! find Python` or `gcc: command not found` during `pnpm install`. Re-run after installing the toolchain.

### 1.4 Git

```bash
git --version
```

Expected: any recent version (`git version 2.x`).

### 1.5 A web browser

For viewing `demo/kg-viz/index.html` during the demo. Any modern Chromium / Firefox / Safari works.

---

## Part 2 — Acquire credentials

This is the real bottleneck for a first-time setup. Knock all these out *before* touching the code; copy each value into a scratchpad as you go.

| Credential | How to get it | `.env` key |
|---|---|---|
| **Together.ai API key** | Sign up at [api.together.ai](https://api.together.ai) → Settings → API Keys → top up ~$5 of credit | `LLM_API_KEY` |
| **Telegram bot token** | DM [@BotFather](https://t.me/BotFather) in Telegram → `/newbot` → choose a name and username | `TELEGRAM_BOT_TOKEN` *(use a dedicated demo bot)* |
| **Telegram chat id** | Send your new bot a message, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the integer `chat.id` from the JSON | `TELEGRAM_CHAT_ID` |
| **GitHub PAT** | [github.com/settings/tokens](https://github.com/settings/tokens) → fine-grained or classic with `repo` + `issues:write` scopes | `GITHUB_TOKEN` |
| **GitHub org + repo to watch** | Any repo you have access to (your own staging fork is fine) | `GITHUB_ORG`, `GITHUB_REPO` |
| **Sentry webhook secret** | Generate locally (see below) — **same value** goes into Sentry's webhook config | `SENTRY_WEBHOOK_SECRET` |
| **GitHub webhook secret** | Same generator, **separate value** | `GITHUB_WEBHOOK_SECRET` *(different from `GITHUB_TOKEN`!)* |
| **Linear API key** *(optional)* | [linear.app/settings/api](https://linear.app/settings/api) — fetcher degrades cleanly without | `LINEAR_API_KEY` |

> 📸 *Insert screenshot: BotFather conversation showing `/newbot` flow with the resulting token.*

### 2.1 Generate webhook secrets

Don't skip this and use a placeholder string — webhook validation will fail with cryptic 401s.

```bash
# Generate two independent 32-byte hex secrets, one for Sentry, one for GitHub
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Expected output (yours will differ):

```
3a8f4c2e1b9d7a6f5c4e3b2a1d8f7e6c5b4a3d2e1f8c7b6a5d4e3c2b1a9f8e7d
6c5b4a3d2e1f8c7b6a5d4e3c2b1a9f8e7d3a8f4c2e1b9d7a6f5c4e3b2a1d8f7e
```

Use the first for `SENTRY_WEBHOOK_SECRET`, the second for `GITHUB_WEBHOOK_SECRET`. Keep both — you'll paste them into the respective webhook configs in Part 9.

> **If this fails:** Node isn't on `PATH`. Re-check Part 1.

### 2.2 Find your Telegram chat id

After you've created the bot and sent it any message, run:

```bash
# Replace <TOKEN> with the token from BotFather
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

Look for `"chat":{"id":12345678,...}` in the JSON. That integer is your `TELEGRAM_CHAT_ID`.

> **If this fails:** you haven't messaged the bot yet. Send it a `/start` first, then re-run.

---

## Part 3 — Clone & install

```bash
# Clone the repo and enter it
git clone <repo-url> axon-cto
cd axon-cto

# Install all workspace deps (this triggers the better-sqlite3 native build)
pnpm install
```

Expected output:

```
Lockfile is up to date, resolution step is skipped
Progress: resolved 360, reused 360, downloaded 0, added 360, done

devDependencies:
+ typescript 5.4.5
+ tsx 4.7.2
+ vitest 1.6.0
...
Done in 18.3s
```

The exact package count and timing varies — anywhere from 350-400 packages and 15-30s on a warm cache.

> **If this fails:** the most common cause is missing build tools — see Part 1.3. Look for `node-gyp` errors in the output. If you see them, install the toolchain and re-run `pnpm install`.

---

## Part 4 — Configure `.env`

```bash
# Copy the template
cp .env.example .env

# Open in your editor
$EDITOR .env
```

Walk through each variable, top to bottom.

### Required

| Variable | What goes here |
|---|---|
| `LLM_API_KEY` | Your Together.ai key from §2 |
| `LLM_BASE_URL` | `https://api.together.xyz/v1` (default; leave alone) |
| `LLM_MODEL_INCIDENT` | `nvidia/Llama-3.1-Nemotron-70B-Instruct-HF` (default) |
| `LLM_MODEL_ROUTINE` | `nvidia/Nemotron-Mini-4B-Instruct` (default) |
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_CHAT_ID` | Your integer chat id from §2.2 |
| `GITHUB_TOKEN` | Your PAT |
| `GITHUB_ORG` | The org or user that owns the repo to watch |
| `GITHUB_REPO` | The repo name (without org prefix) |
| `SENTRY_WEBHOOK_SECRET` | First hex string from §2.1 |
| `GITHUB_WEBHOOK_SECRET` | Second hex string from §2.1 — **not** the same as `GITHUB_TOKEN` |

### Strongly recommended

| Variable | What goes here |
|---|---|
| `KG_DB_PATH` | **Use an absolute path**, e.g., `/Users/you/code/axon-cto/data/axon.db`. See callout below. |
| `LOG_FILE` | `data/gateway.log` — required for `demo/fire-webhook.ts` to read SLA timing |
| `PORT` | `3030` if port 3000 is taken on your machine; else leave default `3000` |

> 💡 **`KG_DB_PATH` should be an absolute path.** If it's relative, the seed CLI and the gateway can resolve to *different files* because they run with different cwds. The symptom is "I seeded but the gateway sees an empty graph." Use absolute and skip the headache.

### Optional

| Variable | What goes here |
|---|---|
| `LINEAR_API_KEY` | Skip if you don't use Linear — the brief fetcher degrades cleanly |
| `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` | Only needed if you want the recovery monitor to query Sentry for resolution |
| `TELEGRAM_ESCALATION_CHAT_ID` | Secondary chat for the [Escalate] button; defaults to `TELEGRAM_CHAT_ID` |

> 💡 **`tsx watch` does not reload `.env`.** Editing `.env` after `pnpm dev` is running has no effect — restart the gateway manually after any change.

> **If this fails:** if you see `Invalid environment configuration` at boot, Zod will list every key that's missing or empty. Read the error, fix the listed keys, restart.

---

## Part 5 — Seed the knowledge graph

The KG starts empty. Seed it once with realistic demo data: 3 services, 10 engineers, 22 PRs, 6 incidents (3 recurring on auth-service — that's what powers the canonical demo sentence).

```bash
# Wipe + recreate the SQLite DB at KG_DB_PATH
pnpm seed
```

Expected output:

```
[seed] opening db: /Users/you/code/axon-cto/data/axon.db
[seed] migrations applied
[seed] inserting nodes: services, engineers, sprints, prs, incidents, deploys, decisions
[seed] inserting edges: AUTHORED, TOUCHES, RESOLVES, INFORMED, CAUSED_BY, DEPLOYED, BLOCKS

=== KG dump ===
Nodes: 52  (Engineer: 10, PR: 22, Incident: 6, Service: 3, Sprint: 2, Decision: 3, Deploy: 6)
Edges: 65  (AUTHORED: 22, TOUCHES: 16, RESOLVES: 4, INFORMED: 3, CAUSED_BY: 6, DEPLOYED: 6, BLOCKS: 8)

Total: 52 nodes, 65 edges

✓ Seed complete: inserted 52 nodes and 65 edges into /Users/you/code/axon-cto/data/axon.db
```

> **If this fails:** if the path printed at the top doesn't match what you set in `.env`, your `KG_DB_PATH` is being resolved relatively. Set it to an absolute path and re-run.

---

## Part 6 — Boot the gateway

Open a dedicated terminal and start the daemon. Leave it running for the rest of this guide; you'll run other commands in a *second* terminal.

```bash
# Boot the Express gateway, scheduler, queue, and Telegram client
pnpm dev
```

Expected output (timestamps will differ):

```
[18:42:01] INFO  (gateway): env loaded, log_file=data/gateway.log
[18:42:01] INFO  (gateway): kg opened db=/Users/you/code/axon-cto/data/axon.db nodes=52 edges=65
[18:42:01] INFO  (gateway): telegram client ready bot_id=8123456789
[18:42:01] INFO  (scheduler): registered cron job=morning-brief expr="0 8 * * *" tz=Asia/Kolkata
[18:42:01] INFO  (scheduler): registered cron job=pr-digest expr="0 18 * * 1-5" tz=Asia/Kolkata
[18:42:01] INFO  (scheduler): registered cron job=sprint-risk expr="0 9 * * 1-5" tz=Asia/Kolkata
[18:42:01] INFO  (queue): registered_jobs=['github-event','brief','incident','pr-realtime']
[18:42:01] INFO  (gateway): listening port=3030
```

> 💡 You'll see occasional `polling_error` lines from `node-telegram-bot-api`. These are normal noise from the long-poll driver — ignore unless they're sustained for >30s.

> **If this fails:** if boot stops at `Invalid environment configuration`, see Part 4. If the gateway exits silently, check `data/gateway.log` for the underlying error.

---

## Part 7 — Verify the gateway

In your **second terminal**, run two curls.

### 7.1 Health check

```bash
# Liveness — should return immediately
curl http://localhost:3030/healthz
```

Expected:

```
{"status":"ok","uptime":42}
```

(`uptime` is whatever number of seconds the gateway has been alive.)

### 7.2 KG snapshot

```bash
# Confirm the gateway is reading the seeded graph
curl http://localhost:3030/demo/kg-snapshot | head -c 200
```

Expected (truncated to first 200 bytes):

```
{"nodes":[{"id":"svc-auth","type":"Service","name":"auth-service",...},{"id":"svc-payments","type":"Service",...
```

The response should contain real nodes and edges, not empty arrays.

> **If this fails:** if `nodes: []` comes back, the gateway is reading a different SQLite file than the seed wrote to. Stop the gateway, set `KG_DB_PATH` to an **absolute** path in `.env`, re-run `pnpm seed`, then `pnpm dev`.

---

## Part 8 — Trigger each skill

Six numbered triggers, in order from "no external dependencies" to "full pipeline." Each should produce a Telegram message in your dev chat. After running all six, you've proven the full system end-to-end.

### 8.1 Standup (no LLM, no GitHub API — fastest signal)

```bash
# In your second terminal, trigger the live extensibility flex
pnpm exec tsx demo/add-skill.ts standup
```

Expected console:

```
[standup] reading kg…
[standup] formatting…
[standup] sending to telegram…
✓ Standup delivered in 1.34s
```

Expected in Telegram: a multi-line standup with sections like *"Yesterday's merges,"* *"Open PRs,"* and *"Active blockers,"* with engineer names resolved through the KG.

> **If this fails:** the most common cause here is `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` being wrong. Test directly: `curl "https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>&text=hi"`.

### 8.2 Sprint risk

```bash
# Trigger the sprint risk digest
pnpm exec tsx packages/sprint/src/cli/run-now.ts
```

Expected console:

```
[sprint-risk] computing score for sprint=current
[sprint-risk] score=42 breakdown={blocker:18, velocity:12, scope:8, time:4, systemic:0}
[sprint-risk] synthesizing via Nemotron-Mini…
✓ Sprint risk digest delivered in 4.8s
```

Expected in Telegram: a 4-line digest with a numeric risk score (0-100) and 3 contributing factors named in prose.

> **If this fails:** if you see `401 Invalid API key` from Together, your `LLM_API_KEY` is wrong or the account has no credit.

### 8.3 Morning brief

```bash
# Trigger the daily exec brief
pnpm exec tsx packages/brief/src/cli/run-now.ts
```

Expected console:

```
[brief] fetching: github(prs), linear(blockers), sentry(errors), kg(patterns)
[brief] github: 7 prs · linear: 2 blockers · sentry: 0 errors · kg: 3 patterns
[brief] synthesizing via Nemotron-Mini…
✓ Morning brief delivered in 6.2s
```

Expected in Telegram: a 5-bullet executive summary. **The leading bullet should be KG-grounded** — it should mention auth-service, the recurring pattern, an engineer name (Aditi), or "3rd this month."

> 💡 If the leading bullet is generic (no KG content), the synthesize prompt is dropping the `<patterns>` section. Verify with `grep '<patterns>' data/gateway.log` after the run.

> **If this fails:** if Linear errors out, that's expected when `LINEAR_API_KEY` is unset — the brief degrades to 4 bullets. If GitHub errors with `403`, check your PAT scope.

### 8.4 PR digest

```bash
# Trigger the 6 PM PR digest
pnpm exec tsx packages/pr/src/cli/run-now.ts
```

Expected console:

```
[pr-digest] pulling open prs from <org>/<repo>
[pr-digest] found 4 open · 1 critical-path · 2 stale
[pr-digest] cross-referencing kg engineer load
[pr-digest] synthesizing via Nemotron-Mini…
✓ PR digest delivered in 5.1s
```

Expected in Telegram: a 3-section digest — *"Open Critical PRs,"* *"Reviewer Bottlenecks,"* *"Stale PRs (>7d)."*

> 💡 If `GITHUB_REPO` has zero open PRs, sections render as `* (none)` — the digest still ships. To see real content, open one PR in the watched repo first.

> **If this fails:** `404 Not Found` from GitHub means `GITHUB_ORG` or `GITHUB_REPO` is wrong, or your PAT can't see the repo.

### 8.5 Synthetic incident — the full pipeline

This is the showstopper. End-to-end webhook → enrich → synthesize → stream → Telegram, with the SLA gate.

```bash
# Fire a synthetic auth-service Sentry event against the gateway
pnpm exec tsx demo/fire-webhook.ts
```

Press any key when prompted. Within ~60s, a Telegram alert lands.

Expected console:

```
[fire-webhook] press any key to fire…
[fire-webhook] POST http://localhost:3030/webhook/sentry
[fire-webhook] gateway acked in 184ms
[fire-webhook] watching log for incident_id=inc-7a2b…
[fire-webhook] T1 sentryToIncident:    87ms
[fire-webhook] T2 enrichIncident:     412ms
[fire-webhook] T3 synthesize.firstChunk: 4.2s
[fire-webhook] SLA <60s: PASSED (4.9s)
```

Expected in Telegram: an alert with the canonical structure — causal chain, recurring-incident pattern call-out (*"3rd auth-service incident this month"*), open ADR mention, on-call engineer line, and inline keyboard `[[Rollback], [Acknowledge, Escalate]]`.

> 💡 **Together.ai's first call to a 70B model can take 8-10s to warm up.** Fire one webhook as a warmup, ignore the timing, then fire the real one. Subsequent calls land in 2-5s.

> **If this fails:** if SLA fails, the slowest stage is in the breakdown — usually `synthesize.firstChunk` on cold-start. If the alert never arrives at all, grep the gateway log: `grep '"jobType":"incident"' data/gateway.log`.

### 8.6 Tap [Rollback]

In Telegram, tap the **[Rollback]** button on the incident alert.

Expected: a reply lands in the same chat thread containing a GitHub Issue URL. The issue has:
- Label `axon-rollback`
- Title `Revert deploy <short-sha>`
- Body summarizing the incident and the deploy SHA being reverted

Expected in the gateway log:

```
[18:51:14] INFO  (incident): callback received button=rollback incident=inc-7a2b
[18:51:14] INFO  (incident): creating revert issue org=<org> repo=<repo>
[18:51:15] INFO  (incident): revert issue created url=https://github.com/<org>/<repo>/issues/47
```

> **If this fails:** if the button does nothing, either the bot's long-poll loop isn't running (look for `polling_error` repeating in the log) or the GitHub PAT lacks `issues:write`. Test PAT scope with `curl -H "Authorization: token <PAT>" https://api.github.com/repos/<org>/<repo> | jq .permissions`.

---

## Part 9 — Going live with webhooks

The CLIs in Part 8 cover everything you need for demos. To handle *real* incidents and PR events from external systems, you need a public URL fronting your local gateway. Use ngrok for dev.

### 9.1 Start ngrok

```bash
# Expose local port 3030 to a public https URL
ngrok http 3030
```

Expected:

```
Session Status     online
Forwarding         https://a7c4-203-0-113-42.ngrok-free.app -> http://localhost:3030
```

Copy the `https://...ngrok-free.app` URL. You'll paste it into Sentry and GitHub.

> 💡 The ngrok URL changes every restart. If you stop and restart ngrok, you must update both webhook configs.

> **If this fails:** install ngrok from [ngrok.com/download](https://ngrok.com/download) and run `ngrok config add-authtoken <token>` once.

### 9.2 Sentry webhook

In Sentry: **Project → Alerts → Create Alert → Issue Alert**.

| Field | Value |
|---|---|
| Action | *Send a notification to a webhook* |
| URL | `https://<ngrok>.ngrok-free.app/webhook/sentry` |
| Secret | The same value as `SENTRY_WEBHOOK_SECRET` in `.env` |
| Trigger condition | *Any error event* (or scope to `auth-service` for the demo) |

Test by triggering an error in your Sentry-instrumented app. Within 60s, an Axon alert lands in Telegram.

> 📸 *Insert screenshot: Sentry alert config showing webhook URL and secret fields.*

> **If this fails:** if Sentry shows the webhook firing but Telegram is silent, the gateway is rejecting the HMAC. Restart the gateway *after* setting `SENTRY_WEBHOOK_SECRET` (Zod loads `.env` once at boot).

### 9.3 GitHub webhook

In the watched repo: **Settings → Webhooks → Add webhook**.

| Field | Value |
|---|---|
| Payload URL | `https://<ngrok>.ngrok-free.app/webhook/github` |
| Content type | `application/json` |
| Secret | The same value as `GITHUB_WEBHOOK_SECRET` |
| Events | *Pull requests* (only — don't subscribe to everything) |

Test by opening a PR that touches a critical path (anything matching `packages/auth/**`, `packages/payments/**`, or any glob in `CRITICAL_PATHS`). A Telegram alert lands sub-second.

> **If this fails:** GitHub's webhook delivery panel shows the response code. A 401 means HMAC mismatch (re-check `GITHUB_WEBHOOK_SECRET`). A 200 with no Telegram message means the file-path filter didn't match — verify your PR touches a critical path.

---

## Part 10 — Day-to-day operation

### 10.1 Restart cleanly

In the gateway terminal, hit `Ctrl-C`. Expected sequence in the log:

```
[shutdown] received SIGINT
[shutdown] http server closed
[shutdown] scheduler stopped
[shutdown] recovery monitors stopped (0 active)
[shutdown] queue drained
[shutdown] telegram polling stopped
[shutdown] kg db closed
[shutdown] exit 0
```

Repeat signals are idempotent — pressing `Ctrl-C` twice doesn't break anything.

> **If this fails:** if shutdown hangs >5s, an in-flight job is blocking. The gateway will force-exit after 10s.

### 10.2 Read logs

The gateway writes JSON to stdout *and* to `LOG_FILE`. For pretty live logs:

```bash
# Stream stdout pretty-printed
pnpm dev | pnpm exec pino-pretty
```

For the log file:

```bash
# Tail the log file
tail -f data/gateway.log | pnpm exec pino-pretty
```

### 10.3 Find a specific request's logs

Every request and cron fire emits a `traceId`. Grep:

```bash
# Replace with a real trace id from a Telegram footer or webhook response header
grep '"traceId":"t-1234abcd"' data/gateway.log | pnpm exec pino-pretty
```

Trace IDs surface in three places:
- `x-trace-id` response header on every webhook ack
- The footer of every Telegram message Axon sends
- Every log line emitted while handling that request

### 10.4 Re-seed the graph

Safe to run anytime — wipes and recreates.

```bash
pnpm seed
```

The gateway sees the new state on its next KG read (no restart needed for read paths; cached references are minimal).

### 10.5 Run the full test suite

```bash
# All 127 tests across 7 packages, ~3s wallclock
pnpm test
```

Expected last line:

```
Test Files  18 passed (18)
     Tests  127 passed (127)
```

### 10.6 Typecheck without running

```bash
pnpm typecheck
```

Expected: silent exit code 0.

### 10.7 Trigger any skill manually

For demo prep or smoke tests, all 5 CLIs from Part 8 are runnable on demand. Bookmark:

```bash
pnpm exec tsx demo/add-skill.ts standup
pnpm exec tsx demo/fire-webhook.ts
pnpm exec tsx packages/brief/src/cli/run-now.ts
pnpm exec tsx packages/pr/src/cli/run-now.ts
pnpm exec tsx packages/sprint/src/cli/run-now.ts
```

---

## Part 11 — Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Invalid environment configuration` at boot | `.env` missing keys or has empty required values | Read the Zod error — it lists every missing key. Fix and restart. |
| Webhook returns 401 | HMAC mismatch (often: `.env` edited *after* gateway started, or whitespace in the secret) | Restart the gateway. Confirm the secret in `.env` matches what Sentry/GitHub is sending. |
| Telegram silent during a CLI run | Wrong bot token or chat id | Test directly: `curl "https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>&text=test"`. |
| `401 Invalid API key` from Together | Wrong `LLM_API_KEY` or no credit | Generate a fresh key on api.together.ai; check account balance. |
| Webhook acks 200 but no incident appears | Gateway opened a different KG file than the seed wrote to | Use absolute `KG_DB_PATH` in `.env`. Re-seed. Restart. |
| `tsx watch` ignored my `.env` change | By design — `tsx watch` doesn't reload dotfiles | Stop the gateway and re-run `pnpm dev`. |
| Incident SLA misses 60s on first fire | Together.ai 70B cold-start | Re-fire — warm calls land in 2-5s. Treat the first fire as a warmup. |
| Rollback button does nothing | Bot polling stopped, or `GITHUB_TOKEN` lacks `issues:write` | Check log for repeated `polling_error`; verify PAT scope per §8.6. |
| `better-sqlite3` install fails | Missing build tools | Per-OS install instructions in §1.3. |
| Port 3000 already in use | Something else owns it | Set `PORT=3030` (or any free port) in `.env`. Restart. |
| Brief leading bullet isn't KG-grounded | Synthesize prompt is dropping the `<patterns>` section | Verify with `grep '<patterns>' data/gateway.log`. If absent, the fetcher returned no patterns — re-seed. |
| Recovery monitor never sends "resolved" | `SENTRY_AUTH_TOKEN` unset, monitor can't poll | Set the token, or accept the 10-minute fallback (monitor self-resolves after the timeout). |
| Telegram messages render with `_*[]` literals | MarkdownV2 escaping broke | Look for `escapeMarkdownV2` in the trace; usually a payload contains a special char that wasn't escaped at the right boundary. |

---

## You're ready when…

- [ ] `pnpm dev` boots cleanly with three crons registered
- [ ] `curl localhost:<PORT>/healthz` returns `{"status":"ok"}`
- [ ] `curl localhost:<PORT>/demo/kg-snapshot` returns real nodes/edges
- [ ] `pnpm exec tsx demo/add-skill.ts standup` makes a Telegram message land
- [ ] `pnpm exec tsx demo/fire-webhook.ts` produces an incident alert in <60s
- [ ] Tapping `[Rollback]` in Telegram creates a GitHub issue
- [ ] `pnpm test` reports 127 passing

When all seven boxes are checked, you have a working Axon and a demoable system.

---

## Where to read more

- **`docs/architecture.md`** — how the four layers fit together, why each one exists
- **`docs/operations.md`** — full env-var reference, log structure, shutdown semantics, queue model
- **`docs/decisions.md`** — the "why" log (why typed graph not vectors, why SQLite not Postgres, why Together not OpenAI)
- **`demo/README.md`** — the 90-second demo arc and presenter pre-flight

---

*Last updated: keep in lockstep with `.env.example`. If you add an env var, add a row to Part 4.*