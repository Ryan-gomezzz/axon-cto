# Architecture

Four layers, in dependency order:

```
Layer 1 — Triggers       Heartbeat scheduler (cron) + Webhook receiver (HTTP)
Layer 2 — Routing        OpenClaw Gateway (Node daemon) + per-skill registration
Layer 3 — Cognition      LLM reasoning core ⟷ Knowledge graph
Layer 4 — Execution      Action layer (GitHub, shell) + Output layer (Telegram)
```

Read this before opening any specific package's source.

---

## Two entrypoints, one shared context

Everything Axon does begins one of two ways:

1. **A webhook arrives** — Sentry incident, GitHub PR. Hits Express in [packages/gateway/src/server.ts](../packages/gateway/src/server.ts).
2. **A cron fires** — morning brief at 8 AM IST, sprint risk at 9 AM, PR digest at 6 PM. All registered through the wrapper in [packages/gateway/src/scheduler.ts](../packages/gateway/src/scheduler.ts).

Both paths converge on the same `AppContext` built once at boot in [packages/gateway/src/main.ts](../packages/gateway/src/main.ts):

```ts
{ kg, telegram, queue, scheduler, log, env }
```

Every skill receives this context. Every log line carries `{ component, traceId }`. The traceId is generated at the trigger and propagates through the entire flow via `AsyncLocalStorage` ([packages/shared/src/trace.ts](../packages/shared/src/trace.ts)).

---

## Request flow: an incident, end-to-end

This is the path the demo lives or dies on. Track it stage by stage in [packages/incident/src/handler.ts](../packages/incident/src/handler.ts).

```
Sentry POST /webhook/sentry
   │
   │  packages/gateway/src/server.ts
   │  ┌──────────────────────────────┐
   │  │ raw-body capture             │  express.raw on /webhook/*
   │  │ HMAC verify                  │  crypto.timingSafeEqual
   │  │ Zod parse                    │  permissive at gateway, strict at skill
   │  │ generate traceId             │  AsyncLocalStorage
   │  │ enqueue { type:'incident' }  │  packages/gateway/src/queue.ts
   │  │ respond 200 in <2s           │  always 200, even if enqueue fails
   │  └──────────────────────────────┘
   │
   ▼
JobQueue worker (one per type, lazily spawned)
   │  packages/gateway/src/queue.ts
   │  withTrace(job.traceId, () => handler(job.payload, job.traceId))
   │
   ▼
@axon/incident.incidentJob
   │  packages/incident/src/handler.ts
   │  ┌──────────────────────────────┐
   │  │ T0: parseAndValidateSentry   │  packages/incident/src/ingest.ts
   │  │ T1: sentryToIncident (KG)    │  idempotent on event_id
   │  │ T2: enrichIncident           │  Promise.all over KG queries + Octokit
   │  │ T3: synthesizeIncidentResp.  │  streams Nemotron-70B; resolves at first chunk
   │  │       └─ telegram.send       │  packages/shared/src/telegram.ts
   │  │ logs stage timings           │  { stage_ingest_ms, stage_enrich_ms, ... }
   │  │ recovery.start (no await)    │  packages/incident/src/recovery.ts
   │  └──────────────────────────────┘
   │
   ▼
Background:
   ├─ continueStreaming → telegram.editMessage every 800ms → final edit + buttons
   └─ RecoveryRegistry → polls Sentry every 30s, stops on recovery or 10-min timeout
```

The handler **resolves at T3** (first chunk sent to Telegram). Everything after that runs in the background — the worker can pick up the next job, the gateway can keep serving webhooks.

---

## Package boundaries (no cycles)

```
                           ┌────────────┐
                           │  shared    │  Telegram, logger, env, trace
                           └─────┬──────┘
                                 │ (subpath exports)
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
        ┌─────────┐        ┌─────────┐        ┌─────────┐
        │   kg    │        │  brief  │        │incident │
        │  (moat) │        │         │        │         │
        └────┬────┘        └────┬────┘        └────┬────┘
             │                  │                  │
             ▼                  │                  │
        ┌─────────┐              │                  │
        │   pr    │              │                  │
        └────┬────┘              │                  │
             │                  │                  │
        ┌────▼────┐              │                  │
        │ sprint  │              │                  │
        └────┬────┘              │                  │
             └──────┐    ┌───────┘    ┌─────────────┘
                    │    │            │
                    ▼    ▼            ▼
                  ┌──────────────────────┐
                  │       gateway        │  imports every skill at boot
                  │     (entrypoint)     │
                  └──────────────────────┘
```

