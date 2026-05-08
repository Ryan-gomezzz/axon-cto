# Axon

> A synthetic engineering chief of staff. Not a dashboard. Not a chatbot.

Axon turns engineering signals — Sentry incidents, GitHub PRs, Linear blockers, deploys — into one Telegram message at a time, grounded in a typed knowledge graph that no stateless agent can produce.

Built for Samsung SRI-B *Clash of the Claws*, Round 2.

---

## The thesis in one sentence

A typed knowledge graph (the moat) connects engineers, services, deploys, incidents, PRs, decisions, and sprints — and every alert Axon sends pulls a sentence out of that graph that a generic LLM cannot.

The demo is the proof:

> *"3rd auth-service incident this month — pattern matches Redis connection exhaustion. ADR-014 from incident #1 is still open. Last fix: PR #847 by Aditi."*

That sentence is the moat. The rest of the system is surfaces that prove it works.

---

## Three principles

- **Proactive** — Axon pushes decisions to Telegram before the user asks. Cron heartbeats; webhook reactions.
- **Synthesized** — Never a raw number without a contextual sentence. *11 PRs merged* is wrong. *11 PRs merged in 24h, none on critical paths — load is healthy* is right.
- **Autonomous** — Silence is a feature. Only escalates on threshold breaches.

---

## The 90-second demo arc

```
0:00  Morning brief on Telegram (cron at 8 AM IST)
0:05  Click stopwatch — "<60s SLA, watch the clock"
0:10  Fire synthetic auth-service Sentry webhook
0:30  Telegram alert: causal chain + 3rd-incident pattern + open ADR + buttons
0:45  Tap [Rollback] → GitHub revert issue created
1:00  add-skill.ts standup → posts in <5s ("KG makes adding skills trivial")
1:15  Open kg-viz force graph — narrate the moat
1:30  Land
```

Full script + preflight: [`demo/README.md`](demo/README.md).

---

## Quick start

Prereqs: Node 20+, pnpm 8+, build tools for `better-sqlite3` (`build-essential` on Linux, Xcode CLI tools on macOS).

```bash
git clone <this repo>
cd axon-cto

# 1. Install
pnpm install

# 2. Configure
cp .env.example .env
$EDITOR .env   # fill in tokens — see docs/operations.md

# 3. Seed the knowledge graph (creates ./data/axon.db with 52 nodes / 65 edges)
pnpm seed

# 4. Run the gateway
pnpm dev
# → "gateway listening on port 3000"
# → cron registered: morning-brief, pr-digest, sprint-risk
```

Verify the install end-to-end:

```bash
pnpm typecheck       # all 7 packages clean
pnpm test            # 127 tests across 7 packages
```

Manually trigger any of the four skills (handy during demo prep):

```bash
pnpm exec tsx packages/brief/src/cli/run-now.ts        # morning brief
pnpm exec tsx packages/sprint/src/cli/run-now.ts       # sprint risk digest
pnpm exec tsx packages/pr/src/cli/run-now.ts           # PR-health digest
pnpm exec tsx demo/fire-webhook.ts                     # synthetic incident
pnpm exec tsx demo/add-skill.ts standup                # the extensibility flex
```

---

## Repo layout

```
axon-cto/
├── CLAUDE.md                  Source of truth — schema, conventions, constraints
├── README.md                  You are here
├── docs/                      Architecture / KG / skills / ops / extending / decisions
├── demo/                      90-second demo kit (fire-webhook, stopwatch, kg-viz, add-skill)
├── packages/
│   ├── shared/                Telegram client, logger, env, trace propagation
│   ├── kg/                    Knowledge graph — THE MOAT
│   ├── gateway/               Express server, webhooks, queue, scheduler, boot
│   ├── brief/                 Morning intelligence brief         (cron, Nemotron-Mini)
│   ├── incident/              Incident commander                  (webhook, Nemotron-70B)
│   ├── pr/                    PR & code-health monitor           (webhook + cron)
│   └── sprint/                Sprint risk radar                  (cron, Nemotron-Mini)
└── data/
    └── axon.db                SQLite — the graph store
```

Each skill package follows the same shape: `register.ts` wires it into the gateway's queue/scheduler at boot, `handler.ts` is the job, `synthesize.ts` does the LLM call (streaming, model from env), and CLI scripts under `src/cli/` make manual triggering one-line.

---

## Where to read more

| Topic | File |
|---|---|
| Four-layer architecture, request flow | [docs/architecture.md](docs/architecture.md) |
| The knowledge graph: schema, queries, why it's typed | [docs/knowledge-graph.md](docs/knowledge-graph.md) |
| What each skill does and when it fires | [docs/skills.md](docs/skills.md) |
| Env vars, scripts, dev loop, shutdown, observability | [docs/operations.md](docs/operations.md) |
| Adding a fifth skill | [docs/extending.md](docs/extending.md) |
| Notable design decisions (the "why" log) | [docs/decisions.md](docs/decisions.md) |
| Project memory — schemas, conventions, locked choices | [CLAUDE.md](CLAUDE.md) |
| Build phases (8 prompts that produced this code) | [prompts.md](prompts.md) |

---

## Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node 20+, ESM only |
| Language | TypeScript 5+, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Monorepo | pnpm workspaces (7 packages) |
| Storage | SQLite via `better-sqlite3` (sync, single-process, WAL) |
| Validation | Zod at every I/O boundary |
| HTTP | Express |
| Cron | `node-cron`, timezone pinned to `Asia/Kolkata` |
| LLM SDK | `openai` (OpenAI-compatible, pointed at Together.ai or OpenRouter) |
| LLM models | `LLM_MODEL_INCIDENT` for incidents (Nemotron-70B), `LLM_MODEL_ROUTINE` for routine work (Nemotron-Mini) |
| Telegram | `node-telegram-bot-api` polling for callbacks; raw `fetch` for `send`/`edit` (with retry + auto-escape) |
| Logging | `pino` JSON, optional file tee via `LOG_FILE` |
| Tests | Vitest |

Locked: see [CLAUDE.md § Tech Stack](CLAUDE.md). Don't swap providers without updating CLAUDE.md in the same change.

---

## Status

- All 7 phases complete (scaffold → KG → gateway → brief → incident → PR → sprint → demo polish).
- 127 tests passing, typecheck clean.
- Demo kit verified end-to-end (incident SLA infrastructure, kg-viz, log-tail IPC).
- Demo video (`demo/axon-demo.mp4`) is presenter homework — see [demo/README.md § Recording](demo/README.md#recording-the-demo-video).

---

## License

MIT. See `LICENSE` if present, otherwise treat the contents of this repo as MIT-licensed for the purpose of this submission.
