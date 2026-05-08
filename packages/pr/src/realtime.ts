import { Octokit } from '@octokit/rest';
import type { KnowledgeGraph, NodeOf } from '@axon/kg';
import { escapeMarkdownV2 } from '@axon/shared';
import { inferServices, matchesCriticalPath } from './critical-paths.js';
import type {
  GatewayWebhookEnvelope,
  GitHubPRWebhook,
  PRContext,
} from './types.js';

const REALTIME_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

function octokitOf(ctx: PRContext): Octokit {
  return ctx.octokit ?? new Octokit({ auth: ctx.env.GITHUB_TOKEN });
}

function resolveAuthorEngineerId(
  kg: KnowledgeGraph,
  handle: string,
): string | undefined {
  const target = handle.toLowerCase();
  const engineers = kg.sampleNodesByType('Engineer', 200);
  for (const e of engineers) {
    if (e.type !== 'Engineer') continue;
    if (e.payload.github_handle.toLowerCase() === target) return e.id;
  }
  return undefined;
}

function prNodeId(repoFullName: string, number: number): string {
  return `pr-${repoFullName.replace(/\//g, '-')}-${number}`;
}

function ensureAuthoredEdge(
  kg: KnowledgeGraph,
  engineerId: string,
  prId: string,
  createdAtMs: number,
): void {
  const existing = kg.getEdges(engineerId, 'out', ['AUTHORED']);
  if (existing.some((e) => e.target_id === prId)) return;
  kg.addEdge({
    source_id: engineerId,
    target_id: prId,
    edge_type: 'AUTHORED',
    created_at: createdAtMs,
  });
}

function upsertPRNode(
  kg: KnowledgeGraph,
  repoFullName: string,
  pr: GitHubPRWebhook['pull_request'],
  filesChanged: string[],
  authorEngineerId: string | undefined,
): { prId: string; created: boolean } {
  const prId = prNodeId(repoFullName, pr.number);
  const createdAt = Date.parse(pr.created_at);
  const status: 'open' | 'merged' | 'closed' =
    pr.merged_at !== null
      ? 'merged'
      : pr.state === 'closed'
        ? 'closed'
        : 'open';
  // PRPayload requires status of 'open' | 'merged' | 'closed'. Schema allows that.

  const existing = kg.getNode(prId);
  if (existing && existing.type === 'PR') {
    kg.updatePayload(prId, 'PR', {
      title: pr.title,
      status,
      files_changed: filesChanged,
      ...(pr.merged_at !== null
        ? { merged_at: Date.parse(pr.merged_at) }
        : {}),
    });
    return { prId, created: false };
  }
  // New PR. The author_id must reference *something*; prefer KG engineer id,
  // fall back to the github handle so we still record a sensible row.
  const authorRef = authorEngineerId ?? `gh:${pr.user?.login ?? 'unknown'}`;
  kg.addNode({
    id: prId,
    type: 'PR',
    created_at: createdAt,
    payload: {
      number: pr.number,
      title: pr.title,
      author_id: authorRef,
      status,
      created_at: createdAt,
      files_changed: filesChanged,
      ...(pr.merged_at !== null
        ? { merged_at: Date.parse(pr.merged_at) }
        : {}),
    },
  });
  return { prId, created: true };
}

function ensureTouchesEdges(
  kg: KnowledgeGraph,
  prId: string,
  filesChanged: string[],
  createdAtMs: number,
): NodeOf<'Service'>[] {
  const services = kg.sampleNodesByType('Service', 100);
  const touched: NodeOf<'Service'>[] = [];
  const inferredNames = new Set(inferServices(filesChanged));
  for (const svc of services) {
    if (svc.type !== 'Service') continue;
    if (!inferredNames.has(svc.payload.name)) continue;
    const existing = kg.getEdges(prId, 'out', ['TOUCHES']);
    if (existing.some((e) => e.target_id === svc.id)) continue;
    kg.addEdge({
      source_id: prId,
      target_id: svc.id,
      edge_type: 'TOUCHES',
      created_at: createdAtMs,
    });
    touched.push(svc);
  }
  return touched;
}