- **`gateway` is a leaf** — every other package can be imported into it. It imports the four skills (`@axon/brief`, `@axon/incident`, `@axon/pr`, `@axon/sprint`) only at boot, in [packages/gateway/src/main.ts](../packages/gateway/src/main.ts).
- **No skill imports another skill or `gateway`.** Each skill that needs to register against the gateway's queue/scheduler declares a duck-typed `QueueLike` or `SchedulerLike` interface locally — see e.g. [packages/incident/src/register.ts](../packages/incident/src/register.ts) and [packages/pr/src/register.ts](../packages/pr/src/register.ts). This is the only reason the import graph stays acyclic.
- **`shared` is a sink.** Everyone reads from it; it imports from no one inside the workspace. To keep test-time loading cheap, `env` and `logger` are *not* in the default barrel — pull them from subpaths: `import { env } from '@axon/shared/env'`. That way a test that wants `TelegramClient` doesn't trigger Zod env validation at module load.

---

## Layer 1 — Triggers

### Webhook receiver

Two routes, both validating HMAC against unparsed body bytes:

| Route | Header | Secret env |
|---|---|---|
| `POST /webhook/sentry` | `sentry-hook-signature` | `SENTRY_WEBHOOK_SECRET` |
| `POST /webhook/github` | `x-hub-signature-256` | `GITHUB_WEBHOOK_SECRET` |

`express.raw({ type: '*/*' })` is mounted on `/webhook` *before* `express.json()` so the raw bytes survive for HMAC validation. After validation, JSON is parsed and Zod-validated permissively (the per-skill packages enforce strict shapes).

The webhook handler **always returns 200 once the signature is valid.** If `queue.enqueue` throws (handler missing, queue full), it's logged and the response is still 200 — the alternative is the upstream service retrying, which doesn't help if the queue is genuinely overloaded.

### Heartbeat scheduler

Three crons, all in `Asia/Kolkata`:

| Name | Cron | Skill |
|---|---|---|
| `morning-brief` | `0 8 * * *` | `@axon/brief` |
| `sprint-risk` | `0 9 * * 1-5` | `@axon/sprint` |
| `pr-digest` | `0 18 * * 1-5` | `@axon/pr` |

Each fire generates a fresh `traceId` and runs the handler inside `withTrace(traceId, ...)`. Failures are caught and logged; one bad cron tick doesn't kill the daemon.

---

## Layer 2 — Routing

[packages/gateway/src/queue.ts](../packages/gateway/src/queue.ts) is the routing fabric:

- One `Map<jobType, JobHandler>` and one `Map<jobType, Job[]>`.
- `registerHandler(type, fn)` — called once per skill at boot.
- `enqueue(job)` — pushes; if no worker is running for that type, lazily spawns one.
- The worker drains its type's queue serially. **One worker per job type means types process in parallel; jobs of the same type are sequential.** That's intentional: incidents arrive bursty, but you don't want two simultaneous LLM calls racing the same Telegram conversation.
- Backpressure: `maxQueueSize` (default 1000) — `enqueue` throws when hit.
- Handler exceptions are logged and swallowed. The worker keeps running.
- `drain()` lets the SIGTERM path wait for in-flight jobs before closing the DB.

---

## Layer 3 — Cognition

The KG is the cognition layer's memory. The LLM is the cognition layer's voice. Every alert pulls a sentence out of the graph and asks the LLM to synthesize it — no graph, no demo.

See [knowledge-graph.md](knowledge-graph.md) for the schema and the five named queries.

LLM choice is per-tier:

- **`LLM_MODEL_INCIDENT`** — incident reasoning, causal synthesis. Default `nvidia/Llama-3.1-Nemotron-70B-Instruct-HF`. Streamed; first chunk to Telegram inside the 60-second SLA.
- **`LLM_MODEL_ROUTINE`** — morning brief, PR digest, sprint risk. Default `nvidia/Nemotron-Mini-4B-Instruct`. Streamed; total time budget ~15s.

