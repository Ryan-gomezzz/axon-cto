import { Octokit } from '@octokit/rest';
import OpenAI from 'openai';
import { escapeMarkdownV2 } from '@axon/shared';
import { matchesCriticalPath } from './critical-paths.js';
import type {
  DigestSnapshot,
  PRContext,
  PullRequestRow,
  ReviewerBottleneck,
} from './types.js';

const STALE_THRESHOLD_DAYS = 7;
const STALE_THRESHOLD_MS = STALE_THRESHOLD_DAYS * 86_400_000;
const DEFAULT_BOTTLENECK_THRESHOLD = 5;
const CRITICAL_FILE_FETCH_CAP = 20;

const DIGEST_SYSTEM_PROMPT = `You are Axon, a synthetic engineering chief of staff. Produce a PR-health evening digest as 3 short Markdown sections in this exact order, no preamble, no closing line:

## Open Critical PRs
## Reviewer Bottlenecks
## Stale PRs (>7d)

Each section is a short bullet list. Use "* " prefix for each bullet. If a section is empty, write a single bullet "* (none)" instead of omitting the section.

Hard rules:
- Never surface a raw count without a one-sentence reason it matters. "5 pending reviews on alice" is wrong; "5 pending reviews on alice — also leading 2 incidents this week, escalation candidate" is right.
- For Reviewer Bottlenecks, if a reviewer is also flagged as overloaded by the KG (open_prs >= 3 OR recent_incidents >= 1), call that out explicitly.
- Plain prose inside bullets — no nested markdown beyond bold. Keep each bullet under 30 words.
- Sections: Open Critical PRs surfaces critical-path PRs still open with author/title/age. Reviewer Bottlenecks lists reviewers above the threshold. Stale PRs (>7d) lists author/title/age.`;

