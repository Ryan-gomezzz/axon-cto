# Axon — Claude Code Prompt Sequence

> Execution order matters. Each prompt assumes the previous prompts have completed and tests pass. Do **not** skip ahead.
>
> Pair this file with `CLAUDE.md` in the repo root. Every prompt below assumes Claude Code has read CLAUDE.md.

---

## How to use this document

1. Place `CLAUDE.md` at the repo root **before** running Prompt 0.
2. Run prompts in numbered order. Each in a **fresh Claude Code session** unless noted otherwise.
3. After each prompt, run the **Verification** block. Do not proceed if anything fails.
4. If a prompt's output is wrong, do not "fix it up" with a follow-up message. Reset, refine the prompt, re-run.
5. Commit after every successful prompt with the message `phase N: <name>`.

**Time budget (relative):** 0 → 5%, 1 → 25%, 2 → 10%, 3 → 15%, 4 → 30%, 5 → 8%, 6 → 5% (cuttable), 7 → 5%.

---

## Pre-flight Checklist

Before Prompt 0:

- [ ] Node 20+ installed (`node -v`)
- [ ] pnpm installed (`pnpm -v`)
- [ ] An empty git repo initialized
- [ ] `CLAUDE.md` placed at repo root
- [ ] Accounts and tokens ready:
  - [ ] Anthropic API key
  - [ ] Telegram bot token (create via @BotFather — make a *separate demo bot* and *dev bot*)
  - [ ] Your Telegram chat ID
  - [ ] GitHub personal access token (repo + admin:org_hook scopes)
  - [ ] Sentry webhook secret (or generate a placeholder for offline dev)
  - [ ] Linear API key
- [ ] A staging GitHub repo to test webhook firing against
- [ ] A test Sentry project for webhook firing

---

# Prompt 0 — Repo Scaffold

**Time:** ~15 minutes including verification.
**Prereqs:** Pre-flight checklist complete.

### The prompt

```
Read CLAUDE.md. We are in Phase 0: Scaffold.

Set up a TypeScript pnpm-workspace monorepo for the Axon project. Do exactly the following:

1. Create pnpm-workspace.yaml with packages: 'packages/*'.

2. Create a root package.json with:
   - name "@axon/root", private true, type "module"
   - scripts:
     - dev: "pnpm --filter @axon/gateway dev"
     - test: "pnpm -r test"
     - typecheck: "pnpm -r typecheck"
     - seed: "pnpm --filter @axon/kg seed"
     - build: "pnpm -r build"
   - devDependencies (latest): typescript, tsx, vitest, @types/node, pino-pretty

3. Create tsconfig.base.json with:
   - target ES2022, module NodeNext, moduleResolution NodeNext
   - strict true, noUncheckedIndexedAccess true, exactOptionalPropertyTypes true
   - esModuleInterop true, skipLibCheck true
   - declaration true, sourceMap true

4. Create these workspace packages, each with package.json (name @axon/<pkg>, type module, main dist/index.js, scripts test/typecheck/build), tsconfig.json extending the base, src/index.ts with a placeholder export, and test/smoke.test.ts with one passing test:
   - shared
   - kg
   - gateway
   - brief
   - incident
   - pr
   - sprint

5. Install runtime deps in the appropriate packages:
   - shared: zod, pino, node-telegram-bot-api, @types/node-telegram-bot-api
   - kg: better-sqlite3, @types/better-sqlite3, zod
   - gateway: express, @types/express, node-cron, @types/node-cron
   - brief, incident, pr, sprint: @anthropic-ai/sdk, @octokit/rest

6. Create .env.example at repo root with these keys (no values):
   ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
   GITHUB_TOKEN, GITHUB_ORG, GITHUB_REPO,
   SENTRY_WEBHOOK_SECRET, LINEAR_API_KEY,
   KG_DB_PATH (default ./data/axon.db),
   PORT (default 3000), LOG_LEVEL (default info), NODE_ENV (default development)

7. Add .gitignore: node_modules, dist, .env, data/*.db, *.log, coverage.

8. Create a packages/shared/src/env.ts that loads dotenv from repo root and exports a Zod-validated env object. Export a typed Env type. Throw on missing required vars at startup.

9. Create a packages/shared/src/logger.ts with a pino instance configured from env.LOG_LEVEL.

After scaffolding, run `pnpm install`, `pnpm typecheck`, and `pnpm test`. All three must succeed. Report any failures.

Do not implement any business logic. Do not create files outside the structure above.
```

### Verification

```bash
pnpm install              # exits 0
pnpm typecheck            # exits 0, no errors
pnpm test                 # all smoke tests pass
ls packages/              # 7 directories
cat .env.example          # all keys present
```

Open `.env.example` and copy it to `.env`. Fill in your real tokens. Then commit:

```bash
git add -A && git commit -m "phase 0: scaffold"
```

