import { Octokit } from '@octokit/rest';
import type { NodeOf } from '@axon/kg';
import type {
  IncidentContext,
  IncidentJobContext,
  OnCallEngineer,
  RecentDeploy,
} from './types.js';

const RECENT_DEPLOY_WINDOW_MS = 4 * 60 * 60 * 1000;

function octokitOf(ctx: IncidentJobContext): Octokit {
  return ctx.octokit ?? new Octokit({ auth: ctx.env.GITHUB_TOKEN });
}

function parseRepo(repo: string): { owner: string; name: string } {
  const [owner, ...rest] = repo.split('/');
  if (!owner || rest.length === 0) {
    throw new Error(`enrich: invalid repo string "${repo}"`);
  }
  return { owner, name: rest.join('/') };
}

interface CommitsBundle {
  recentDeploys: RecentDeploy[];
  onCallEngineer: OnCallEngineer | undefined;
}

async function fetchRecentCommits(
  ctx: IncidentJobContext,
  service: NodeOf<'Service'>,
): Promise<CommitsBundle> {
  try {
    const octokit = octokitOf(ctx);
    const { owner, name } = parseRepo(service.payload.repo);
    const since = new Date(Date.now() - RECENT_DEPLOY_WINDOW_MS).toISOString();
    const res = await octokit.repos.listCommits({
      owner,
      repo: name,
      since,
      per_page: 20,
    });
    const recentDeploys: RecentDeploy[] = res.data.map((c) => {
      const committedRaw = c.commit.author?.date ?? c.commit.committer?.date;
      const committedAt = committedRaw
        ? Date.parse(committedRaw)
        : Date.now();
      const titleLine = c.commit.message.split('\n')[0] ?? c.commit.message;
      return {
        sha: c.sha,
        short_sha: c.sha.slice(0, 8),
        title: titleLine,
        author_handle:
          c.author?.login ??
          c.commit.author?.name ??
          'unknown',
        deployed_at: committedAt,
        url: c.html_url,
      };
    });

    const top = recentDeploys[0];
    const onCallEngineer: OnCallEngineer | undefined = top
      ? resolveOnCall(ctx, top.author_handle)
      : undefined;
    return { recentDeploys, onCallEngineer };
  } catch (err) {
    ctx.log.warn(
      {
        component: 'incident',
        stage: 'enrich.commits',
        repo: service.payload.repo,
        err: err instanceof Error ? err.message : String(err),
      },
      'commit fetch failed; continuing with empty deploys',
    );
    return { recentDeploys: [], onCallEngineer: undefined };
  }
}

/**
 * Best-effort resolution from a GitHub handle to a known KG Engineer. We use
 * sampleNodesByType (an inspection helper, not one of the five named queries)
 * to scan engineers — there is no domain query for "engineer by handle".
 */
function resolveOnCall(
  ctx: IncidentJobContext,
  handle: string,
): OnCallEngineer {
  const matchHandle = handle.toLowerCase();
  const engineers = ctx.kg.sampleNodesByType('Engineer', 200);
  for (const e of engineers) {
    if (e.type !== 'Engineer') continue;
    if (e.payload.github_handle.toLowerCase() === matchHandle) {
      return {
        github_handle: handle,
        source: 'most-recent-committer',
        engineer_id: e.id,
        name: e.payload.name,
      };
    }
  }
  return { github_handle: handle, source: 'most-recent-committer' };
}

/**
 * Build the full IncidentContext used by synthesize.ts. Fans out four parallel
 * lookups; total wallclock target is <2s. Only the named KG queries
 * (findRecurringIncidents, getOpenADRs) are used here — recent deploys come
 * from Octokit, on-call from the same Octokit response.
 */
export async function enrichIncident(
  incident: NodeOf<'Incident'>,
  ctx: IncidentJobContext,
  traceId: string,
): Promise<IncidentContext> {
  const service = ctx.kg.getNode(incident.payload.service_id, 'Service');
  if (!service) {
    throw new Error(
      `enrich: service ${incident.payload.service_id} not in KG`,
    );
  }

  const [recurringPatterns, openADRs, commits] = await Promise.all([
    Promise.resolve(
      ctx.kg.findRecurringIncidents(incident.payload.service_id, 30),
    ),
    Promise.resolve(ctx.kg.getOpenADRs(incident.payload.service_id)),
    fetchRecentCommits(ctx, service),
  ]);

  return {
    incident,
    service,
    recurringPatterns,
    recentDeploys: commits.recentDeploys,
    openADRs,
    ...(commits.onCallEngineer
      ? { onCallEngineer: commits.onCallEngineer }
      : {}),
    traceId,
  };
}