function octokitOf(ctx: PRContext): Octokit {
  return ctx.octokit ?? new Octokit({ auth: ctx.env.GITHUB_TOKEN });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ageDays(updatedAtIso: string, now: number): number {
  const updated = Date.parse(updatedAtIso);
  if (!Number.isFinite(updated)) return 0;
  return Math.floor((now - updated) / 86_400_000);
}

function resolveEngineerByHandle(
  kg: PRContext['kg'],
  handle: string,
): { id: string; name: string } | undefined {
  const target = handle.toLowerCase();
  for (const e of kg.sampleNodesByType('Engineer', 200)) {
    if (e.type !== 'Engineer') continue;
    if (e.payload.github_handle.toLowerCase() === target) {
      return { id: e.id, name: e.payload.name };
    }
  }
  return undefined;
}

interface OctokitPRRow {
  number: number;
  title: string;
  html_url: string;
  user?: { login: string } | null;
  requested_reviewers?: Array<{ login: string }> | null;
  state: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
}

/**
 * Build a structured snapshot. Side-effect-free aside from Octokit reads.
 * Exposed for tests; the cron path calls computeDigestSnapshot then synthesizes.
 */
export async function computeDigestSnapshot(
  ctx: PRContext,
  options: { bottleneckThreshold?: number; now?: number } = {},
): Promise<DigestSnapshot> {
  const now = options.now ?? Date.now();
  const bottleneckThreshold =
    options.bottleneckThreshold ?? DEFAULT_BOTTLENECK_THRESHOLD;
  const octokit = octokitOf(ctx);
  const owner = ctx.env.GITHUB_ORG;
  const repo = ctx.env.GITHUB_REPO;

  const openPRs = (await octokit.paginate(octokit.pulls.list, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  })) as unknown as OctokitPRRow[];

  // Per-reviewer pending count.
  const reviewerCounts = new Map<string, number>();
  const stalePRs: PullRequestRow[] = [];
  const baseRows: PullRequestRow[] = [];
  for (const pr of openPRs) {
    const reviewers = (pr.requested_reviewers ?? []).map((r) => r.login);
    for (const r of reviewers) {
      reviewerCounts.set(r, (reviewerCounts.get(r) ?? 0) + 1);
    }
    const row: PullRequestRow = {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      author_handle: pr.user?.login ?? 'unknown',
      state: 'open',
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      requested_reviewers: reviewers,
    };
    baseRows.push(row);
    if (now - Date.parse(pr.updated_at) >= STALE_THRESHOLD_MS) {
      stalePRs.push(row);
    }
  }

  // Identify critical-path PRs: fetch files for the top N (newest-updated).
  const sortedForFiles = [...baseRows]
    .sort(
      (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
    )
    .slice(0, CRITICAL_FILE_FETCH_CAP);

  await Promise.all(
    sortedForFiles.map(async (row) => {
      try {
        const filesRes = await octokit.pulls.listFiles({
          owner,
          repo,
          pull_number: row.number,
          per_page: 100,
        });
        row.files_changed = filesRes.data.map((f) => f.filename);
      } catch (err) {
        ctx.log.warn(
          {
            component: 'pr-digest',
            pr_number: row.number,
            err: err instanceof Error ? err.message : String(err),
          },
          'listFiles failed during digest',
        );
      }
    }),
  );

  const criticalOpen = baseRows.filter(
    (r) => r.files_changed && matchesCriticalPath(r.files_changed),
  );

  const bottleneckEntries: ReviewerBottleneck[] = [];
  for (const [handle, pending] of reviewerCounts) {
    if (pending <= bottleneckThreshold) continue;
    const engineer = resolveEngineerByHandle(ctx.kg, handle);
    if (engineer) {
      const load = ctx.kg.getEngineerLoad(engineer.id);
      bottleneckEntries.push({
        handle,
        pending_reviews: pending,
        engineer: {
          id: engineer.id,
          name: engineer.name,
          open_prs: load.open_prs,
          recent_incidents: load.recent_incidents,
          review_queue_size: load.review_queue_size,
        },
      });
    } else {
      bottleneckEntries.push({ handle, pending_reviews: pending });
    }
  }
  bottleneckEntries.sort((a, b) => b.pending_reviews - a.pending_reviews);

  return {
    generated_at: now,
    open_prs_total: openPRs.length,
    critical_open_prs: criticalOpen,
    bottlenecks: bottleneckEntries,
    stale_prs: stalePRs,
    bottleneck_threshold: bottleneckThreshold,
    stale_threshold_days: STALE_THRESHOLD_DAYS,
  };
}

export function buildDigestUserMessage(snap: DigestSnapshot): string {
  const sections: string[] = [];
  sections.push(
    `<summary open_prs_total="${snap.open_prs_total}" bottleneck_threshold="${snap.bottleneck_threshold}" stale_threshold_days="${snap.stale_threshold_days}"/>`,
  );

  if (snap.critical_open_prs.length === 0) {
    sections.push('<critical_open><none/></critical_open>');
  } else {
    const lines = snap.critical_open_prs.map((p) => {
      const age = ageDays(p.updated_at, snap.generated_at);
      return `  <pr number="${p.number}" author="${p.author_handle}" age_days="${age}" title="${escapeXml(p.title)}" url="${p.url}"/>`;
    });
    sections.push(`<critical_open count="${snap.critical_open_prs.length}">\n${lines.join('\n')}\n</critical_open>`);
  }

  if (snap.bottlenecks.length === 0) {
    sections.push('<bottlenecks><none/></bottlenecks>');
  } else {
    const lines = snap.bottlenecks.map((b) => {
      const eng = b.engineer
        ? ` open_prs="${b.engineer.open_prs}" recent_incidents="${b.engineer.recent_incidents}" review_queue="${b.engineer.review_queue_size}" name="${escapeXml(b.engineer.name)}"`
        : '';
      return `  <reviewer handle="${b.handle}" pending_reviews="${b.pending_reviews}"${eng}/>`;
    });
    sections.push(`<bottlenecks count="${snap.bottlenecks.length}">\n${lines.join('\n')}\n</bottlenecks>`);
  }

  if (snap.stale_prs.length === 0) {
    sections.push('<stale><none/></stale>');
  } else {
    const lines = snap.stale_prs.map((p) => {
      const age = ageDays(p.updated_at, snap.generated_at);
      return `  <pr number="${p.number}" author="${p.author_handle}" age_days="${age}" title="${escapeXml(p.title)}" url="${p.url}"/>`;
    });
    sections.push(`<stale count="${snap.stale_prs.length}">\n${lines.join('\n')}\n</stale>`);
  }

  return sections.join('\n\n');
}

interface SynthesizeDigestDeps {
  client?: OpenAI;
}

export async function synthesizeDigest(
  snap: DigestSnapshot,
  ctx: Pick<PRContext, 'env' | 'log'>,
  deps: SynthesizeDigestDeps = {},
): Promise<string> {
  const client =
    deps.client ??
    new OpenAI({
      apiKey: ctx.env.LLM_API_KEY,
      baseURL: ctx.env.LLM_BASE_URL,
    });

  const stream = await client.chat.completions.create({
    model: ctx.env.LLM_MODEL_ROUTINE,
    stream: true,
    max_tokens: 700,
    temperature: 0.3,
    messages: [
      { role: 'system', content: DIGEST_SYSTEM_PROMPT },
      { role: 'user', content: buildDigestUserMessage(snap) },
    ],
  });

  let text = '';
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (typeof delta === 'string') text += delta;
  }
  return text.trim();
}

function istHourMinute(d: Date): string {
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatDigestForTelegram(
  brief: string,
  traceId: string,
  generatedAt: Date,
): string {
  const safeBody = escapeMarkdownV2(brief.trim());
  const stamp = `PR digest · ${istHourMinute(generatedAt)} IST · trace ${traceId}`;
  const safeFooter = `_${escapeMarkdownV2(stamp)}_`;
  return `${safeBody}\n\n${safeFooter}`;
}

export async function prDigestJob(
  ctx: PRContext,
  traceId: string,
): Promise<void> {
  const t0 = Date.now();
  ctx.log.info(
    { component: 'pr-digest', traceId },
    'pr digest start',
  );
  try {
    const snap = await computeDigestSnapshot(ctx);
    ctx.log.info(
      {
        component: 'pr-digest',
        traceId,
        open_prs_total: snap.open_prs_total,
        critical_open: snap.critical_open_prs.length,
        bottlenecks: snap.bottlenecks.length,
        stale_prs: snap.stale_prs.length,
      },
      'snapshot computed',
    );

    const brief = await synthesizeDigest(snap, ctx);
    const formatted = formatDigestForTelegram(brief, traceId, new Date());
    const ref = await ctx.telegram.send(formatted, { skipEscape: true });

    ctx.log.info(
      {
        component: 'pr-digest',
        traceId,
        elapsed_ms: Date.now() - t0,
        telegram_message_id: ref.messageId,
      },
      'pr digest delivered',
    );
  } catch (err) {
    ctx.log.error(
      {
        component: 'pr-digest',
        traceId,
        elapsed_ms: Date.now() - t0,
        err: err instanceof Error ? err.message : String(err),
      },
      'pr digest failed',
    );
  }
}