### If it fails

- **Workspace deps not resolving:** delete `node_modules` and lockfile, re-run `pnpm install`.
- **TS errors in smoke tests:** the prompt's import path is wrong; adjust and re-run typecheck only.
- **better-sqlite3 native build fails:** install build tools (`xcode-select --install` on macOS, `apt install build-essential python3` on Linux).

---

# Prompt 1 — Knowledge Graph (the moat)

**Time:** ~2 hours, including 2-3 iteration rounds. **Do not rush this.**
**Prereqs:** Phase 0 complete and committed.

> This is the most important prompt in the entire build. Take time to verify the output matches the schema in CLAUDE.md exactly. If you only get one prompt right, make it this one.

### The prompt

```
Read CLAUDE.md, especially the "Knowledge Graph Schema" section. We are in Phase 1: KG.

Implement the @axon/kg package. The schema, node types, edge types, and 5 traversal queries are all locked in CLAUDE.md — use them verbatim. Do not rename, add, or repurpose types.

Files to create in packages/kg/src/:

1. schema.ts
   - Zod schemas for each NodeType payload (Engineer, PR, Incident, Service, Sprint, Decision, Deploy)
   - Zod schemas for Edge (source_id, target_id, edge_type, created_at, metadata?)
   - Discriminated union Node = { id, type, created_at, ...payload }
   - Export inferred TS types

2. db.ts
   - openDb(path: string): Database — opens better-sqlite3, runs migrations
   - Migrations create tables: nodes (id PRIMARY KEY, type TEXT, created_at INTEGER, payload TEXT JSON), edges (id PRIMARY KEY, source_id, target_id, edge_type, created_at, metadata TEXT JSON)
   - Indexes:
     - CREATE INDEX idx_nodes_type ON nodes(type)
     - CREATE INDEX idx_edges_source ON edges(source_id, edge_type)
     - CREATE INDEX idx_edges_target ON edges(target_id, edge_type)
   - Use WAL mode (PRAGMA journal_mode = WAL)
   - Use synchronous = NORMAL

3. graph.ts
   - class KnowledgeGraph with constructor(db)
   - Methods:
     - addNode(node): string — validates with Zod, returns id
     - addEdge(edge): string — validates, throws if source/target nodes don't exist
     - getNode<T extends NodeType>(id, expectedType?): typed Node or null
     - getEdges(nodeId, direction: 'out'|'in'|'both', edgeTypes?): Edge[]
     - traverse(startId, edgeTypes, maxDepth): Node[] — BFS, deduplicates, respects depth
   - Plus the 5 named queries from CLAUDE.md, each with the exact signature listed there
   - Each query must use parameterized SQL, never string concatenation
   - Each query must complete in <50ms on the seed dataset

4. dump.ts
   - kgDump(kg): string — ASCII representation. Sections per node type (count + first 3), then edges grouped by type. Useful for debugging at 2 AM.

5. seed.ts
   - Run as a CLI: `tsx src/seed.ts`
   - Reads KG_DB_PATH from env
   - Wipes the DB if present
   - Inserts:
     - 3 Services: auth-service (critical), payments-service (critical), notifications-service (standard)
     - 8 Engineers: realistic names, varied loads
     - 15 PRs: distributed across engineers, ~half merged, ~half open, files_changed referencing real-looking paths
     - 6 Incidents:
       - 3 on auth-service across the last 30 days (RECURRING — this is for the demo)
       - 2 on payments-service
       - 1 on notifications-service
       - At least 2 with non-null root_cause
     - 4 Deploys: each linked CAUSED_BY to one incident, DEPLOYED by an engineer, TOUCHES a service
     - 3 Decisions (ADRs): 1 status='open' (for demo), 2 status='accepted'. The open one INFORMED by an auth-service incident.
     - 2 Sprints: one current, one previous
     - Realistic edges: AUTHORED, TOUCHES, RESOLVES, INFORMED, CAUSED_BY, DEPLOYED, BLOCKS
   - At end: print kgDump(kg) and confirm row counts.

6. index.ts — barrel export of KnowledgeGraph, schemas, types, openDb, kgDump.

Tests in packages/kg/test/:

7. graph.test.ts — covers addNode/addEdge happy path, validation errors, getNode type narrowing, getEdges direction filtering, traverse depth limit and deduplication.

8. queries.test.ts — one describe block per named query. Each block sets up a tiny purpose-built sub-graph, runs the query, asserts the exact expected output shape and content. Verify findRecurringIncidents finds the 3 auth-service incidents in the seed.

9. perf.test.ts — runs each named query against the full seed and asserts p95 < 50ms over 100 runs.

Add to packages/kg/package.json scripts:
- seed: "tsx src/seed.ts"
- test: "vitest run"
- typecheck: "tsc --noEmit"

After implementing, run:
- pnpm --filter @axon/kg typecheck
- pnpm --filter @axon/kg test
- pnpm seed (and confirm the dump shows 50+ nodes)

Report what you built and any deviations from CLAUDE.md (there should be none).

Constraints:
- Synchronous API only (better-sqlite3 is sync). Do not introduce async wrappers.
- No ORM. Hand-write SQL.
- No worker threads.
- Use Zod's safeParse for validation; throw a descriptive error on failure.
- Do not implement any vector embedding logic.
```

