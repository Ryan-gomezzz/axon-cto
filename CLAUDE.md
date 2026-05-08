# Axon / CTO Copilot — Project Memory

> Read this file first, every session. It is the source of truth for architecture, schema, conventions, and constraints. If a user request contradicts this file, ask before deviating.

---

## Mission

Axon is a **synthetic engineering chief of staff**. Not a dashboard. Not a chatbot.

Three principles govern every feature:

- **Proactive** — Pushes decisions to Telegram before the user asks. Wakes on heartbeat schedules.
- **Synthesized** — Never surfaces a raw number without an accompanying contextual sentence.
- **Autonomous** — Silence is a feature. Only escalates on threshold breaches.

This is being built for Samsung SRI-B *Clash of the Claws*, Round 2. The moat is a typed knowledge graph.

---

## The Moat (Important)

The Knowledge Graph **is** the thesis. Everything else is a surface that proves the thesis works.

**Do not suggest:**
- Replacing the typed KG with vector embeddings
- A managed vector DB (Pinecone, Weaviate, Chroma, pgvector)
- Alternative memory architectures
- "Simplifying" by collapsing the schema

The KG enables sentences no stateless agent can produce. Example:

> *"3rd auth-service incident this month — pattern matches Redis connection exhaustion. ADR-014 from incident #1 is still open. Last fix: PR #847 by Aditi."*

That sentence is the demo. Protect the KG.

---

## Architecture

Four layers. Reference this when placing new code.

```
Layer 1 — Triggers       Heartbeat Scheduler (cron) + Webhook Receiver (HTTP)
Layer 2 — Routing        OpenClaw Gateway (Node daemon) + Skill Router
Layer 3 — Cognition      LLM Reasoning Core ⟷ Knowledge Graph
Layer 4 — Execution      Action Layer (GitHub, shell) + Output Layer (Telegram)
```

LLM routing rule: **Nemotron-70B for incidents, Nemotron-Mini for routine.** This is a cost-and-latency decision; do not invert it.

---

## Tech Stack (Locked)

| Concern | Choice |
|---|---|
| Runtime | Node 20+, ESM only |
| Language | TypeScript 5+, `strict: true`, `noUncheckedIndexedAccess: true` |
| Monorepo | pnpm workspaces |
| Storage | SQLite via `better-sqlite3` (synchronous, single-process) |
| Validation | Zod at every I/O boundary |
| Tests | Vitest |
| LLM SDK | `openai` (OpenAI-compatible client targeting Together.ai or OpenRouter) |
| HTTP | Express |
| Cron | `node-cron` |
| Telegram | `node-telegram-bot-api` |
| GitHub | `@octokit/rest` |
| Logging | `pino` (JSON, structured) |
| Env | `dotenv` |

**Model strings (read from env, not hard-coded):**
- `env.LLM_MODEL_INCIDENT` — default `nvidia/Llama-3.1-Nemotron-70B-Instruct-HF`. Used for incident reasoning, causal synthesis. The "Sonnet-tier" slot.
- `env.LLM_MODEL_ROUTINE` — default `nvidia/Nemotron-Mini-4B-Instruct`. Used for morning briefs, PR digests, sprint risk, routine summaries. The "Haiku-tier" slot.

Endpoint config:
- `env.LLM_API_KEY` — Together.ai or OpenRouter API key
- `env.LLM_BASE_URL` — defaults to `https://api.together.xyz/v1`. Set to `https://openrouter.ai/api/v1` for OpenRouter.

Do not use other models or providers without asking. Do not bypass the env vars by hard-coding model strings.

---

## Repo Layout

```
/
├── CLAUDE.md                    (this file)
├── package.json                 (workspace root)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.example
├── packages/
│   ├── shared/                  Telegram client, logger, types, Zod schemas
│   ├── kg/                      Knowledge Graph — THE MOAT
│   ├── gateway/                 Express server, webhook routing, cron
│   ├── brief/                   Morning intelligence brief
│   ├── incident/                Incident Commander (showstopper)
│   ├── pr/                      PR & Code Health Monitor
│   └── sprint/                  Sprint Risk Radar (cuttable)
└── demo/
    ├── fire-webhook.ts          Stage incident demos
    ├── kg-viz/                  D3 force graph for closing slide
    └── stopwatch.html           On-screen timer for live demo
```

Every package has: `src/index.ts` (public exports), `src/*.ts` (impl), `test/*.test.ts`, `package.json`, `tsconfig.json`.

---

## Knowledge Graph Schema (Authoritative)

This schema is locked. Do not add, rename, or repurpose node/edge types without explicit approval.

### Node types

```ts
type NodeType =
  | 'Engineer'    // { id, name, github_handle, email, current_load: number }
  | 'PR'          // { id, number, title, author_id, status, created_at, merged_at?, files_changed: string[] }
  | 'Incident'    // { id, severity: 'P0'|'P1'|'P2', service_id, title, started_at, resolved_at?, root_cause? }
  | 'Service'     // { id, name, repo, owner_team, criticality: 'critical'|'standard' }
  | 'Sprint'      // { id, number, start_date, end_date, planned_points, completed_points?, risk_score? }
  | 'Decision'    // { id, type: 'ADR'|'RFC', title, status: 'open'|'accepted'|'rejected', created_at }
  | 'Deploy';     // { id, sha, service_id, deployed_at, deployed_by_id, status: 'success'|'rolled_back' }
```

### Edge types

```ts
type EdgeType =
  | 'CAUSED_BY'   // Incident → Deploy (or Incident → PR)
  | 'TOUCHES'     // PR/Deploy → Service
  | 'AUTHORED'    // Engineer → PR
  | 'INFORMED'    // Decision → Incident (this ADR was written because of this incident)
  | 'RESOLVES'    // PR → Incident
  | 'BLOCKS'      // Incident → Sprint, or PR → PR
  | 'DEPLOYED';   // Engineer → Deploy
```

