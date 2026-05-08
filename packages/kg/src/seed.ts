import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { openDb } from './db.js';
import { KnowledgeGraph } from './graph.js';
import { kgDump } from './dump.js';
import type {
  DecisionPayload,
  DeployPayload,
  EngineerPayload,
  IncidentPayload,
  Node,
  PRPayload,
  ServicePayload,
  SprintPayload,
  EdgeInput,
} from './schema.js';

const DAY = 86_400_000;

function eng(
  id: string,
  payload: EngineerPayload,
  created_at: number,
): Node {
  return { id, type: 'Engineer', created_at, payload };
}
function svc(id: string, payload: ServicePayload, created_at: number): Node {
  return { id, type: 'Service', created_at, payload };
}
function pr(id: string, payload: PRPayload, created_at: number): Node {
  return { id, type: 'PR', created_at, payload };
}
function inc(id: string, payload: IncidentPayload, created_at: number): Node {
  return { id, type: 'Incident', created_at, payload };
}
function dep(id: string, payload: DeployPayload, created_at: number): Node {
  return { id, type: 'Deploy', created_at, payload };
}
function dec(id: string, payload: DecisionPayload, created_at: number): Node {
  return { id, type: 'Decision', created_at, payload };
}
function spr(id: string, payload: SprintPayload, created_at: number): Node {
  return { id, type: 'Sprint', created_at, payload };
}

export interface SeedSummary {
  nodes: number;
  edges: number;
}

