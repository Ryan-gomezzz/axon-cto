# The Four Skills

Each skill is a workspace package. Each follows the same shape — register at boot, fire on a trigger, hit the KG, stream an LLM response, send to Telegram. They differ in *which* trigger, *which* model tier, and *what* the prompt asks for.

| Skill | Trigger | Model | Cost target | Total time |
|---|---|---|---|---|
| [`@axon/brief`](../packages/brief) | cron `0 8 * * *` IST | Nemotron-Mini (routine tier) | <$0.005 | <15s |
| [`@axon/incident`](../packages/incident) | webhook `/webhook/sentry` | Nemotron-70B (incident tier) | <$0.05 | <60s to first chunk |
| [`@axon/pr`](../packages/pr) | webhook `/webhook/github` (realtime) + cron `0 18 * * 1-5` IST (digest) | Nemotron-Mini (digest only — realtime has no LLM) | <$0.005 (digest) | sub-second (realtime), <15s (digest) |
| [`@axon/sprint`](../packages/sprint) | cron `0 9 * * 1-5` IST | Nemotron-Mini (routine tier) | <$0.005 | <15s |

The model strings come from `env.LLM_MODEL_INCIDENT` and `env.LLM_MODEL_ROUTINE`. Don't hard-code them.

---

## The four shapes — picked one and extended

Every skill has the same skeleton:

```
packages/<skill>/src/
├── types.ts          ctx interface, env subset, internal types
├── handler.ts        the entry point — what runs on cron/webhook
├── synthesize.ts     prompt + LLM call + stream consumption
├── format.ts         (or inline) MarkdownV2 escape + IST footer
├── register.ts       wires queue/scheduler at boot — duck-typed Like interfaces
├── cli/run-now.ts    standalone trigger for demo prep / debugging
└── index.ts          barrel
```

The boot file in [packages/gateway/src/main.ts](../packages/gateway/src/main.ts) builds a per-skill ctx and calls `register*`. That's it. No global state, no service locator, no DI container.

If you're adding a fifth skill, follow this shape exactly. See [extending.md](extending.md).

---

## `@axon/brief` — Morning Intelligence Brief

> Pushed at 8 AM IST. Five bullets. Leads with KG-derived patterns.

### What it does

1. Fans out four fetchers under `Promise.allSettled`:
   - **PRs** ([fetchers.ts § fetchOpenPRs](../packages/brief/src/fetchers.ts)) — Octokit, currently open + last-24h merged, deduped by number.
   - **Linear blockers** — single GraphQL query for issues with `priority=Urgent` or `labels=blocker` (full query inlined in [fetchers.ts](../packages/brief/src/fetchers.ts)).
   - **Sentry errors** — degrades to `ok:false` if `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT` aren't set; otherwise hits `/api/0/projects/{org}/{project}/issues/?statsPeriod=24h` and filters by a 5-event threshold.
   - **KG signals** — recurring patterns (top 3 services with ≥2 incidents in 30d, via `findRecurringIncidents` per service), open ADRs (`getOpenADRs()`), top-3 engineer load (`getEngineerLoad` per engineer), incident trend (this-week vs last-week count + delta %).

2. Builds a structured XML user message with `<patterns>` first (so the LLM leads with KG-derived facts), then `<open_adrs>`, `<load>`, `<trend>`, `<prs>`, `<blockers>`, `<errors>`. Failed fetchers surface inline as `<errors><error>…</error></errors>` so the LLM acknowledges gaps rather than inventing data.

3. Streams Nemotron-Mini with a system prompt that mandates KG-grounded leading bullet, no raw-numbers-without-context, exactly 5 bullets prefixed with `* `.

4. Escapes the result for MarkdownV2, adds a trace-id'd italic footer (`Generated at HH:mm IST · trace t-…`), `telegram.send(…, { skipEscape: true })`.

### Where to look