Edges have `created_at` and optional `metadata: Record<string, unknown>`.

### Required traversal queries

The `KnowledgeGraph` class must expose these five named queries. Every other consumer goes through them:

1. `findRecurringIncidents(serviceId: string, days: number): Incident[]`
2. `getCausalChain(incidentId: string): { incident, deploys, prs, engineers }`
3. `getEngineerLoad(engineerId: string): { open_prs, recent_incidents, review_queue_size }`
4. `getOpenADRs(serviceId?: string): Decision[]`
5. `getDeployImpact(deployId: string): { service, incidents_after, time_to_first_incident_ms }`

---

## Critical Constraints

| Constraint | Target | Why |
|---|---|---|
| Incident response (webhook → first Telegram token) | **< 60s** | Demo SLA; non-negotiable |
| Webhook ack | < 2s | Sentry/PagerDuty will retry otherwise |
| KG traversal (any of the 5 queries on seed data) | < 50ms | Many run in the incident hot path |
| LLM cost per incident | < $0.05 | Cost story is part of the pitch |
| LLM cost per morning brief | < $0.005 | Nemotron-Mini-only |
| Test suite | < 10s | We run it before every commit |

When optimizing, **always stream LLM output**. Do not wait for full completion before sending to Telegram.

---

## Conventions

**Error handling.** Throw at boundaries, catch at handlers. Never swallow errors — log with `pino` at `warn` or `error` level. Webhook handlers must always 200 the caller, even on internal failure (queue and retry async).

**Logging.** Structured JSON via `pino`. Every log line gets `{ component, traceId }`. The traceId is generated at the trigger and propagates through the entire flow (webhook → KG query → LLM call → Telegram send).

**Validation.** Zod-validate every external input (webhooks, API responses, env vars). Type assertions are forbidden outside of test files.

**Naming.** Functions are `camelCase`. Types are `PascalCase`. Files are `kebab-case.ts`. Database columns are `snake_case`. Telegram bot commands are `/lower_snake`.

**Comments.** Comments explain *why*, never *what*. If the code needs a what-comment, the code is wrong.

**Tests.** Every public function in `kg/` has a unit test. Every webhook handler has an integration test. The full incident flow has an end-to-end test that asserts <60s.

**Imports.** Workspace packages import via `@axon/kg`, `@axon/shared`, etc. — never relative paths across packages.

---

## What This Project Is NOT

- Not a chatbot. Axon does not respond to free-form messages. Telegram inputs are commands and button callbacks only.
- Not a dashboard. There is no web UI for end users. The only UI is Telegram and the KG visualization on the demo slide.
- Not multi-tenant. Single deployment, single CTO user, one Telegram chat.
- Not real-time streaming analytics. We poll, schedule, and react to webhooks.

---

## Demo Target (What "Done" Looks Like)

The 90-second demo arc is the success criterion:

1. **0:00** — Morning Brief on Telegram. Contains one KG-derived line (e.g., recurring incident pattern).
2. **0:15** — Webhook fires. Visible stopwatch starts.
3. **0:55** — Telegram alert lands. Causal chain + pattern context + open ADR + rollback button.
4. **1:10** — Tap rollback. Recovery monitor activates.
5. **1:25** — Run `addSkill('standup')` live. New Telegram message in <30s, proving extensibility.
6. **1:45** — KG visualization on closing slide.

If a feature does not contribute to that arc, it is lower priority.

---

## Build Phase Map

This project is built in 8 prompts (see `PROMPTS.md`). Always state which phase you are in.

| # | Phase | Output |
|---|---|---|
| 0 | Scaffold | Monorepo, env, tsconfig, dev script |
| 1 | KG | The moat. Don't move on until tests pass. |
| 2 | Gateway + Telegram | Webhook ingest, cron, output layer |
| 3 | Morning Brief | F2 |
| 4 | Incident Commander | F3 — the showstopper |
| 5 | PR Health | F5 |
| 6 | Sprint Risk | F4 — cuttable if behind |
| 7 | Demo polish | Stage scripts, KG viz, stopwatch |

---

## Failure Modes to Avoid

- **Adding scope.** If a request implies new node types, edge types, or skills, ask first.
- **Inventing schemas.** Use the schema in this file verbatim.
- **Skipping tests.** Every prompt's deliverable includes tests. Don't move on without green.
- **Premature abstraction.** No factories, no plugin systems, no DI containers. We have 5 features, not 50.
- **LLM tokens leaking into low-value paths.** Routine = Nemotron-Mini. Nemotron-70B only on incidents.
- **Silent failures in webhook handlers.** Always log, always trace.

---

## Quick Commands

```bash
pnpm install                  # bootstrap
pnpm dev                      # start gateway daemon
pnpm test                     # run all tests
pnpm typecheck                # tsc --noEmit across workspaces
pnpm --filter @axon/kg test   # test a single package
pnpm seed                     # populate the KG with demo data
```

---

## Glossary

- **OpenClaw Gateway** — the Node daemon that routes triggers to skills. Lives in `packages/gateway`.
- **Skill** — a feature module (brief, incident, pr, sprint). Each is its own package.
- **ADR** — Architecture Decision Record. Stored as `Decision` nodes with `type: 'ADR'`.
- **Causal chain** — for an incident, the chronologically ordered set of deploys/PRs that touched the affected service in the preceding window.
- **Pattern context** — output of `findRecurringIncidents` formatted for an LLM prompt.

---

*Last reviewed: maintain this file. If you change a schema or constraint, update CLAUDE.md in the same commit.*