Both are reached through the OpenAI-compatible SDK (`openai` package), pointed at `LLM_BASE_URL` (default Together.ai). See [decisions.md § Provider choice](decisions.md#provider-choice-nemotron-via-togetherai).

---

## Layer 4 — Execution

### Output: Telegram

[packages/shared/src/telegram.ts](../packages/shared/src/telegram.ts) is a thin client over the Bot API:

- `send(text, opts)` — auto-escapes MarkdownV2 (or `skipEscape` for pre-formatted), supports inline keyboards. Retries on 429 + 5xx + network errors (1 attempt + 3 retries with 500ms / 2s / 8s back-off). 4xx other than 429 surfaces immediately.
- `editMessage(ref, text, opts)` — same retry logic.
- `onCallback(handler)` — lazily starts polling via `node-telegram-bot-api` (the SDK is loaded with `createRequire` so non-callback consumers — and tests — never pull it into memory).

The retry policy is the demo's reliability story: the morning brief or incident message is allowed to retry-with-back-off on a Telegram blip, and 4xx errors don't loop forever.

### Action: GitHub

`@octokit/rest` is used in three places, each for a tightly-scoped read or write:

- **enrich.ts** (incident) — `repos.listCommits` over the last 4h to find recent deploys + the most recent committer (on-call inference).
- **realtime.ts** (pr) — `pulls.listFiles` for critical-path detection on `opened`/`synchronize`.
- **actions.ts** (incident) — `issues.listForRepo` then `issues.create` with the `axon-rollback` label, idempotent by SHA in title.

True PR-revert flow (generating a revert commit and opening a PR) is deferred. See [decisions.md § Rollback issues, not PRs](decisions.md#rollback-issues-not-prs).

---

## Boot sequence

[packages/gateway/src/main.ts](../packages/gateway/src/main.ts) — read top to bottom; the order matters:

1. Open KG (creates `data/axon.db` parent dir if missing).
2. Construct `TelegramClient`, `JobQueue`, `Scheduler` (all share the same logger).
3. Register placeholder queue handlers for `pr-realtime`, `github-event`, `brief` (the wired ones replace these).
4. Build `briefCtx` → `registerMorningBrief` → schedules the 8 AM cron.
5. Build `incidentCtx` → `registerIncidentHandlers` → registers the `incident` queue handler **and** the Telegram callback router. Returns the `RecoveryRegistry` so SIGTERM can stop active monitors.
6. Build `prCtx` → `registerPRHealth` → registers the `pr-realtime` queue handler **and** schedules the 6 PM cron.
7. Build `sprintCtx` → `registerSprintRisk` → schedules the 9 AM cron.
8. `createApp(ctx)` → wires routes onto Express.
9. `scheduler.announce()` — log every registered cron + timezone.
10. `app.listen(env.PORT)` — log "gateway listening" with the registered job types.

The boot log is the receipt: if any of those steps is missing, the demo will fail. See [operations.md § Verifying a clean boot](operations.md#verifying-a-clean-boot).

---

## Shutdown

`SIGTERM` and `SIGINT` both call the same handler:

```
1. close http server
2. scheduler.stop()              — stop firing crons
3. recovery.stopAll()            — clear every active polling timer
4. queue.drain()                 — wait for in-flight jobs (no new ones; http is closed)
5. telegram.stopPolling()        — close the bot polling driver
6. db.close()                    — release the SQLite handle
7. process.exit(0)
```

Idempotent on repeat signals (a flag prevents double-shutdown).

---

## Test architecture

Each package has its own `test/` directory; vitest runs in band per package via `pnpm -r test`.

- **Pure unit tests** — score formulas, schema parsers, escape helpers. ~60% of the 127 tests.
- **KG-backed tests** — open `:memory:` SQLite, seed it, exercise the named queries. The seed function is exported from `@axon/kg` for exactly this reason.
- **Mocked-IO tests** — Octokit / fetch / OpenAI / Telegram are all injectable via context (`ctx.octokit`, `ctx.fetch`, `ctx.openaiClient`, deps.client) or `vi.mock('openai', …)` in the four cases where mocking the module is cleaner than DI.
- **Fake-timer e2e** — `packages/incident/test/e2e.test.ts` runs the full pipeline under `vi.useFakeTimers()` and asserts the first Telegram message ships in virtual elapsed `< 60_000ms`. That's the SLA the demo lives on.

127 tests, ~3 seconds total wallclock. Run before every commit.
