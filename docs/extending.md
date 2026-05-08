# Extending Axon

Adding a fifth skill, an action, or a node type. The shapes the existing code already follows.

---

## Adding a fifth skill

The four existing skills (brief, incident, pr, sprint) are deliberately the same shape. If you copy one of them as a starting point, the gateway picks the new skill up at boot with one line of code change.

### Decide first

Two questions before you write a line:

1. **What's the trigger?** Cron? Webhook? Both? Most skills are one or the other.
2. **What does the LLM see?** Sketch the user-message XML on paper. If it doesn't have a `<patterns>` section pulling from the KG, the skill is fluff — go back and find the KG-grounded bit.

If the answer to (2) is *"I don't think the KG has the right data"*, you need to extend the schema before you write the skill. See [knowledge-graph.md § Extending the schema](knowledge-graph.md#extending-the-schema).

### The shape

Copy `packages/sprint` (the cleanest of the four) into `packages/<your-skill>` and rename. Each skill has the same files:

```
packages/<your-skill>/
├── package.json              "@axon/<your-skill>", "workspace:*" deps on @axon/kg + @axon/shared
├── tsconfig.json             extends ../../tsconfig.base.json
├── src/
│   ├── types.ts              <Skill>Context, <Skill>Env, internal types
│   ├── handler.ts            export async function <skill>Job(ctx, traceId): Promise<void>
│   ├── synthesize.ts         system prompt + buildUserMessage + synthesize<Skill>
│   ├── format.ts             (optional) MarkdownV2 + IST footer
│   ├── register.ts           export function register<Skill>(ctx): void — duck-typed Like interfaces
│   ├── cli/run-now.ts        standalone trigger
│   └── index.ts              barrel
└── test/
    └── *.test.ts
```

### Step-by-step

1. **package.json** — match `@axon/sprint`'s. Workspace deps: `@axon/kg`, `@axon/shared`. Runtime deps: `openai`, `pino`. Add `@octokit/rest` if you need GitHub.

2. **types.ts** — define `<Skill>Context` with `kg`, `telegram`, `log`, `env` (subset of the validated env), and any **test seams** (`octokit?`, `fetch?`, `openaiClient?`, `now?`). Treat the test seams as part of the public API — your tests will use them, and skipping them makes the tests painful to write.

3. **handler.ts** — the entry function. Signature must be:

```ts
export async function <skill>Job(ctx: <Skill>Context, traceId: string): Promise<void>
```

Always resolves; never throws. Top-level try/catch logs `'<skill> failed'` with `elapsed_ms`.

4. **synthesize.ts** — same shape as `packages/sprint/src/brief.ts`. Three exports:

   - `<SKILL>_SYSTEM_PROMPT` — the system message. Hard-code KG-grounding rules.
   - `buildUserMessage(input): string` — pure function from your snapshot type to XML. Test it with an inline snapshot.
   - `synthesize<Skill>(input, ctx, deps?): Promise<string>` — calls the OpenAI SDK, `stream: true`, model from `env.LLM_MODEL_ROUTINE` (or `_INCIDENT` if you really need 70B). The `deps.client?` test seam lets you inject a fake.

5. **register.ts** — declare local `QueueLike` and/or `SchedulerLike` interfaces (don't import from `@axon/gateway` — circular). Export `register<Skill>(ctx): void` that wires the queue handler and/or cron.

6. **cli/run-now.ts** — uses `@axon/shared/env` and `@axon/shared/logger`, builds a real ctx, calls `<skill>Job(ctx, newTraceId())`. One-line trigger for demo prep.

7. **index.ts** — barrel. Re-export `register<Skill>`, `<skill>Job`, `synthesize<Skill>`, all types.

8. **Tests** — copy structure from `packages/sprint/test/`. At minimum:
   - One score/format/parse test file with no IO (pure fixtures).
   - One handler test with full mocked deps. Assert the LLM is called with the right model and `stream: true`.
   - If you have an SLA, an e2e test under `vi.useFakeTimers()` that asserts the budget.

9. **Wire it into the gateway**. In [packages/gateway/src/main.ts](../packages/gateway/src/main.ts):

```ts
import { register<Skill>, type <Skill>Context } from '@axon/<your-skill>';
// ...
const <skill>Ctx: <Skill>Context = {
  kg, telegram, log: log.child({ component: '<your-skill>' }),
  env: { /* the subset your skill needs */ },
};
register<Skill>({ ...<skill>Ctx, scheduler });   // or { ...<skill>Ctx, queue }, or both
```

10. **Add `@axon/<your-skill>: workspace:*`** to `packages/gateway/package.json`'s `dependencies`. Run `pnpm install`.

11. **Run the suite** — `pnpm typecheck && pnpm test`. Both should pass before you boot the gateway.

12. **Smoke** — `pnpm dev`, look for your skill's cron in the boot log; `pnpm exec tsx packages/<your-skill>/src/cli/run-now.ts` to fire it manually.

### What not to do

- **Don't import `@axon/gateway`.** The gateway depends on every skill at boot; the reverse import is a cycle. Use the duck-typed `QueueLike` / `SchedulerLike` interfaces in `register.ts`.
- **Don't `import { env } from '@axon/shared'`**. Pull from `@axon/shared/env` (subpath export). The barrel doesn't include env to keep test-time loading cheap.
- **Don't add new KG queries casually.** The five named queries are the budget. If your skill needs something exotic, ask whether it can be expressed as a composition of the existing five plus the inspection helpers (`getNode`, `getEdges`, `traverse`).
- **Don't put env in the skill context type.** Take a *subset* of env on the context type so tests can build a valid context with only the fields the skill reads. This is what `BriefEnv`, `IncidentEnv`, etc. are for.

---

## Adding a new action

Actions are how Axon does things to the outside world (rollback, acknowledge, escalate). They live alongside the skill that owns them.

The pattern, from [packages/incident/src/actions.ts](../packages/incident/src/actions.ts):

1. **Each action is a single async function** that takes the skill ctx + a `MessageRef` (Telegram message reference) + whatever per-action args are needed.
2. **Idempotent.** A second call with the same args must be a no-op or return the same outcome. The rollback action checks an in-memory `Set<sha>` *and* searches GitHub for an existing labelled issue before creating one.
3. **Log on failure, swallow.** An action that throws kills the callback handler. Log + return an `{ ok: false, message }` object, and post the message back to Telegram as a thread reply.
4. **Wire into `dispatchCallback`.** The callback router parses `${action}:${incidentId}[:extra]` and calls the right function.

The Telegram callback infrastructure ([packages/shared/src/telegram.ts § onCallback](../packages/shared/src/telegram.ts)) handles polling and answering; your action just gets the `data` string and a `CallbackContext`.

---

## Adding to the demo arc

The 90-second arc in [demo/README.md](../demo/README.md) is tight. If you're adding to it, replace something rather than insert — the time budget is unforgiving on stage.

The most likely insertion point is **between step 5 (add-skill standup) and step 6 (kg-viz)**, where you can fire one more KG-grounded action that proves a new skill. Five seconds, no more.

Recording the new arc:

1. Update [demo/README.md](../demo/README.md) — both the timed arc and the preflight checklist.
2. Re-record `demo/axon-demo.mp4`. Two takes, keep the better one.
3. Dry-run on the demo machine before stage time. Twice.

---

## Adding a node or edge type

This is the hardest change in the codebase to do well, because the schema is what makes the moat work.

The procedure:

1. **Read [knowledge-graph.md § Extending the schema](knowledge-graph.md#extending-the-schema).**
2. **Update the Zod schema** in [packages/kg/src/schema.ts](../packages/kg/src/schema.ts).
3. **Update CLAUDE.md** in the same commit — the schema is locked there, and the lock is the project-memory invariant.
4. **Update the seed** in [packages/kg/src/seed.ts](../packages/kg/src/seed.ts) so node count and edge count keep clearing the perf-test threshold.
5. **Update [docs/decisions.md](decisions.md)** — explain *why*, in two sentences. Future-you will thank present-you.
6. **Decide whether you need a new named query.** Most don't. If you do, write the perf test alongside it: it must clear 50ms p95 over 100 runs against the seed.
7. **Run the full suite.** `pnpm typecheck && pnpm test`. The whole suite must stay green.

Don't add a node or edge type for one skill's benefit. The schema is shared by all five skills — if a type only one skill uses, that's a smell that the type belongs in the skill's local types, not the KG.

---

## Provider / model swaps

Swapping `LLM_MODEL_INCIDENT` or `LLM_MODEL_ROUTINE` is just an `.env` edit — the model strings come from env, never hard-coded. Verify the new model:

- Streams (most do).
- Honours `max_tokens` reliably.
- Doesn't insert markdown formatting in places the prompt forbids.

Swapping the *provider* (Together → OpenRouter → some other OpenAI-compatible endpoint) is `LLM_BASE_URL` + `LLM_API_KEY`. The SDK is provider-agnostic.

Swapping to a non-OpenAI-compatible provider (Anthropic native, Google Vertex, etc.) is a real change:

1. Replace `openai` with the new SDK in the four skills' `synthesize*.ts`.
2. Update CLAUDE.md.
3. Update the test mocks (the `vi.mock('openai', …)` blocks become `vi.mock('@anthropic-ai/sdk', …)` or whatever).

The locked memory at `~/.claude/projects/c--axon-cto/memory/llm_provider.md` documents the current Nemotron-via-Together choice as a deliberate one — don't silently revert.