- Cron registration: [register.ts](../packages/brief/src/register.ts) — uses a duck-typed `SchedulerLike`.
- LLM contract: [synthesize.ts § SYSTEM_PROMPT](../packages/brief/src/synthesize.ts) and `buildUserMessage`.
- Failure modes: see [decisions.md § Promise.allSettled at fetchers](decisions.md#promiseallsettled-at-fetchers).

### Manual trigger

```bash
pnpm exec tsx packages/brief/src/cli/run-now.ts
```

---

## `@axon/incident` — Incident Commander

> The showstopper. <60s SLA. Streams Nemotron-70B; first chunk to Telegram inside the budget.

### Pipeline

[packages/incident/src/handler.ts](../packages/incident/src/handler.ts) runs:

```
T0  parseAndValidateSentry        ingest.ts — accepts flat or data.event-wrapped shapes
T1  sentryToIncident (KG)         idempotent on event_id; resolves Service by name match
T2  enrichIncident                Promise.all over findRecurringIncidents, getOpenADRs, Octokit listCommits
T3  synthesizeIncidentResponse    streams Nemotron-70B; resolves at first chunk; logs stage timings
    └─ recovery.start             fire-and-forget; polls Sentry every 30s for two-consecutive-clean ticks or 10-min timeout
```

Each stage logs its own duration; the structured log line at first-token-sent looks like:

```
{ component: 'incident', traceId, incident_id, stage_ingest_ms, stage_enrich_ms,
  stage_synth_first_chunk_ms, total_ms, sla_60s }
```

`fire-webhook.ts` tails the log file for that exact log line and prints the SLA result. See [demo/README.md](../demo/README.md).

### Streaming + edit-throttle

`synthesizeIncidentResponse` resolves at **T3** — the moment the first non-empty chunk has been `telegram.send`'d. The remaining chunks are consumed by a background `continueStreaming` loop that:

- Edit-throttles at **800ms** to stay under Telegram's edit-rate limits.
- Swallows mid-stream edit failures (Telegram occasionally 400s on identical-text edits — non-fatal).
- Posts the **final edit with the inline keyboard**: `[[Rollback], [Acknowledge, Escalate]]`.

### Actions

[actions.ts](../packages/incident/src/actions.ts) exposes three idempotent handlers wired to the Telegram callback router:

- **`rollback`** — opens a labelled `axon-rollback` GitHub Issue with the SHA in the title (idempotent — re-uses an open issue if one with the same SHA exists). Posts the issue URL back as a thread reply. True PR-revert flow is deferred — see [decisions.md § Rollback issues, not PRs](decisions.md#rollback-issues-not-prs).
- **`acknowledge`** — writes to an in-memory `ackedIncidents` Map (Phase 4 limitation; CLAUDE.md's Incident payload has no `metadata` field for persisting ack state).
- **`escalate`** — re-sends the synthesized summary to `env.TELEGRAM_ESCALATION_CHAT_ID` if set; "not configured" message otherwise.

### Recovery monitor

[recovery.ts](../packages/incident/src/recovery.ts) — `RecoveryRegistry` tracks active monitors per incident. Each monitor polls Sentry every 30s, exits when:

- Error count is below threshold for **2 consecutive polls** → writes `resolved_at` via `kg.updatePayload`, sends "✅ Recovery confirmed" message.
- **10 minutes elapse** → sends a timeout message, leaves the incident unresolved.

`stop()` clears the timer and removes the registry entry. The gateway's SIGTERM handler calls `recovery.stopAll('shutdown')` so leak-free shutdown is asserted by tests in [packages/incident/test/e2e.test.ts](../packages/incident/test/e2e.test.ts).

### Manual trigger

```bash
pnpm exec tsx demo/fire-webhook.ts
# Press any key to fire ▶
```

---

## `@axon/pr` — PR & Code-Health Monitor

> Two paths: realtime alert (no LLM, sub-second) + 6 PM digest (Nemotron-Mini).

### Realtime path

[realtime.ts § handleGitHubPRWebhook](../packages/pr/src/realtime.ts):

1. Ignores actions other than `opened`/`synchronize`/`reopened`.
2. One Octokit `pulls.listFiles` call.
3. Matches against [`CRITICAL_PATHS`](../packages/pr/src/critical-paths.ts) — `packages/auth/**`, `packages/payments/**`, `infra/**`, `.github/workflows/**`, …
4. Upserts the PR into the KG (uses `kg.updatePayload` on `synchronize` so file lists stay current).
5. Adds `AUTHORED` (Engineer → PR) and `TOUCHES` (PR → Service) edges if missing.
6. If critical: `telegram.send` of `Critical-path PR by {author} touching {service}: {title}\n{url}` — plain text, MarkdownV2 auto-escape on send.

**Constraint: realtime has no LLM.** A test in [realtime.test.ts](../packages/pr/test/realtime.test.ts) structurally asserts that `handleGitHubPRWebhook.toString()` doesn't contain `'openai'`.

Latency budget: **sub-second from queue tick to Telegram send**. Verified at 327ms in dev smoke (with placeholder GitHub credentials degrading to no critical path).

### Digest path

[digest.ts § prDigestJob](../packages/pr/src/digest.ts):

1. `octokit.paginate(pulls.list, { state: 'open' })` for all open PRs.
2. Per-reviewer pending count from `requested_reviewers`. Stale = `updated_at` >7d ago.
3. Top-20-newest-updated PRs get `listFiles` in parallel; results filtered by `matchesCriticalPath` for the "Open Critical PRs" section.
4. **Reviewer bottleneck** = a reviewer with > N pending (default 5; `bottleneckThreshold` is configurable). Cross-references `kg.getEngineerLoad(engineer.id)` for any reviewer whose handle resolves to a KG Engineer; the digest XML carries `open_prs / recent_incidents / review_queue_size` so the LLM can call out *"alice: 5 pending — also leading 2 incidents this week, escalation candidate"*.
5. Streams Nemotron-Mini for the three-section digest: **Open Critical PRs**, **Reviewer Bottlenecks**, **Stale PRs (>7d)**. Empty sections render as `* (none)` rather than getting dropped.

### Manual trigger

```bash
# Realtime — fire a synthetic GitHub PR webhook (use HMAC; see demo/README.md)
# Digest:
pnpm exec tsx packages/pr/src/cli/run-now.ts
```

---

## `@axon/sprint` — Sprint Risk Radar

> Cron 9 AM weekdays IST. Cuttable per the original phase plan, but shipped — five-component risk score in the [0,100] range with a Nemotron-Mini-summarized brief.

### The score

[score.ts](../packages/sprint/src/score.ts), `computeSprintRisk(signals)`:

```
score = blocker_weight        * 30
      + (1 - velocity_ratio)  * 25
      + scope_creep_pct       * 20
      + days_to_deadline_pressure * 15
      + systemic_block        * 10
```

Each input is clamped to `[0,1]` (NaN/Infinity → 0). Total clamped to `[0,100]`. Returns `{ score, breakdown }` so the brief can show "what's driving this."

### The signals

[signals.ts § gatherSprintSignals](../packages/sprint/src/signals.ts):

- **`blocker_weight`** = `min(BLOCKS-edges-in, 5) / 5`
- **`velocity_ratio`** = `min(1, completed_points / planned_points)` — defaults to 1 when `planned_points == 0`
- **`scope_creep_pct`** = `(planned - original) / original`. CLAUDE.md's Sprint payload doesn't yet track `original_planned_points`; the helper `originalPlannedPoints` returns the current `planned_points`, so this defaults to 0. Single point of change once we record planning events.
- **`days_to_deadline_pressure`** = `1 - (days_remaining / total_days)`, clamped
- **`systemic_block`** = `1` if any service has `>2` incidents whose `started_at` falls in the sprint window

### Trend persistence

[trend.ts](../packages/sprint/src/trend.ts):

- `persistRiskScore(sprintId, score, kg)` — writes `risk_score` onto the Sprint payload via `kg.updatePayload`. Rejects non-finite scores.
- `getRiskTrend(kg)` — every Sprint that has a `risk_score`, sorted oldest first. Two points after the seed (sprint-22 at 18, sprint-23 once written).
- `weekOverWeekDelta(trend, currentSprintId, currentScore)` — delta against the most recent prior sprint with a recorded score.

### Degraded path

If `gatherSprintSignals` throws (no current sprint, KG read error), the brief sends a **degraded message** acknowledging the failure rather than crashing the cron — the LLM input becomes `<signals_failed reason="…"/>` and the system prompt instructs it to apologise and not invent a score. Belt-and-suspenders: if the LLM also fails, the deterministic body says *"Sprint risk: degraded — …"*.

### Manual trigger

```bash
pnpm exec tsx packages/sprint/src/cli/run-now.ts
```

---

## What every skill has in common

Five patterns to keep in mind when you read or extend them:

1. **Context is passed, not imported.** Every skill exports a `*Context` interface (e.g. `BriefContext`, `IncidentJobContext`) and accepts it as the first arg of every entry-point function. The gateway builds the context once at boot and hands it down. No globals.
2. **Test seams on the context.** `octokit?`, `fetch?`, `openaiClient?`, `now?` are optional fields on the context type. Tests pass mocks; production omits them and the implementation builds the real client lazily.
3. **`Promise.allSettled` at the fetcher boundary.** Brief uses it explicitly; incident's enrichIncident degrades each Octokit failure inline. The skill never crashes because one external dep is down.
4. **Streaming LLM + first-chunk return.** Every synthesize function uses `stream: true` on the OpenAI SDK call. The incident commander goes further — it returns at first-chunk-sent and continues editing in the background. Total throughput stays low; perceived latency stays inside the SLA.
5. **`telegram.send(text, { skipEscape: true })`** when the body is pre-escaped. The default `send` auto-escapes; the skills that need italic footers or LLM-generated MarkdownV2 escape themselves and pass `skipEscape`. See [packages/shared/src/telegram.ts § escapeMarkdownV2](../packages/shared/src/telegram.ts).

---

## Wiring at boot

[packages/gateway/src/main.ts](../packages/gateway/src/main.ts) — the only file that imports all four skills. Order:

```ts
registerMorningBrief({ ...briefCtx, scheduler })
registerIncidentHandlers({ ...incidentCtx, queue }) // returns RecoveryRegistry
registerPRHealth({ ...prCtx, queue, scheduler })
registerSprintRisk({ ...sprintCtx, scheduler })
```

The shutdown path passes the returned `RecoveryRegistry` to `recovery.stopAll('shutdown')` so polling timers don't outlive the process.
