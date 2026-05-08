import { Octokit } from '@octokit/rest';
import type {
  BriefContext,
  EngineerLoadEntry,
  ErrorSummary,
  FetcherResult,
  KGSignals,
  LinearIssue,
  PRSummary,
  RecurringPattern,
} from './types.js';

const DAY_MS = 86_400_000;
const SENTRY_ERROR_THRESHOLD = 5;

function fetchOf(ctx: BriefContext): typeof fetch {
  return ctx.fetch ?? globalThis.fetch.bind(globalThis);
}

function octokitOf(ctx: BriefContext): Octokit {
  return ctx.octokit ?? new Octokit({ auth: ctx.env.GITHUB_TOKEN });
}

export async function fetchOpenPRs(
  ctx: BriefContext,
): Promise<FetcherResult<PRSummary[]>> {
  try {
    const octokit = octokitOf(ctx);
    const owner = ctx.env.GITHUB_ORG;
    const repo = ctx.env.GITHUB_REPO;
    const since = Date.now() - DAY_MS;

    const open = await octokit.paginate(octokit.pulls.list, {
      owner,
      repo,
      state: 'open',
      per_page: 100,
    });

    const closed = await octokit.paginate(octokit.pulls.list, {
      owner,
      repo,
      state: 'closed',
      per_page: 100,
      sort: 'updated',
      direction: 'desc',
    });

    const merged = closed.filter(
      (pr) =>
        pr.merged_at !== null &&
        pr.merged_at !== undefined &&
        new Date(pr.merged_at).getTime() >= since,
    );

    const result: PRSummary[] = [];
    const seen = new Set<number>();
    for (const pr of [...open, ...merged]) {
      if (seen.has(pr.number)) continue;
      seen.add(pr.number);
      result.push({
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        author: pr.user?.login ?? 'unknown',
        state: pr.merged_at !== null && pr.merged_at !== undefined ? 'merged' : 'open',
        files_changed:
          (pr as unknown as { changed_files?: number }).changed_files ?? 0,
        created_at: pr.created_at,
        merged_at: pr.merged_at ?? null,
      });
    }
    return { ok: true, data: result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const LINEAR_QUERY = `
  query MorningBriefBlockers {
    issues(
      filter: {
        state: { type: { in: ["unstarted", "started", "backlog"] } }
        or: [
          { labels: { name: { eq: "blocker" } } }
          { priority: { eq: 1 } }
        ]
      }
      first: 50
    ) {
      nodes {
        id
        identifier
        title
        url
        priority
        labels { nodes { name } }
        state { name }
      }
    }
  }
`;

const PRIORITY_BY_NUMBER: Record<number, LinearIssue['priority']> = {
  0: 'NoPriority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

interface LinearResponseNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number;
  labels: { nodes: Array<{ name: string }> };
  state: { name: string };
}

interface LinearResponse {
  data?: { issues?: { nodes: LinearResponseNode[] } };
  errors?: Array<{ message: string }>;
}

export async function fetchLinearBlockers(
  ctx: BriefContext,
): Promise<FetcherResult<LinearIssue[]>> {
  try {
    const f = fetchOf(ctx);
    const res = await f('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: ctx.env.LINEAR_API_KEY,
      },
      body: JSON.stringify({ query: LINEAR_QUERY }),
    });
    if (!res.ok) {
      return { ok: false, error: `Linear HTTP ${res.status}` };
    }
    const json = (await res.json()) as LinearResponse;
    if (json.errors && json.errors.length > 0) {
      return {
        ok: false,
        error: `Linear GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`,
      };
    }
    const nodes = json.data?.issues?.nodes ?? [];
    return {
      ok: true,
      data: nodes.map((n) => ({
        id: n.id,
        identifier: n.identifier,
        title: n.title,
        url: n.url,
        priority: PRIORITY_BY_NUMBER[n.priority] ?? 'NoPriority',
        labels: n.labels.nodes.map((l) => l.name),
        state: n.state.name,
      })),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface SentryIssueRow {
  id: string;
  shortId?: string;
  title: string;
  count?: string | number;
  level?: string;
  lastSeen?: string;
  project?: { slug?: string };
  metadata?: { type?: string };
}

export async function fetchSentryErrors(
  ctx: BriefContext,
): Promise<FetcherResult<ErrorSummary[]>> {
  const token = ctx.env.SENTRY_AUTH_TOKEN;
  const org = ctx.env.SENTRY_ORG;
  const project = ctx.env.SENTRY_PROJECT;
  if (!token || !org || !project) {
    return {
      ok: false,
      error:
        'Sentry API not configured (SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT). Errors fetcher will be wired in Phase 4.',
    };
  }
  try {
    const f = fetchOf(ctx);
    const url = `https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?statsPeriod=24h&query=is:unresolved+level:error&limit=50`;
    const res = await f(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return { ok: false, error: `Sentry HTTP ${res.status}` };
    }
    const rows = (await res.json()) as SentryIssueRow[];
    const summaries = rows
      .map<ErrorSummary>((r) => ({
        fingerprint: r.shortId ?? r.id,
        title: r.title,
        count: typeof r.count === 'string' ? parseInt(r.count, 10) : r.count ?? 0,
        service: r.project?.slug ?? project,
        level: r.level ?? 'error',
        last_seen: r.lastSeen ?? new Date().toISOString(),
      }))
      .filter((e) => e.count >= SENTRY_ERROR_THRESHOLD);
    return { ok: true, data: summaries };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function fetchKGSignals(
  ctx: BriefContext,
): Promise<FetcherResult<KGSignals>> {
  try {
    const services = ctx.kg.sampleNodesByType('Service', 100);
    const patterns: RecurringPattern[] = [];
    const now = Date.now();
    for (const svc of services) {
      if (svc.type !== 'Service') continue;
      const incidents = ctx.kg.findRecurringIncidents(svc.id, 30);
      if (incidents.length >= 2) {
        const mostRecent = incidents[0];
        const daysAgo = mostRecent
          ? Math.floor((now - mostRecent.payload.started_at) / DAY_MS)
          : 0;
        patterns.push({
          service_id: svc.id,
          service_name: svc.payload.name,
          count_30d: incidents.length,
          most_recent_title: mostRecent?.payload.title ?? '',
          most_recent_days_ago: daysAgo,
        });
      }
    }
    patterns.sort((a, b) => b.count_30d - a.count_30d);

    const openADRs = ctx.kg.getOpenADRs();

    const engineers = ctx.kg.sampleNodesByType('Engineer', 100);
    const loadEntries: EngineerLoadEntry[] = [];
    for (const eng of engineers) {
      if (eng.type !== 'Engineer') continue;
      const load = ctx.kg.getEngineerLoad(eng.id);
      loadEntries.push({
        id: eng.id,
        name: eng.payload.name,
        github_handle: eng.payload.github_handle,
        current_load: eng.payload.current_load,
        open_prs: load.open_prs,
        recent_incidents: load.recent_incidents,
        review_queue_size: load.review_queue_size,
      });
    }
    loadEntries.sort((a, b) => b.current_load - a.current_load);

    // Incident trend over the two most recent calendar weeks.
    const oneWeekMs = 7 * DAY_MS;
    let thisWeek = 0;
    let lastWeek = 0;
    for (const svc of services) {
      if (svc.type !== 'Service') continue;
      const incidents = ctx.kg.findRecurringIncidents(svc.id, 14);
      for (const inc of incidents) {
        const age = now - inc.payload.started_at;
        if (age < oneWeekMs) thisWeek += 1;
        else if (age < 2 * oneWeekMs) lastWeek += 1;
      }
    }
    const deltaPct =
      lastWeek === 0
        ? thisWeek === 0
          ? 0
          : 100
        : Math.round(((thisWeek - lastWeek) / lastWeek) * 100);

    return {
      ok: true,
      data: {
        recurringPatterns: patterns.slice(0, 3),
        openADRs,
        engineerLoad: loadEntries.slice(0, 3),
        incidentTrend: { thisWeek, lastWeek, deltaPct },
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