function buildAlertText(
  pr: GitHubPRWebhook['pull_request'],
  services: string[],
): string {
  const author = pr.user?.login ?? 'unknown';
  const serviceLabel = services.length > 0 ? services.join(', ') : 'critical paths';
  // Keep the text plain; the spec says "Critical-path PR by {author} touching
  // {service}: {title}\n{url}". MarkdownV2 escaping is done at send time.
  const head = `Critical-path PR by ${author} touching ${serviceLabel}: ${pr.title}`;
  return `${head}\n${pr.html_url}`;
}

/**
 * Realtime path. Pure formatting + KG upsert + Telegram send. NO LLM call —
 * latency budget is sub-second from queue tick to first byte on Telegram.
 */
export async function handleGitHubPRWebhook(
  envelope: GatewayWebhookEnvelope,
  ctx: PRContext,
  traceId: string,
): Promise<void> {
  const t0 = Date.now();
  const event = envelope.event;
  if (event !== undefined && event !== 'pull_request') {
    ctx.log.debug(
      { component: 'pr-realtime', traceId, event },
      'ignoring non-PR github event',
    );
    return;
  }
  const payload = envelope.body;
  if (!REALTIME_ACTIONS.has(payload.action)) {
    ctx.log.debug(
      { component: 'pr-realtime', traceId, action: payload.action },
      'ignoring non-realtime PR action',
    );
    return;
  }

  const repoFull = payload.repository.full_name;
  const [owner, repoName] = repoFull.split('/');
  if (!owner || !repoName) {
    ctx.log.warn(
      { component: 'pr-realtime', traceId, repoFull },
      'malformed repository.full_name',
    );
    return;
  }

  let filesChanged: string[] = [];
  try {
    const octokit = octokitOf(ctx);
    const filesRes = await octokit.pulls.listFiles({
      owner,
      repo: repoName,
      pull_number: payload.pull_request.number,
      per_page: 100,
    });
    filesChanged = filesRes.data.map((f) => f.filename);
  } catch (err) {
    ctx.log.warn(
      {
        component: 'pr-realtime',
        traceId,
        repo: repoFull,
        pr_number: payload.pull_request.number,
        err: err instanceof Error ? err.message : String(err),
      },
      'listFiles failed; cannot determine critical-path status',
    );
    // We continue — record what we can in the KG without files_changed.
  }

  const isCritical = filesChanged.length > 0 && matchesCriticalPath(filesChanged);

  const authorHandle = payload.pull_request.user?.login ?? 'unknown';
  const authorEngineerId = resolveAuthorEngineerId(ctx.kg, authorHandle);
  const upsertResult = upsertPRNode(
    ctx.kg,
    repoFull,
    payload.pull_request,
    filesChanged,
    authorEngineerId,
  );
  if (authorEngineerId) {
    ensureAuthoredEdge(
      ctx.kg,
      authorEngineerId,
      upsertResult.prId,
      Date.parse(payload.pull_request.created_at),
    );
  }
  const touchedServices = ensureTouchesEdges(
    ctx.kg,
    upsertResult.prId,
    filesChanged,
    Date.parse(payload.pull_request.created_at),
  );

  if (isCritical) {
    const services = inferServices(filesChanged);
    const text = buildAlertText(payload.pull_request, services);
    try {
      // Use the standard auto-escape send so any '*'/'.'/etc in the title or
      // URL come through verbatim under MarkdownV2.
      await ctx.telegram.send(text);
    } catch (err) {
      ctx.log.error(
        {
          component: 'pr-realtime',
          traceId,
          err: err instanceof Error ? err.message : String(err),
        },
        'critical-path alert failed to send',
      );
    }
    ctx.log.info(
      {
        component: 'pr-realtime',
        traceId,
        action: payload.action,
        pr_number: payload.pull_request.number,
        author: authorHandle,
        services,
        critical: true,
        elapsed_ms: Date.now() - t0,
      },
      'critical-path alert sent',
    );
  } else {
    ctx.log.info(
      {
        component: 'pr-realtime',
        traceId,
        action: payload.action,
        pr_number: payload.pull_request.number,
        author: authorHandle,
        files_count: filesChanged.length,
        critical: false,
        elapsed_ms: Date.now() - t0,
      },
      'PR recorded (non-critical)',
    );
  }

  void touchedServices; // captured for future use; intentionally unread.
}

export const _internals = {
  resolveAuthorEngineerId,
  prNodeId,
  buildAlertText,
};