### Verification

```bash
pnpm --filter @axon/kg typecheck       # exits 0
pnpm --filter @axon/kg test            # all green, perf test passes
pnpm seed                              # produces a dump with 50+ nodes

# Manual smoke test in a Node REPL or tsx script:
# - findRecurringIncidents('auth-service-id', 30) → length 3
# - getOpenADRs() → length 1
# - getCausalChain(incident_id) → has deploys[] and prs[] populated
```

If everything passes, commit:

```bash
git add -A && git commit -m "phase 1: knowledge graph"
```

### Common failure modes

- **Schema drift.** Claude added an extra field or renamed something. Diff against CLAUDE.md and demand the exact schema.
- **String-concatenated SQL.** Audit `graph.ts` for any `${}` inside SQL strings outside of trusted constants. All user input must use `?` placeholders.
- **Slow queries.** If perf test fails, missing indexes are usually the cause. Verify indexes from prompt are present.
- **Tests pass but seed.ts fails.** Often a foreign-key style violation: addEdge before both nodes exist. Re-order seed insertion.
- **Recurring incident detection wrong.** Verify the 3 auth-service incidents in seed all have `started_at` within the last 30 days.

### If you change anything here, update CLAUDE.md in the same commit.

---

# Prompt 2 — Gateway + Telegram Output

**Time:** ~1 hour.
**Prereqs:** Phases 0–1 complete.

### The prompt

```
Read CLAUDE.md. Phase 1 (KG) is complete. We are in Phase 2: Gateway + Telegram.

Implement two pieces:

PART A — packages/shared additions

1. shared/src/telegram.ts
   - export class TelegramClient(token, defaultChatId)
   - send(text, opts?: { chatId?, buttons?: InlineButton[][], silent? }): Promise<MessageRef>
     - Auto-escapes MarkdownV2 special characters in text
     - Inline keyboard support
     - Retry with exponential backoff (3 attempts, 500ms / 2s / 8s)
     - Returns { messageId, chatId }
   - editMessage(ref, text, opts?): Promise<void>
   - onCallback(handler: (data: string, ctx) => Promise<void>): void
   - Helper: escapeMarkdownV2(s: string): string — must escape: _ * [ ] ( ) ~ ` > # + - = | { } . !

2. shared/src/telegram.test.ts
   - Test escapeMarkdownV2 with a string containing every special character
   - Mock the Telegram API and test retry behavior on 429 / 5xx
   - Test inline keyboard serialization

3. shared/src/trace.ts
   - export function newTraceId(): string — monotonic + random suffix
   - export function withTrace<T>(traceId: string, fn: () => T): T — uses AsyncLocalStorage
   - export function currentTrace(): string | undefined

4. Update shared/src/index.ts to barrel-export the new modules.

PART B — packages/gateway

5. gateway/src/server.ts
   - Express app
   - POST /webhook/sentry — validates HMAC signature using SENTRY_WEBHOOK_SECRET, parses body with Zod, generates traceId, acknowledges in <2s by enqueueing to an in-memory queue, then returns 200
   - POST /webhook/github — same pattern, validates GitHub's X-Hub-Signature-256
   - GET /healthz — returns { status: 'ok', uptime }
   - Every request gets a traceId via middleware
   - JSON error handler that always responds and never leaks stack traces in non-dev

