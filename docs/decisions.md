# Design Decisions

The "why" log. Every entry exists because someone, six months from now, will look at the code and ask "why on earth did they do it like *that*". Most of the time, the answer is: there's a constraint not visible from the source.

Items are roughly in order of locked-in-ness — schema and provider are bedrock; UI choices in the demo kit are easy to revisit.

---

## Provider choice: Nemotron via Together.ai

**Decision.** The LLM provider is **Together.ai (default) or OpenRouter** through the OpenAI-compatible `openai` SDK. Default models are `nvidia/Llama-3.1-Nemotron-70B-Instruct-HF` for incidents and `nvidia/Nemotron-Mini-4B-Instruct` for routine work. The user explicitly chose this over Anthropic mid-Phase-0; CLAUDE.md was updated in the same change to lock it in.

**Why.** User preference, taken before any LLM code was written.

**Implications.**

- The "Sonnet" and "Haiku" tier names from `prompts.md` map to `LLM_MODEL_INCIDENT` and `LLM_MODEL_ROUTINE` respectively. *Don't follow `prompts.md` literally* on this point — substitute the env vars.
- The four skill packages (`brief`, `incident`, `pr`, `sprint`) depend on the `openai` package, **not** `@anthropic-ai/sdk`. Don't reintroduce the latter.
- Model strings come from env, never hard-coded. Adding a new skill that hard-codes a model string is a code-review reject.
- A swap to a non-OpenAI-compatible provider (Anthropic native, Vertex) is a real change — see [extending.md § Provider swaps](extending.md#provider--model-swaps).

---

## Nested payload, not flat spread

**Decision.** The TS Node discriminated union is `{ id, type, created_at, payload: <type-specific> }` — *nested* — not the flat-spread shape (`...payload`) suggested in `prompts.md`.

**Why.** `Decision`'s payload literally has a field named `type` (`'ADR' | 'RFC'`) — see [CLAUDE.md § Knowledge Graph Schema](../CLAUDE.md#knowledge-graph-schema-authoritative). Under flat-spread, that collides with the outer node `type` discriminator and TypeScript can't form a clean discriminated union.

**Implications.**

- Access pattern is `node.payload.foo`, not `node.foo`. Every consumer site uses this.
- The JSON `payload` column in the `nodes` table matches CLAUDE.md's payload shape exactly. The deviation is in the TS wrapper only.
- This is the only deviation from CLAUDE.md's literal text. Don't introduce others.

Saved to memory (`kg_node_shape.md`) so future Claude sessions don't second-guess.

---

## `env` and `logger` aren't in the `@axon/shared` barrel

**Decision.** `import { env, logger } from '@axon/shared'` doesn't work. Use the subpath imports:

```ts
import { env } from '@axon/shared/env';
import { logger } from '@axon/shared/logger';
```

**Why.** Env validation runs at module load — if a single `import` from the barrel transitively pulled in env, every test in the workspace would have to provide a full valid env Zod object before *anything* could be imported. With the subpath split, the barrel exports only zero-side-effect modules (`telegram`, `trace`, `meta`); env loads only when boot code (or a CLI) explicitly asks for it.

**Implications.**

- `package.json` has `exports: { ".", "./env", "./logger", "./trace", "./telegram" }` so the subpath imports resolve.
- Boot code lives in `packages/gateway/src/main.ts` and the `cli/run-now.ts` files of each skill. *Those* files import env. Nothing else should.
- A new skill should follow the same rule. Tests get cheap; boot code remains explicit about its env coupling.

---

## Workspace `main` and `types` point at `src/index.ts`

**Decision.** Each workspace `package.json` has `"main": "src/index.ts"` and `"types": "src/index.ts"`. We don't ship a built `dist/` and use it internally.

**Why.** `tsx` and `vitest` both resolve TS source via the workspace links. Pointing at `dist/` would force a build step before every dev run for no benefit.

**Implications.**

- `pnpm build` (`tsc` per package) still works and emits `dist/` — but nothing in the project's runtime path uses it.
- When we eventually publish or ship a built artifact, this gets reworked: `exports` field with `"types"` and `"default"` conditionals, `dist/` becomes the production path. Not Phase 0–7 work.

---

## Off-by-one in env.ts repo-root resolution

**Decision.** `packages/shared/src/env.ts` walks **three** `..` from `import.meta.url` to find repo root, not four. (Phase 0 originally wrote four, which pointed one level above the repo. The seed CLI got the same fix.)

**Why.** From `packages/shared/src/env.ts`: `..` → `packages/shared/src` → `packages/shared` → `packages/` → repo root is three hops, not four. Phase 0 tests never exercised this because they imported from `meta.ts` directly to avoid env loading; Phase 2 was the first time the gateway actually `dotenv.config`'d.

**Implications.**

- If env loading fails with "all variables missing" but `.env` exists at repo root, suspect a path bug like this. The dotenv injection log line (`◇ injected env (N) from …`) tells you what file dotenv found and how many vars it loaded.

---

## `KG_DB_PATH` defaults to absolute path

**Decision.** The seed CLI in [packages/kg/src/seed.ts](../packages/kg/src/seed.ts) resolves `KG_DB_PATH` to **repo root** when unset, via `import.meta.url`. The gateway resolves it from `.env`, which we recommend setting to an absolute path.

**Why.** During Phase 4 the demo failed because `pnpm seed` (cwd = `packages/kg`) and `pnpm dev` (cwd = `packages/gateway`) both interpreted the default `./data/axon.db` relative to *their own* cwd. Different files. Took a confusing hour to find.

**Implications.**

- `.env.example` keeps the relative default for documentation, but real deployments should use absolute paths.
- The seed CLI is robust to cwd changes — it always writes to repo-root `data/axon.db` unless `KG_DB_PATH` is explicitly set.

---

## `Promise.allSettled` at the fetcher boundary

**Decision.** Skills that fan out to multiple external services — morning brief, incident enrich — use `Promise.allSettled`, normalize rejections to `{ ok: false, error }`, and pass the union to the LLM as `<error>…</error>` in the relevant XML section.

**Why.** A morning brief that crashes because Linear's API is down isn't a brief — it's a 6 AM page to the on-call. The LLM is genuinely good at acknowledging gaps ("Sentry data unavailable today") when given the failure inline; better than synthesizing without it and pretending the data was complete.

**Implications.**

- Test fixtures cover both `ok: true` and `ok: false` paths for every fetcher.
- A new fetcher should follow the pattern: catch internally, return the discriminated union. Don't throw across the boundary.

---

## Realtime PR alert has no LLM

**Decision.** The realtime path in [packages/pr/src/realtime.ts](../packages/pr/src/realtime.ts) does *not* call the LLM. The alert is templated text: `Critical-path PR by {author} touching {service}: {title}\n{url}`.

**Why.** Sub-second latency target. An LLM call adds 500–2000ms. The realtime path's job is *immediate* visibility, not synthesis — synthesis is the digest's job at 6 PM.

**Implications.**

- A test in [realtime.test.ts](../packages/pr/test/realtime.test.ts) structurally asserts the function source contains no `'openai'` string. Removing it is a regression.
- If you find yourself wanting to "summarize the diff" in realtime, push that to the digest instead.

---

## Acknowledge state is in-memory

**Decision.** [packages/incident/src/actions.ts](../packages/incident/src/actions.ts) tracks ack state in a module-level `Map<incidentId, AckRecord>`. It does not persist across gateway restarts.

**Why.** CLAUDE.md's `Incident` payload schema doesn't include a `metadata` field. Adding one would be a schema deviation. For Phase 4 demo purposes, the Telegram message edits to "✓ Acknowledged by …" are sufficient — the audience never sees the across-restart case.

**Implications.**

- If you restart the gateway during the demo, ack state resets. Don't restart during the demo.
- Path forward: add `metadata?: Record<string, unknown>` to `IncidentPayload` (CLAUDE.md update + Zod schema update + same-commit migration). Documented as a follow-up; not Phase 4–7 scope.

---

## Rollback issues, not PRs

**Decision.** The rollback action opens a labelled GitHub Issue (`axon-rollback`), not a true revert PR.

**Why.** Generating a real revert commit and pushing it is fragile (which branch? merge conflicts?), repo-specific, and risky to demo. An issue with the SHA in the title and the `axon-rollback` label is idempotent (search by label + title), gives the team a clear owner, and wires cleanly into existing CI/CD that already watches for label-driven actions.

**Implications.**

- The Telegram thread reply contains the issue URL, not a PR URL. The audience sees a clickable link land — same demo beat.
- A follow-up to wire actual revert PRs is feasible: take the deploy SHA, find its parent on the deploy's target branch, generate a revert via Octokit's `git.createCommit` chain, open a PR. Not in this build.

---

## `recentDeploys` from Octokit, not the KG

**Decision.** [packages/incident/src/enrich.ts](../packages/incident/src/enrich.ts) gets recent deploys from `octokit.repos.listCommits` over the last 4h, not from KG `Deploy` nodes.

**Why.** The named-queries-only constraint blocks fetching Deploy nodes filtered by service+window from the KG (no such named query exists). The five named queries are the public KG surface; adding a sixth for this would have been a schema-policy violation. Octokit returns the data we need with one call.

**Implications.**

- The `RecentDeploy` type is Octokit-shaped (sha, title, author_handle, deployed_at, url), not a full KG `Deploy` node. The `<recent_deploys>` XML the LLM sees still gives it author handles + SHAs + minutes-ago — enough to ground the alert.
- If we ever ingest deploys into the KG (a deploy webhook from CI), the enrich path can be tightened: union of KG-stored Deploys in window + Octokit fallback.

---

## Edit throttle at 800ms

**Decision.** During the streaming-edit phase of an incident response, [packages/incident/src/synthesize.ts](../packages/incident/src/synthesize.ts) only edits the Telegram message every 800ms.

**Why.** Telegram's edit-rate limits are not publicly documented but anecdotally hit 429s above ~1Hz on a single chat. 800ms is the sweet spot — feels live to the audience, doesn't get rate-limited mid-stream.

**Implications.**

- The final edit (with the keyboard) always fires, regardless of when the last throttled edit was. So the audience sees the buttons appear.
- Test e2e doesn't verify the throttle directly (timing-sensitive); the behaviour is exercised in dev smoke runs.

---

## In-memory queue, no Redis

**Decision.** The job queue is a `Map<type, Job[]>` in process memory. No Redis, no SQS, no message broker.

**Why.** Single-process daemon is the deployment target. The queue's job is to handle the bursty webhook → incident handler path, not durability across restarts. If the gateway crashes, in-flight Sentry events would be re-fired by Sentry on retry — and in any case, demos are short.

**Implications.**

- A 1000-job backpressure cap; `enqueue` throws when hit. Should never hit in practice — incident bursts are rare.
- Multi-process scaling requires replacing the queue with Redis or similar. Not in scope.

---

## Webhook handlers always return 200

**Decision.** Once the HMAC validates, `/webhook/sentry` and `/webhook/github` always return 200 — even if Zod parsing fails or the queue refuses to enqueue.

**Why.** Sentry and GitHub both retry on non-2xx. Retries don't fix a Zod bug or a full queue. Returning 200 + logging the failure is the right shape: we've absorbed the work; we'll diagnose it from the log.

**Implications.**

- A 401 on a webhook means HMAC mismatch — *that* is retryable, and the upstream service will retry.
- Bad-shape payloads land as warning-level log lines, not 4xx responses. Search the gateway log for `'sentry webhook bad signature'`, `'invalid json'`, `'invalid payload shape'`.

---

## `LOG_FILE` for demo SLA tooling

**Decision.** The gateway optionally tees pino output to `env.LOG_FILE` via `pino.multistream`. `demo/fire-webhook.ts` tails this file for the `incident pipeline first-token sent` log line matching its trace id, then prints the SLA result.

**Why.** The demo's SLA story needs a *number* on screen. We could have spun up an HTTP endpoint that emits the timing, but that's another piece of infrastructure for one demo feature. File tail is two-line config + 30 lines of polling code in `fire-webhook.ts`.

**Implications.**

- Without `LOG_FILE` set, fire-webhook still runs but only reports the webhook-ack round-trip — no first-token timing.
- The chosen IPC is fragile if log format changes. The contract: a JSON line containing the trace id and the literal string `incident pipeline first-token sent`. Don't rename that message without updating fire-webhook.

---

## Three crons, all `Asia/Kolkata`

**Decision.** All three crons (`morning-brief`, `pr-digest`, `sprint-risk`) pin their timezone to `Asia/Kolkata` regardless of the host clock.

**Why.** Samsung SRI-B is in Bangalore. The product timezone is fixed; running a brief at 8 AM "system time" on a US-based laptop would land at 8 PM IST. Pin to the user timezone.

**Implications.**

- node-cron's timezone option is honoured; we don't roll our own scheduling.
- A presenter demoing in a different timezone still sees the same fire times — useful when prep is done at 2 AM EST and the demo is at 11 AM IST.

---

## What is intentionally *not* abstracted

A few things you might expect a "production" service to have, that this build doesn't:

- **No DI container.** Every skill takes ctx as the first arg. That's it.
- **No plugin system.** Adding a skill is a code change + boot wiring, not a registry entry. Five skills don't need plugin scaffolding.
- **No metrics emitter.** Logs are the single output channel. If we need Prometheus metrics later, pino → fluent-bit → Prometheus is one config file, not a code change.
- **No HTTP middleware framework beyond Express.** No Fastify, no NestJS. Express's middleware chain is a thin layer; we use it directly.
- **No factory functions.** Skills are wired by name in `main.ts`. Five `register*` calls. Inserting a sixth is one line.

This is the "no premature abstraction" principle CLAUDE.md calls out by name. We have five skills, not fifty.
