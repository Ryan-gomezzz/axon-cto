# The Knowledge Graph

The KG **is** the moat. Everything else is a surface that proves the moat works.

This page explains what's in the graph, how to query it, and why the schema looks the way it does.

The locked schema lives in [CLAUDE.md § Knowledge Graph Schema](../CLAUDE.md#knowledge-graph-schema-authoritative) — what's below is the explanation, not the spec.

---

## Why a typed graph (and not vector embeddings)

A generic LLM with vector retrieval can paraphrase your incident history. It cannot say:

> *3rd auth-service incident this month — pattern matches Redis connection exhaustion. ADR-014 from incident #1 is still open. Last fix: PR #847 by Aditi.*

That sentence is doing four things at once:

1. **Counting** typed entities (incidents on a service in a window).
2. **Joining** entities through typed relationships (incidents → ADRs that informed them).
3. **Time-windowing** (last 30 days, "this month").
4. **Resolving** an engineer through `AUTHORED` to a specific PR.

Vectors can't count, can't join, and can't reliably window. A typed graph can do all four in milliseconds. That's the moat. Resist suggestions to "simplify" by collapsing the schema or replacing the KG with a vector DB; that's the locked-in decision in CLAUDE.md.

---

## Where it lives

- **Storage**: SQLite via `better-sqlite3` ([packages/kg/src/db.ts](../packages/kg/src/db.ts)). Two tables — `nodes` and `edges` — both keyed by stable string ids. JSON payloads in TEXT columns; indexes on `nodes.type`, `edges(source_id, edge_type)`, `edges(target_id, edge_type)`. WAL mode + `synchronous=NORMAL`.
- **API**: [`KnowledgeGraph`](../packages/kg/src/graph.ts) class. Synchronous (`better-sqlite3` is sync — there are no async wrappers, by design).
- **Validation**: Zod schemas in [packages/kg/src/schema.ts](../packages/kg/src/schema.ts) parse every payload on read and write. A type assertion outside test code is a bug.
- **Seed**: 52 nodes / 65 edges produced by `pnpm seed`. Deterministic IDs (`engineer-aditi`, `service-auth`, `incident-auth-1`, …) so tests can assert on specific entities.

---

## Schema, in plain English

Seven node types:

| Type | What it represents |
|---|---|
| `Engineer` | A person on the team. Tracks `current_load` (a number — used by `getEngineerLoad`). |
| `PR` | A pull request. Carries `files_changed`, `status`, `merged_at`, the GitHub `number`. |
| `Incident` | A production failure event. `severity: P0/P1/P2`, `service_id`, `started_at`, optional `resolved_at` and `root_cause`. |
| `Service` | A deployable unit. Has a `repo` URL and a `criticality: critical | standard`. |
| `Sprint` | A bounded time window with `planned_points`, optional `completed_points` and `risk_score`. |
| `Decision` | An ADR or RFC. `type: ADR/RFC`, `status: open/accepted/rejected`. |
| `Deploy` | A commit pushed to a service. `sha`, `deployed_at`, `deployed_by_id`, `status: success/rolled_back`. |

Seven edge types — every one of them corresponds to a real thing engineers say out loud:

| Edge | Direction | Reading |
|---|---|---|
| `CAUSED_BY` | Incident → Deploy/PR | "this incident was caused by that deploy" |
| `TOUCHES` | PR/Deploy → Service | "this PR/deploy touched that service" |
| `AUTHORED` | Engineer → PR | "Aditi wrote this PR" |
| `INFORMED` | Decision → Incident | "ADR-14 was written because of this incident" |
| `RESOLVES` | PR → Incident | "this PR is the fix" |
| `BLOCKS` | Incident/PR → Sprint or PR | "this incident blocks the current sprint" / "PR A blocks PR B" |
| `DEPLOYED` | Engineer → Deploy | "Raj shipped this deploy" |

Edges carry `created_at` (always) and optional `metadata: Record<string, unknown>` (rare; webhook origin, e.g.).

### TS shape

In storage, every node is `{ id, type, created_at, payload: <type-specific> }`. The TypeScript `Node` discriminated union uses **nested payload** rather than the flat-spread shape originally suggested in `prompts.md`. The reason is structural: `Decision`'s payload literally has a field named `type` (`'ADR' | 'RFC'`) which collides with the outer discriminator under spread. Nested-payload preserves CLAUDE.md's payload shape verbatim while keeping the TS narrowing clean. Access pattern is `node.payload.title`, not `node.title`. See [decisions.md § Nested payload](decisions.md#nested-payload-not-flat-spread).

---

## The five named queries

CLAUDE.md mandates: *"every other consumer goes through them."* These are the only queries the skill packages are allowed to call against the KG. Anything else uses the inspection helpers (`getNode`, `getEdges`, `sampleNodesByType`).

All five are synchronous. All five are <50ms p95 against the seeded dataset, asserted by [packages/kg/test/perf.test.ts](../packages/kg/test/perf.test.ts) over 100 runs each.

### `findRecurringIncidents(serviceId, days): Incident[]`

> "Has this service been on fire repeatedly?"

Returns Incident nodes for `serviceId` whose `started_at` falls within the last `days` days, newest first. Uses `json_extract` over the indexed `type='Incident'` rows. Powers the morning brief's `recurringPatterns` and the incident commander's pattern-context line.

```ts
kg.findRecurringIncidents('service-auth', 30)
// → 3 incidents in the seed: incident-auth-1, -2, -3
```

### `getCausalChain(incidentId): { incident, deploys, prs, engineers }`

> "What broke this?"

Walks `Incident -CAUSED_BY-> Deploy/PR` and `PR -RESOLVES-> Incident`, then collects the engineers who `AUTHORED` those PRs and `DEPLOYED` those deploys. Deduped. The single most complex of the named queries; uses three subqueries with `IN (?, ?, …)` placeholder lists from controlled-length arrays.

### `getEngineerLoad(engineerId): { open_prs, recent_incidents, review_queue_size }`

> "How buried is this engineer?"

- `open_prs`: PRs they `AUTHORED` with `status='open'`.
- `recent_incidents`: incidents in the last 30 days reachable through their PRs (`RESOLVES` or `CAUSED_BY`) or deploys (`DEPLOYED` → `CAUSED_BY`).
- `review_queue_size`: open PRs not authored by them, created in the last 7 days. A proxy — once we have real reviewer relations, this becomes more accurate; the call sites don't change.

Used by the morning brief, sprint risk, and the PR digest.

### `getOpenADRs(serviceId?): Decision[]`

> "What architectural decisions are still unresolved?"

All ADRs (`type='ADR'`) with `status='open'`. With a `serviceId`, filtered to those `INFORMED` by an incident on that service. Powers the "ADR-X still open" line in incident alerts and the open-ADR section of the morning brief.

### `getDeployImpact(deployId): { service, incidents_after, time_to_first_incident_ms }`

> "Did this deploy break things?"

Finds the Service this Deploy `TOUCHES`, then incidents on that service whose `started_at > deploy.deployed_at`, plus the ms gap to the first one (`null` if none). Used by post-rollback recovery checks and the demo viz.

---

## Inspection helpers (not "queries")

These are infrastructure primitives, available to any consumer:

- `getNode(id)` / `getNode(id, expectedType)` — type-narrowed read.
- `getEdges(nodeId, direction, edgeTypes?)` — direction is `'out' | 'in' | 'both'`.
- `traverse(startId, edgeTypes, maxDepth)` — BFS, deduplicates, respects depth. Returns nodes including the start.
- `sampleNodesByType(type, limit)` — newest-first sample. Used by the seed dump and demo viz.
- `countNodesByType` / `countEdgesByType` / `totalNodeCount` / `totalEdgeCount` — read-only counts for status output.
- `updatePayload(id, type, partial)` — merge partial onto a node's payload, re-validate against the Zod schema, write. The only mutation primitive that doesn't replace a node wholesale; used by `recovery.ts` to mark `resolved_at` and (in future) any other mid-lifecycle field.

The named queries are the *domain* surface; these are the *primitive* surface. Mixing them up in a skill package is a code-smell — the skill should be pulling causal chains, not wandering the graph.

---

## Performance characteristics

Indexes per [packages/kg/src/db.ts](../packages/kg/src/db.ts):

```sql
CREATE INDEX idx_nodes_type   ON nodes(type);
CREATE INDEX idx_edges_source ON edges(source_id, edge_type);
CREATE INDEX idx_edges_target ON edges(target_id, edge_type);
```

- `findRecurringIncidents` — index hit on `type='Incident'`, then `json_extract` filter. Sub-millisecond on the seed.
- `getEdges(id, 'out')` — composite index on `(source_id, edge_type)` makes this an index seek, not a scan.
- `getEdges(id, 'in')` — composite index on `(target_id, edge_type)` does the same for the reverse direction.

The perf test asserts p95 < 50ms over 100 runs per query against the full seed. In practice every query lands sub-millisecond; the budget is set for the production-sized graph this design has to scale to.

When in doubt, run the perf test:

```bash
pnpm --filter @axon/kg test
```

---

## Mutations are deliberate

The KG is **append-mostly with one update primitive**:

- `addNode` — insert. Re-uses are blocked by `id PRIMARY KEY`. Idempotent ingest paths (e.g. [packages/incident/src/ingest.ts](../packages/incident/src/ingest.ts) on duplicate Sentry `event_id`) check existence first and return the existing node rather than re-inserting.
- `addEdge` — insert. Validates source and target nodes exist; throws if either is missing.
- `updatePayload<T>(id, type, partial)` — read, deep-merge, re-validate against the Zod schema, write. The only update primitive. Used sparingly.
- `wipe()` — `DELETE FROM edges; DELETE FROM nodes;`. Used by the seed CLI and tests. Not exposed via any public API.

There is **no `deleteNode`**. Removing a node would dangle every edge pointing at it. If we ever need that, it adds at the same time as a soft-delete pattern (`status: 'archived'` on the payload), not a hard delete.

---

## Extending the schema

If you're tempted to add a node or edge type:

1. **Read CLAUDE.md again.** The schema is locked. Adding without approval is the failure mode the project plan calls out by name.
2. If still tempted, the change is a four-step commit:
   - Update the Zod schema in [packages/kg/src/schema.ts](../packages/kg/src/schema.ts).
   - Update CLAUDE.md in the *same* commit (single source of truth).
   - Update the seed in [packages/kg/src/seed.ts](../packages/kg/src/seed.ts) so existing tests keep covering 52+ nodes.
   - Update [decisions.md](decisions.md) with *why*.

3. **Don't add new "named queries" trivially.** The five exist because every alert sentence uses one of them. New queries should arrive only when a skill needs information none of the existing five can provide. Adding one is a real change; doing it casually invites the data-API drift that "every consumer goes through these five" exists to prevent.

The current count: 7 node types, 7 edge types, 5 named queries. That's the budget. Don't grow it without a reason that survives a one-week think.