6. gateway/src/queue.ts
   - In-memory async queue with backpressure
   - export async function enqueue(job: Job): Promise<void>
   - Workers consume from the queue. One worker per job type.
   - Worker handlers are registered by job type (we'll wire incident/brief/pr handlers in later phases — leave clearly marked TODO comments)

7. gateway/src/scheduler.ts
   - Wraps node-cron
   - Registers cron jobs by name. Each job has its own traceId per execution.
   - Provides a register(name, cron, handler) API
   - Logs every fire with traceId
   - On startup, log all registered crons + their next fire times

8. gateway/src/index.ts
   - Loads env, opens KG, instantiates TelegramClient, instantiates the queue and scheduler
   - Exports a singleton `app context`: { kg, telegram, queue, scheduler, log }
   - Boots the Express server on env.PORT
   - SIGTERM handler — drains the queue, closes the DB, exits clean

9. gateway/test/server.test.ts
   - Webhook signature validation rejects bad sigs with 401
   - Valid Sentry payload returns 200 in <2s
   - /healthz returns ok

After implementing, run:
- pnpm --filter @axon/shared test
- pnpm --filter @axon/gateway test
- pnpm dev — gateway should start, log registered crons (none yet) and the listening port
- Hit /healthz with curl

Constraints:
- Webhook handlers must respond in <2s even if downstream processing is slow. Always 200 then enqueue.
- Never log secrets or tokens.
- HMAC validation uses crypto.timingSafeEqual to prevent timing attacks.
- Queue is in-memory for now; do not introduce Redis.
```

### Verification

```bash
pnpm --filter @axon/shared test       # green
pnpm --filter @axon/gateway test      # green
pnpm dev                              # gateway boots, /healthz returns ok

# Manual: send a real Telegram message to your dev chat
# Manual: fire a curl POST to /webhook/sentry with a valid HMAC and confirm <2s response
```

Commit: `phase 2: gateway and telegram`.

### Common failure modes

- **MarkdownV2 escape bugs.** Telegram is brutal here. Test by sending a message with every special char.
- **HMAC mismatch.** Sentry sends raw body bytes; you must validate against the unparsed buffer, not the JSON-parsed body. Use a raw-body middleware on `/webhook/*` only.
- **Queue worker never fires.** Make sure workers register on boot, not lazily.

---

# Prompt 3 — Morning Intelligence Brief (F2)

**Time:** ~1.5 hours.
**Prereqs:** Phases 0–2 complete.

### The prompt

```
Read CLAUDE.md. Phases 0-2 are complete. We are in Phase 3: Morning Brief.

Implement @axon/brief.

Files in packages/brief/src/:

1. fetchers.ts
   - fetchOpenPRs(ctx): Promise<PRSummary[]> — uses Octokit, filters to last 24h merged + currently open
   - fetchLinearBlockers(ctx): Promise<Issue[]> — open issues with label "blocker" or priority "Urgent"
   - fetchSentryErrors(ctx): Promise<ErrorSummary[]> — last 24h errors above a threshold
   - fetchKGSignals(ctx): Promise<{ recurringPatterns, openADRs, engineerLoad, incidentTrend }>
     - recurringPatterns: top 3 services with >=2 incidents in last 30d (uses kg.findRecurringIncidents per service)
     - openADRs: kg.getOpenADRs()
     - engineerLoad: top 3 engineers by load via kg.getEngineerLoad
     - incidentTrend: { thisWeek, lastWeek, deltaPct }
   - All fetchers return a discriminated union { ok: true, data } | { ok: false, error }
   - Use Promise.allSettled at the call site so one failure does not break the brief

2. synthesize.ts
   - synthesizeBrief(signals, model: 'haiku-4-5'): Promise<string>
   - Calls Anthropic SDK with claude-haiku-4-5-20251001
   - Use streaming
   - System prompt: instruct Axon to produce a 5-bullet executive brief, never raw numbers without context, lead with KG-derived patterns
   - User message: structured XML with <prs>, <blockers>, <errors>, <patterns>, <open_adrs>, <load>, <trend> sections
   - Returns the assembled markdown string (concatenated streamed chunks)

3. format.ts
   - formatForTelegram(brief: string): string — wraps in MarkdownV2, adds a "Generated at HH:MM IST" footer with traceId

4. handler.ts
   - export async function morningBriefJob(ctx, traceId)
   - Logs start, runs all fetchers in parallel via Promise.allSettled, calls synthesizeBrief, calls ctx.telegram.send with formatForTelegram, logs end with elapsed_ms
   - Always completes; never throws

5. register.ts
   - export function registerMorningBrief(ctx)
   - ctx.scheduler.register('morning-brief', '0 8 * * *', () => morningBriefJob(ctx, newTraceId()))
   - Cron is in IST (Asia/Kolkata) — set the timezone in node-cron options
   - Also register a CLI: `tsx src/cli/run-now.ts` for manual triggering during demo prep

6. index.ts — barrel exports.

In packages/gateway/src/index.ts, import and call registerMorningBrief(ctx) on boot.

Tests in packages/brief/test/:

7. fetchers.test.ts — mock Octokit/Linear/Sentry, assert correct filtering and pagination handling
8. synthesize.test.ts — snapshot test the user-message XML structure given a known signals object; mock the SDK
9. handler.test.ts — full handler with mocked deps, assert Telegram receives a non-empty MarkdownV2 message; assert Promise.allSettled rejection in one fetcher does not fail the job

After implementing, run:
- pnpm --filter @axon/brief test
- tsx packages/brief/src/cli/run-now.ts (with seeded KG and real Telegram bot) — confirm a brief lands in your dev chat with at least one KG-pattern bullet

Constraints:
- Use Haiku, not Sonnet.
- Stream LLM output.
- Cost target: <$0.005 per brief.
- Brief must include at least one KG-derived bullet (e.g., "auth-service: 3rd incident this month").
- Total job time target: <15s end-to-end.
```

### Verification

```bash
pnpm --filter @axon/brief test
pnpm dev                              # gateway logs the cron registration
tsx packages/brief/src/cli/run-now.ts # forces the brief; check Telegram

# Confirm: the message includes a KG pattern line
# Confirm: total elapsed time logged is <15s
```

Commit: `phase 3: morning brief`.

### Common failure modes

- **Brief feels generic.** The user-message XML probably isn't separating KG patterns. Audit `synthesize.ts` — KG context must be its own `<patterns>` section, not mixed in with raw API data.
- **Linear API auth.** Linear uses an OAuth-style key with specific GraphQL endpoint. Check the SDK docs for the correct base URL.
- **Cron fires in wrong timezone.** Confirm node-cron timezone option is `Asia/Kolkata`.

---

# Prompt 4 — Incident Commander (the showstopper)

**Time:** ~3 hours, including a tuning pass for the <60s SLA.
**Prereqs:** Phases 0–3 complete.

> This is the demo. Get it right. Plan to iterate.

### The prompt

```
Read CLAUDE.md. Phases 0-3 are complete. We are in Phase 4: Incident Commander.

Implement @axon/incident. This feature determines the demo outcome — every design decision should be evaluated against the <60s SLA and the demo arc described in CLAUDE.md.

Files in packages/incident/src/:

1. types.ts
   - Zod schemas for the SentryWebhookPayload (subset we care about: project, event_id, level, title, environment, fingerprint, timestamp)
   - Internal IncidentContext type: { incident: Incident, recentDeploys: Deploy[], recurringPatterns: Incident[], openADRs: Decision[], onCallEngineer?: Engineer, traceId: string }

2. ingest.ts
   - parseAndValidateSentry(rawPayload): SentryWebhookPayload
   - sentryToIncident(payload, kg): Incident — creates an Incident node in the KG, links it via TOUCHES to the affected Service (resolve by project name)
   - Idempotent on event_id

3. enrich.ts
   - enrichIncident(incident, kg): IncidentContext
   - Fetches in parallel via Promise.all:
     - kg.findRecurringIncidents(service_id, 30)
     - Recent deploys to the service in the last 4h via Octokit + kg
     - kg.getOpenADRs(service_id)
     - On-call engineer (configurable; for demo, infer from most recent committer to the service repo)
   - Target: <2s

4. synthesize.ts
   - synthesizeIncidentResponse(ctx: IncidentContext, telegram): Promise<{ messageRef, totalMs }>
   - Streams from claude-sonnet-4-6
   - System prompt: Axon persona, three principles, structured output requirement
   - User message structured XML:
     <incident> ... </incident>
     <recurring_patterns> ... </recurring_patterns>
     <recent_deploys> ... </recent_deploys>
     <open_adrs> ... </open_adrs>
     <oncall> ... </oncall>
   - Streaming behavior:
     - As tokens arrive, accumulate; first token must be sent to Telegram within <60s of webhook arrival
     - Use telegram.send for the initial message (sent on first chunk), then telegram.editMessage to append
     - Throttle edits to once per 800ms to avoid Telegram rate limits
   - Append an inline keyboard at completion: [[Rollback], [Acknowledge, Escalate]]

5. actions.ts
   - rollback(deployId, ctx): creates a GitHub revert PR for the deploy's SHA, posts the PR URL back to Telegram as a thread reply
   - acknowledge(incidentId, ctx): updates Incident.metadata.acknowledged_by + .acknowledged_at, edits message
   - escalate(incidentId, ctx): re-sends to a configurable secondary chatId
   - All three must be idempotent

6. recovery.ts
   - startRecoveryMonitor(incidentId, service, ctx): spawns a polling loop
   - Polls Sentry every 30s for new errors on this service's project
   - When error rate < threshold for 2 consecutive polls OR 10 minutes elapse, sends a recovery message and updates Incident.resolved_at
   - Must clean itself up on resolution to avoid leaks

7. handler.ts
   - export async function incidentJob(payload, ctx, traceId)
   - Pipeline:
     a. start timer T0
     b. parseAndValidateSentry
     c. sentryToIncident (timer mark T1)
     d. enrichIncident (T2)
     e. synthesizeIncidentResponse — streams, returns when first token sent (T3)
     f. log structured timing: { T1-T0, T2-T1, T3-T2, T3-T0 }
     g. spawn recovery monitor (don't await)
   - Wire callback handlers from Telegram into actions.ts via the shared TelegramClient

8. register.ts — registerIncidentHandlers(ctx) wires the gateway's queue worker for type 'incident' to incidentJob, and registers Telegram callback routes.

9. index.ts — barrel.

In packages/gateway/src/index.ts, import and call registerIncidentHandlers(ctx). Update the /webhook/sentry handler to enqueue type 'incident' jobs.

Tests in packages/incident/test/:

10. ingest.test.ts — Sentry payload parsing, idempotency on duplicate event_id
11. enrich.test.ts — given a seeded KG, returns full context structure within 2s
12. synthesize.test.ts — mock the Anthropic SDK; assert the prompt includes <recurring_patterns> when the KG has matches; assert streaming begins firing the Telegram client
13. e2e.test.ts — wire the full pipeline with mocked Telegram and SDK; fire a synthetic Sentry payload; assert the entire flow completes and the FIRST Telegram message goes out within 60 seconds (use vitest fake timers; assert telegram.send was called with elapsed virtual time < 60_000ms)

After implementing:
- pnpm --filter @axon/incident test
- Use the demo/fire-webhook.ts script (will be built in Phase 7) — for now, fire a hand-crafted curl POST against /webhook/sentry with a valid HMAC and observe Telegram

Constraints:
- The <60s SLA is non-negotiable. Add stage timing logs and verify before declaring done.
- Stream the LLM output. Send the first message on first chunk, edit-append after.
- Use Sonnet, not Haiku.
- Cost target: <$0.05 per incident.
- All KG queries used in enrich.ts must be the named queries from CLAUDE.md — do not add new ones here.
- Recovery monitor must not leak: assert in tests that on resolution, the polling timer is cleared.
```

### Verification

```bash
pnpm --filter @axon/incident test                                  # all green
pnpm dev                                                            # gateway boots clean

# Real test: fire a Sentry webhook against your dev gateway
# Confirm in Telegram:
# - First message arrives within 60s (preferably under 30s)
# - Message contains causal chain, recurring pattern context, open ADR, rollback button
# - Tapping "Rollback" creates a revert PR on the GitHub side
# - After rollback, recovery monitor message appears within 10 minutes
```

Commit: `phase 4: incident commander`.

### Common failure modes

- **>60s on first run.** Almost always one of: synthesize sends only after full completion (must stream), enrich.ts not parallelized, or KG query slow due to a missing index in Phase 1. Time each stage and find the offender.
- **Telegram edit storm.** If edits fire every chunk, you'll hit rate limits. Throttle to 800ms.
- **Duplicate incidents on Sentry retry.** Confirm idempotency on event_id is enforced in `sentryToIncident`.
- **Rollback PR never appears.** GitHub PAT scope wrong; needs `repo` scope at minimum.
- **Recovery monitor leaks timers.** Test it explicitly with vitest fake timers.

### Tuning pass (do this before declaring Phase 4 done)

1. Run a real incident through the gateway with timing logs visible.
2. Identify the slowest stage (usually synthesize → first chunk).
3. Optimize:
   - Sonnet system prompt should be lean (every token matters at TTFT).
   - User message XML should be in priority order (most relevant context first).
   - Pre-warm the Anthropic SDK connection on gateway boot.
   - Pre-warm Telegram by sending a silent heartbeat on boot.
4. Re-run. Repeat until p95 < 60s across 5 consecutive runs.

---

# Prompt 5 — PR & Code Health Monitor (F5)

**Time:** ~1 hour.
**Prereqs:** Phases 0–4 complete.

### The prompt

```
Read CLAUDE.md. We are in Phase 5: PR Health.

Implement @axon/pr.

Files in packages/pr/src/:

1. critical-paths.ts
   - exports CRITICAL_PATHS: string[] — globs like "packages/auth/**", "infra/**", "packages/payments/**"
   - matchesCriticalPath(filesChanged: string[]): boolean — uses minimatch

2. realtime.ts
   - handleGitHubPRWebhook(payload, ctx)
     - Parses PR event
     - If action is opened/synchronize and any file matches a critical path: send instant Telegram alert
     - Records the PR as a node in KG (or updates if exists), AUTHORED edge from engineer
     - Alert format: "Critical-path PR by {author} touching {service}: {title}\n{url}"

3. digest.ts
   - prDigestJob(ctx, traceId)
   - Pulls all open PRs via Octokit
   - For each, identifies reviewers via PR metadata
   - Aggregates per reviewer: count of pending reviews
   - Identifies bottleneck: any reviewer with > N pending (configurable, default 5)
   - Cross-references with kg.getEngineerLoad to flag overloaded engineers
   - Synthesizes a Telegram digest via Haiku
   - Sections: "Open Critical PRs", "Reviewer Bottlenecks", "Stale PRs (>7d, no activity)"
   - Cost target: <$0.005

4. register.ts
   - registerPRHealth(ctx)
   - Wires the gateway /webhook/github handler for PR events to realtime.ts
   - Schedules the digest at '0 18 * * 1-5' (6 PM weekdays, IST)

5. index.ts — barrel.

In packages/gateway/src/index.ts, import and call registerPRHealth(ctx). Update /webhook/github to route PR events to realtime handler.

Tests in packages/pr/test/:
- realtime.test.ts: critical-path matching, instant alert firing
- digest.test.ts: bottleneck detection, formatting

After implementing:
- pnpm --filter @axon/pr test
- Open a test PR in your staging repo touching a critical path; verify Telegram alert
- Manually trigger digest via tsx CLI; verify formatting

Constraints:
- Use Haiku for the digest synthesis.
- Realtime alert must not invoke an LLM — pure formatting only, sub-second.
```

### Verification

```bash
pnpm --filter @axon/pr test       # green
# Manual: open a PR touching CRITICAL_PATHS in your test repo → instant Telegram alert
# Manual: trigger digest CLI → digest lands with bottlenecks listed
```

Commit: `phase 5: pr health`.

### Common failure modes

- **Realtime alert delayed.** No LLM in the realtime path; the alert is a templated string only. Audit for accidental SDK calls.
- **Bottleneck calc wrong.** Verify against the KG's getEngineerLoad — single source of truth.

---

# Prompt 6 — Sprint Risk Radar (F4) — *cuttable*

**Time:** ~1 hour. **Skip this if Phase 4 ran long.**
**Prereqs:** Phases 0–5 complete.

### The prompt

```
Read CLAUDE.md. We are in Phase 6: Sprint Risk Radar.

Implement @axon/sprint.

Files in packages/sprint/src/:

1. score.ts
   - computeSprintRisk(sprint, signals): { score: number, breakdown: Record<string, number> }
   - Formula:
     score = blocker_weight * 30
           + (1 - velocity_ratio) * 25
           + scope_creep_pct * 20
           + days_to_deadline_pressure * 15
           + systemic_block * 10
   - Each component is normalized to [0,1]; total clamped to [0,100]
   - Returns breakdown for transparency in the brief

2. signals.ts
   - gatherSprintSignals(sprintId, kg): Promise<{ blocker_weight, velocity_ratio, scope_creep_pct, days_to_deadline_pressure, systemic_block }>
   - blocker_weight: count of BLOCKS edges into sprint, normalized
   - velocity_ratio: completed_points / planned_points (capped at 1.0 for formula)
   - scope_creep_pct: (current_planned - original_planned) / original_planned
   - days_to_deadline_pressure: 1 - (days_remaining / total_sprint_days), clamped
   - systemic_block: 1 if any service in the sprint has >2 incidents this sprint, else 0

3. trend.ts
   - persistRiskScore(sprintId, score, kg): writes the score onto the Sprint node's payload
   - getRiskTrend(sprintId, kg): array of historical scores for plotting

4. brief.ts
   - sprintRiskBrief(ctx, traceId): generates a Haiku-summarized message
   - Includes: current score, breakdown, week-over-week delta, top 3 contributing factors
   - Cost target: <$0.005

5. register.ts
   - registerSprintRisk(ctx)
   - Cron: '0 9 * * 1-5' (9 AM weekdays, IST)
   - Computes score, persists to KG, sends Telegram digest

6. index.ts — barrel.

Wire into gateway/src/index.ts.

Tests:
- score.test.ts: each formula component contributes correctly; score in [0,100]
- signals.test.ts: against seeded KG
- trend.test.ts: persistence and retrieval

After implementing:
- pnpm --filter @axon/sprint test
- Trigger via CLI; verify Telegram digest includes a risk score and breakdown

Constraints:
- Use Haiku.
- Score must always be a number in [0,100].
- If signals fail to gather, send a degraded brief saying so — do not crash.
```

### Verification

```bash
pnpm --filter @axon/sprint test    # green
# Trigger CLI → digest in Telegram with score and breakdown
```

Commit: `phase 6: sprint risk`.

---

# Prompt 7 — Demo Polish

**Time:** ~1.5 hours.
**Prereqs:** All prior phases complete.

> The demo is what wins. Treat this prompt as deliverable, not optional.

### The prompt

```
Read CLAUDE.md. All features complete. We are in Phase 7: Demo Polish.

Build the demo tooling in /demo at the repo root (not a workspace package).

Files:

1. demo/fire-webhook.ts
   - tsx CLI script
   - Reads SENTRY_WEBHOOK_SECRET from env
   - Hard-coded synthetic Sentry payload modeling an auth-service failure
   - On keypress (any key), POSTs the payload with valid HMAC to http://localhost:3000/webhook/sentry
   - Prints the elapsed time from POST to first Telegram message (gateway must log this; tail the gateway log via a separate IPC mechanism, OR rely on the gateway emitting a stage event we can read here — keep it simple and read from a known log file)

2. demo/stopwatch.html
   - Standalone single-file HTML
   - Big stopwatch in monospace, starts on click, stops on click again
   - Designed to be visible on a presenter laptop while the demo runs
   - Black background, terracotta accent, fits the deck aesthetic

3. demo/kg-viz/
   - index.html: D3 force-directed graph
   - Loads a JSON snapshot of the KG via a small Express endpoint we'll add to the gateway: GET /demo/kg-snapshot returns { nodes, edges } for visualization
   - Color nodes by type, label edges by type, smooth physics
   - The viz is the closing slide of the demo — it should feel alive, not static

4. demo/add-skill.ts
   - The "live extensibility flex" for the demo
   - Single command: tsx demo/add-skill.ts standup
   - Pulls yesterday's commits + today's open PRs from KG, formats into a standup-style summary, sends to Telegram via the shared client
   - Total elapsed time printed at end (target <30s)
   - This is the proof that "adding a skill is trivial against the KG"

5. Update packages/gateway/src/server.ts
   - Add GET /demo/kg-snapshot — returns serialized KG state for the viz (limit to 100 nodes, dedupe edges)

6. demo/README.md
   - The exact 90-second demo script:
     - Open: morning brief screenshot already on Telegram (run it manually beforehand at 8 AM IST or via CLI)
     - Step 1: announce demo, click stopwatch
     - Step 2: tsx demo/fire-webhook.ts — press key
     - Step 3: Telegram alert lands (point at stopwatch)
     - Step 4: tap Rollback button, recovery monitor activates
     - Step 5: tsx demo/add-skill.ts standup — flex
     - Step 6: open kg-viz in browser, narrate the moat
   - Pre-flight checklist for demo day: bot tokens valid, KG seeded, gateway running, network on, fallback video recorded

7. Record the demo video.
   - Use OBS or QuickTime; capture screen + audio
   - Run through the full arc twice — keep the better take
   - Save as demo/axon-demo.mp4
   - This is the safety net for live failure

Constraints:
- demo/ is not a workspace package; use tsx directly with workspace deps via pnpm exec
- Do not add new business logic; demo tools should reuse @axon/kg, @axon/shared, @axon/incident
```

### Verification

```bash
# In one terminal:
pnpm dev

# In another:
tsx demo/fire-webhook.ts             # press key, watch Telegram + stopwatch
tsx demo/add-skill.ts standup        # confirm <30s
open demo/stopwatch.html             # works
open demo/kg-viz/index.html          # graph renders, looks alive
```

Commit: `phase 7: demo polish` and `phase 7: demo video`.

---

# Final Integration Checklist

Before Round 2 submission to ClawHub:

- [ ] All 7 phases committed with clean test runs
- [ ] `pnpm test` passes everything in <30s
- [ ] `pnpm typecheck` clean
- [ ] Demo runs end-to-end with stopwatch <60s
- [ ] Demo video recorded and saved
- [ ] README.md at repo root with: project description, architecture diagram link, demo video link, run instructions
- [ ] CLAUDE.md updated to reflect any schema deviations made along the way (there should be none)
- [ ] LICENSE: MIT
- [ ] .env.example complete and accurate
- [ ] No tokens or secrets committed (run `git log -p | grep -i 'sk-\|token\|secret'` to verify)
- [ ] Round 2 deck updated:
  - [ ] Architecture diagram shows the KG as a first-class component
  - [ ] Memory Store reframed as typed knowledge graph (own the pivot story)
  - [ ] 7 skills reframed as "5 polished + KG foundation makes adding the rest trivial"
- [ ] ClawHub publish package: zip of repo + deck + demo video link

---

# Recovery: When Things Go Wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| Phase 1 perf test fails | Missing index | Re-check `db.ts` migrations against CLAUDE.md |
| Phase 2 webhook returns 200 but nothing happens | Worker not registered | Audit `gateway/src/index.ts` boot sequence |
| Phase 3 brief is generic | KG patterns not in synthesize prompt | Audit XML structure; patterns must be their own section |
| Phase 4 >60s | Synthesize blocking on full completion | Verify streaming; first chunk → Telegram immediately |
| Phase 4 Telegram rate limited | Edit storm | Throttle edits to 800ms |
| Phase 5 alert delayed | Accidental LLM call in realtime path | Realtime is templated only; remove SDK call |
| Phase 7 stopwatch desync | Page refreshed | Use storage; or just don't refresh during demo |

---

# Rules of Engagement (between you and Claude Code)

- **Always reference CLAUDE.md.** Every prompt starts with "Read CLAUDE.md."
- **One phase per session.** Fresh context for each prompt unless explicitly chaining.
- **Verify before moving on.** No exceptions. The cost of a bad foundation compounds.
- **Don't accept scope additions from Claude.** If Claude adds a "useful helper" not in the prompt, remove it.
- **Commit after every green prompt.** You'll want the rollback points.
- **If a prompt produces something wrong, reset rather than patch.** Patching multiplies drift.

---

*The KG is the moat. Protect it. Everything else serves the demo.*