export function seed(kg: KnowledgeGraph): SeedSummary {
  kg.wipe();

  const NOW = Date.now();
  const nodes: Node[] = [];
  const edges: EdgeInput[] = [];

  // ---------- Services ----------
  nodes.push(
    svc(
      'service-auth',
      {
        name: 'auth-service',
        repo: 'samsung-sri/auth-service',
        owner_team: 'platform-identity',
        criticality: 'critical',
      },
      NOW - 90 * DAY,
    ),
    svc(
      'service-payments',
      {
        name: 'payments-service',
        repo: 'samsung-sri/payments-service',
        owner_team: 'commerce',
        criticality: 'critical',
      },
      NOW - 90 * DAY,
    ),
    svc(
      'service-notifications',
      {
        name: 'notifications-service',
        repo: 'samsung-sri/notifications-service',
        owner_team: 'growth',
        criticality: 'standard',
      },
      NOW - 90 * DAY,
    ),
  );

  // ---------- Engineers ----------
  const engineers: Array<[string, string, string, string, number]> = [
    ['engineer-aditi', 'Aditi Sharma', 'aditi-sharma', 'aditi@samsung.example', 9],
    ['engineer-raj', 'Raj Kumar', 'rajk', 'raj@samsung.example', 6],
    ['engineer-priya', 'Priya Iyer', 'priya-i', 'priya@samsung.example', 4],
    ['engineer-vikram', 'Vikram Reddy', 'vreddy', 'vikram@samsung.example', 7],
    ['engineer-neha', 'Neha Gupta', 'nehag', 'neha@samsung.example', 5],
    ['engineer-arjun', 'Arjun Nair', 'arjun-n', 'arjun@samsung.example', 3],
    ['engineer-kavya', 'Kavya Patel', 'kavyap', 'kavya@samsung.example', 6],
    ['engineer-suresh', 'Suresh Rao', 'sureshr', 'suresh@samsung.example', 2],
    ['engineer-anjali', 'Anjali Menon', 'anjali-m', 'anjali@samsung.example', 5],
    ['engineer-rohan', 'Rohan Singh', 'rohans', 'rohan@samsung.example', 4],
  ];
  for (const [id, name, gh, email, load] of engineers) {
    nodes.push(
      eng(
        id,
        {
          name,
          github_handle: gh,
          email,
          current_load: load,
        },
        NOW - 60 * DAY,
      ),
    );
  }

  // ---------- PRs ----------
  // 22 PRs distributed across the 10 engineers, ~half merged ~half open.
  type PRSpec = {
    id: string;
    number: number;
    title: string;
    author_id: string;
    status: 'open' | 'merged';
    daysAgo: number;
    mergedDaysAgo?: number;
    files_changed: string[];
    service_id: string;
  };
  const prSpecs: PRSpec[] = [
    {
      id: 'pr-001',
      number: 1201,
      title: 'auth: cap Redis pool at 50',
      author_id: 'engineer-aditi',
      status: 'merged',
      daysAgo: 22,
      mergedDaysAgo: 21,
      files_changed: ['packages/auth/src/redis.ts', 'packages/auth/src/config.ts'],
      service_id: 'service-auth',
    },
    {
      id: 'pr-002',
      number: 1202,
      title: 'auth: surface session token rotation metric',
      author_id: 'engineer-raj',
      status: 'merged',
      daysAgo: 20,
      mergedDaysAgo: 19,
      files_changed: ['packages/auth/src/session.ts'],
      service_id: 'service-auth',
    },
    {
      id: 'pr-003',
      number: 1203,
      title: 'payments: idempotency key on charge endpoint',
      author_id: 'engineer-vikram',
      status: 'merged',
      daysAgo: 19,
      mergedDaysAgo: 18,
      files_changed: ['packages/payments/src/charge.ts'],
      service_id: 'service-payments',
    },
    {
      id: 'pr-004',
      number: 1204,
      title: 'notifications: retry budget per-channel',
      author_id: 'engineer-anjali',
      status: 'merged',
      daysAgo: 28,
      mergedDaysAgo: 27,
      files_changed: ['packages/notifications/src/retry.ts'],
      service_id: 'service-notifications',
    },
    {
      id: 'pr-005',
      number: 1205,
      title: 'auth: hotfix for Redis connection exhaustion',
      author_id: 'engineer-aditi',
      status: 'merged',
      daysAgo: 22,
      mergedDaysAgo: 22,
      files_changed: ['packages/auth/src/redis-pool.ts'],
      service_id: 'service-auth',
    },
    {
      id: 'pr-006',
      number: 1206,
      title: 'auth: structured logging on session paths',
      author_id: 'engineer-priya',
      status: 'open',
      daysAgo: 6,
      files_changed: ['packages/auth/src/log.ts'],
      service_id: 'service-auth',
    },
    {
      id: 'pr-007',
      number: 1207,
      title: 'payments: refund webhook handler',
      author_id: 'engineer-vikram',
      status: 'open',
      daysAgo: 5,
      files_changed: ['packages/payments/src/webhook.ts'],
      service_id: 'service-payments',
    },
    {
      id: 'pr-008',
      number: 1208,
      title: 'notifications: SMS fallback path',
      author_id: 'engineer-anjali',
      status: 'open',
      daysAgo: 4,
      files_changed: ['packages/notifications/src/sms.ts'],
      service_id: 'service-notifications',
    },
    {
      id: 'pr-009',
      number: 1209,
      title: 'payments: race-fix on idempotency lookup',
      author_id: 'engineer-vikram',
      status: 'merged',
      daysAgo: 17,
      mergedDaysAgo: 17,
      files_changed: ['packages/payments/src/idempotency.ts'],
      service_id: 'service-payments',
    },
    {
      id: 'pr-010',
      number: 1210,
      title: 'auth: lower TTL on revoked-token cache',
      author_id: 'engineer-aditi',
      status: 'open',
      daysAgo: 3,
      files_changed: ['packages/auth/src/revoked-cache.ts'],
      service_id: 'service-auth',
    },
    {
      id: 'pr-011',
      number: 1211,
      title: 'auth: bump zod, fix any-cast in middleware',
      author_id: 'engineer-aditi',
      status: 'open',
      daysAgo: 2,
      files_changed: ['packages/auth/src/middleware.ts', 'packages/auth/package.json'],
      service_id: 'service-auth',
    },
    {
      id: 'pr-012',
      number: 1212,
      title: 'payments: stripe SDK 14 -> 16',
      author_id: 'engineer-kavya',
      status: 'open',
      daysAgo: 4,
      files_changed: ['packages/payments/src/stripe.ts', 'packages/payments/package.json'],
      service_id: 'service-payments',
    },
    {
      id: 'pr-013',
      number: 1213,
      title: 'notifications: dedupe push tokens at ingestion',
      author_id: 'engineer-arjun',
      status: 'merged',
      daysAgo: 12,
      mergedDaysAgo: 11,
      files_changed: ['packages/notifications/src/ingest.ts'],
      service_id: 'service-notifications',
    },
    {
      id: 'pr-014',
      number: 1214,
      title: 'notifications: dedupe regression fix',
      author_id: 'engineer-arjun',
      status: 'merged',
      daysAgo: 27,
      mergedDaysAgo: 27,
      files_changed: ['packages/notifications/src/ingest.ts'],
      service_id: 'service-notifications',
    },
    {
      id: 'pr-015',
      number: 1215,
      title: 'auth: extract token signer into shared lib',
      author_id: 'engineer-neha',
      status: 'merged',
      daysAgo: 14,
      mergedDaysAgo: 13,
      files_changed: ['packages/auth/src/signer.ts', 'packages/shared/src/jwt.ts'],
      service_id: 'service-auth',
    },
    {
      id: 'pr-016',
      number: 1216,
      title: 'payments: fraud score percentile bucket',
      author_id: 'engineer-kavya',
      status: 'merged',
      daysAgo: 10,
      mergedDaysAgo: 9,
      files_changed: ['packages/payments/src/fraud.ts'],
      service_id: 'service-payments',
    },
    {
      id: 'pr-017',
      number: 1217,
      title: 'auth: typed errors for OAuth flow',
      author_id: 'engineer-rohan',
      status: 'open',
      daysAgo: 1,
      files_changed: ['packages/auth/src/oauth.ts'],
      service_id: 'service-auth',
    },
    {
      id: 'pr-018',
      number: 1218,
      title: 'payments: reconciliation cron stays idempotent',
      author_id: 'engineer-suresh',
      status: 'merged',
      daysAgo: 8,
      mergedDaysAgo: 7,
      files_changed: ['packages/payments/src/reconcile.ts'],
      service_id: 'service-payments',
    },
    {
      id: 'pr-019',
      number: 1219,
      title: 'notifications: rate-limit per device id',
      author_id: 'engineer-anjali',
      status: 'open',
      daysAgo: 2,
      files_changed: ['packages/notifications/src/rate-limit.ts'],
      service_id: 'service-notifications',
    },
    {
      id: 'pr-020',
      number: 1220,
      title: 'auth: tighten CORS origin allowlist',
      author_id: 'engineer-priya',
      status: 'open',
      daysAgo: 5,
      files_changed: ['packages/auth/src/cors.ts'],
      service_id: 'service-auth',
    },
    {
      id: 'pr-021',
      number: 1221,
      title: 'payments: improve webhook signature validation',
      author_id: 'engineer-rohan',
      status: 'merged',
      daysAgo: 16,
      mergedDaysAgo: 15,
      files_changed: ['packages/payments/src/webhook.ts'],
      service_id: 'service-payments',
    },
    {
      id: 'pr-022',
      number: 1222,
      title: 'auth: backfill engineer load metric',
      author_id: 'engineer-aditi',
      status: 'open',
      daysAgo: 6,
      files_changed: ['packages/auth/src/metrics.ts'],
      service_id: 'service-auth',
    },
  ];
  for (const p of prSpecs) {
    const created_at = NOW - p.daysAgo * DAY;
    const payload: PRPayload = {
      number: p.number,
      title: p.title,
      author_id: p.author_id,
      status: p.status,
      created_at,
      files_changed: p.files_changed,
      ...(p.mergedDaysAgo !== undefined
        ? { merged_at: NOW - p.mergedDaysAgo * DAY }
        : {}),
    };
    nodes.push(pr(p.id, payload, created_at));
  }

  // ---------- Incidents ----------
  type IncSpec = {
    id: string;
    severity: 'P0' | 'P1' | 'P2';
    service_id: string;
    title: string;
    daysAgo: number;
    resolvedDaysAgo?: number;
    root_cause?: string;
  };
  const incSpecs: IncSpec[] = [
    {
      id: 'incident-auth-1',
      severity: 'P1',
      service_id: 'service-auth',
      title: 'auth-service Redis connection storm',
      daysAgo: 23,
      resolvedDaysAgo: 22,
      root_cause: 'Redis connection pool unbounded under burst traffic',
    },
    {
      id: 'incident-auth-2',
      severity: 'P0',
      service_id: 'service-auth',
      title: 'auth-service login latency spike',
      daysAgo: 13,
      resolvedDaysAgo: 13,
      root_cause: 'Same Redis pool exhaustion path, partial mitigation only',
    },
    {
      id: 'incident-auth-3',
      severity: 'P1',
      service_id: 'service-auth',
      title: 'auth-service intermittent 500s on /token',
      daysAgo: 3,
    },
    {
      id: 'incident-payments-1',
      severity: 'P0',
      service_id: 'service-payments',
      title: 'payments-service double-charge on retry',
      daysAgo: 18,
      resolvedDaysAgo: 17,
      root_cause: 'Race on idempotency-key insert vs read',
    },
    {
      id: 'incident-payments-2',
      severity: 'P2',
      service_id: 'service-payments',
      title: 'payments-service webhook signature mismatch',
      daysAgo: 6,
    },
    {
      id: 'incident-notifications-1',
      severity: 'P2',
      service_id: 'service-notifications',
      title: 'notifications-service push token duplication',
      daysAgo: 28,
      resolvedDaysAgo: 27,
    },
  ];
  for (const i of incSpecs) {
    const started_at = NOW - i.daysAgo * DAY;
    const payload: IncidentPayload = {
      severity: i.severity,
      service_id: i.service_id,
      title: i.title,
      started_at,
      ...(i.resolvedDaysAgo !== undefined
        ? { resolved_at: NOW - i.resolvedDaysAgo * DAY }
        : {}),
      ...(i.root_cause !== undefined ? { root_cause: i.root_cause } : {}),
    };
    nodes.push(inc(i.id, payload, started_at));
  }

  // ---------- Deploys ----------
  type DeploySpec = {
    id: string;
    sha: string;
    service_id: string;
    deployed_by_id: string;
    daysAgo: number;
    fractional?: number;
    status: 'success' | 'rolled_back';
  };
  const deploySpecs: DeploySpec[] = [
    {
      id: 'deploy-1',
      sha: '7a3c1d9f0a4e1b2e3d4c5f60718293a4b5c6d7e8',
      service_id: 'service-auth',
      deployed_by_id: 'engineer-raj',
      daysAgo: 23,
      fractional: 0.5,
      status: 'rolled_back',
    },
    {
      id: 'deploy-2',
      sha: '8b4d2eaa1b5f2c3f4e5d6071928394a5b6c7d8e9',
      service_id: 'service-auth',
      deployed_by_id: 'engineer-neha',
      daysAgo: 14,
      status: 'rolled_back',
    },
    {
      id: 'deploy-3',
      sha: '9c5e3fbb2c603d4f5e6e7182a3b4c5d6e7f8091a',
      service_id: 'service-payments',
      deployed_by_id: 'engineer-vikram',
      daysAgo: 18,
      fractional: 0.5,
      status: 'rolled_back',
    },
    {
      id: 'deploy-4',
      sha: 'a0d6f0cc3d614e5f6f7081293b4c5d6e7f80091b',
      service_id: 'service-notifications',
      deployed_by_id: 'engineer-anjali',
      daysAgo: 28,
      fractional: 0.5,
      status: 'success',
    },
    {
      id: 'deploy-5',
      sha: 'b1e7019d4e725f607080819a4b5c6d7e8f90091c',
      service_id: 'service-auth',
      deployed_by_id: 'engineer-rohan',
      daysAgo: 4,
      status: 'success',
    },
    {
      id: 'deploy-6',
      sha: 'c2f812ae5f836071818292ab5c6d7e8f90091d2e',
      service_id: 'service-payments',
      deployed_by_id: 'engineer-suresh',
      daysAgo: 7,
      status: 'success',
    },
  ];
  for (const d of deploySpecs) {
    const offset = d.fractional ?? 0;
    const deployed_at = NOW - (d.daysAgo + offset) * DAY;
    nodes.push(
      dep(
        d.id,
        {
          sha: d.sha,
          service_id: d.service_id,
          deployed_at,
          deployed_by_id: d.deployed_by_id,
          status: d.status,
        },
        deployed_at,
      ),
    );
  }

  // ---------- Decisions ----------
  nodes.push(
    dec(
      'decision-1',
      {
        type: 'ADR',
        title: 'Bound Redis connection pools across services',
        status: 'open',
        created_at: NOW - 21 * DAY,
      },
      NOW - 21 * DAY,
    ),
    dec(
      'decision-2',
      {
        type: 'ADR',
        title: 'Standardize webhook retry policy (exp backoff, 5 attempts)',
        status: 'accepted',
        created_at: NOW - 50 * DAY,
      },
      NOW - 50 * DAY,
    ),
    dec(
      'decision-3',
      {
        type: 'ADR',
        title: 'Centralize feature flags through a single gateway',
        status: 'accepted',
        created_at: NOW - 70 * DAY,
      },
      NOW - 70 * DAY,
    ),
  );

  // ---------- Sprints ----------
  nodes.push(
    spr(
      'sprint-23',
      {
        number: 23,
        start_date: NOW - 7 * DAY,
        end_date: NOW + 7 * DAY,
        planned_points: 35,
      },
      NOW - 7 * DAY,
    ),
    spr(
      'sprint-22',
      {
        number: 22,
        start_date: NOW - 21 * DAY,
        end_date: NOW - 7 * DAY,
        planned_points: 32,
        completed_points: 28,
        risk_score: 18,
      },
      NOW - 21 * DAY,
    ),
  );

  // Insert nodes first; addEdge enforces source/target existence.
  for (const n of nodes) kg.addNode(n);

  // ---------- Edges ----------

  // AUTHORED: Engineer -> PR
  for (const p of prSpecs) {
    edges.push({
      source_id: p.author_id,
      target_id: p.id,
      edge_type: 'AUTHORED',
      created_at: NOW - p.daysAgo * DAY,
    });
  }

  // TOUCHES: PR -> Service
  for (const p of prSpecs) {
    edges.push({
      source_id: p.id,
      target_id: p.service_id,
      edge_type: 'TOUCHES',
      created_at: NOW - p.daysAgo * DAY,
    });
  }

  // RESOLVES: PR -> Incident (the post-incident hotfix PRs)
  edges.push(
    {
      source_id: 'pr-005',
      target_id: 'incident-auth-1',
      edge_type: 'RESOLVES',
      created_at: NOW - 22 * DAY,
    },
    {
      source_id: 'pr-009',
      target_id: 'incident-payments-1',
      edge_type: 'RESOLVES',
      created_at: NOW - 17 * DAY,
    },
    {
      source_id: 'pr-014',
      target_id: 'incident-notifications-1',
      edge_type: 'RESOLVES',
      created_at: NOW - 27 * DAY,
    },
  );

  // CAUSED_BY: Incident -> Deploy
  edges.push(
    {
      source_id: 'incident-auth-1',
      target_id: 'deploy-1',
      edge_type: 'CAUSED_BY',
      created_at: NOW - 23 * DAY,
    },
    {
      source_id: 'incident-auth-2',
      target_id: 'deploy-2',
      edge_type: 'CAUSED_BY',
      created_at: NOW - 13 * DAY,
    },
    {
      source_id: 'incident-payments-1',
      target_id: 'deploy-3',
      edge_type: 'CAUSED_BY',
      created_at: NOW - 18 * DAY,
    },
    {
      source_id: 'incident-notifications-1',
      target_id: 'deploy-4',
      edge_type: 'CAUSED_BY',
      created_at: NOW - 28 * DAY,
    },
  );

  // DEPLOYED: Engineer -> Deploy
  for (const d of deploySpecs) {
    edges.push({
      source_id: d.deployed_by_id,
      target_id: d.id,
      edge_type: 'DEPLOYED',
      created_at: NOW - (d.daysAgo + (d.fractional ?? 0)) * DAY,
    });
  }

  // TOUCHES: Deploy -> Service
  for (const d of deploySpecs) {
    edges.push({
      source_id: d.id,
      target_id: d.service_id,
      edge_type: 'TOUCHES',
      created_at: NOW - (d.daysAgo + (d.fractional ?? 0)) * DAY,
    });
  }

  // INFORMED: Decision -> Incident
  edges.push({
    source_id: 'decision-1',
    target_id: 'incident-auth-1',
    edge_type: 'INFORMED',
    created_at: NOW - 21 * DAY,
  });

  // BLOCKS: Incident -> Sprint
  edges.push({
    source_id: 'incident-auth-3',
    target_id: 'sprint-23',
    edge_type: 'BLOCKS',
    created_at: NOW - 3 * DAY,
  });

  for (const e of edges) kg.addEdge(e);

  return { nodes: nodes.length, edges: edges.length };
}

// ---------- CLI ----------

const isCli =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  // Resolve KG_DB_PATH relative to the repo root so the seed always writes to
  // the same file regardless of the cwd from which pnpm invoked us.
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..', '..');
  const dbPath =
    process.env['KG_DB_PATH'] ?? resolve(repoRoot, 'data', 'axon.db');
  const db = openDb(dbPath);
  const kg = new KnowledgeGraph(db);
  const summary = seed(kg);
  // eslint-disable-next-line no-console
  console.log(kgDump(kg));
  // eslint-disable-next-line no-console
  console.log(
    `\nSeed complete: inserted ${summary.nodes} nodes and ${summary.edges} edges into ${dbPath}.`,
  );
  db.close();
}
