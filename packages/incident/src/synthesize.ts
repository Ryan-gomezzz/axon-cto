import OpenAI from 'openai';
import { escapeMarkdownV2, type InlineButton, type MessageRef, type TelegramClient } from '@axon/shared';
import type { IncidentContext, IncidentJobContext } from './types.js';

export const INCIDENT_SYSTEM_PROMPT = `You are Axon, a synthetic engineering chief of staff handling a live production incident.

Three principles govern every word:
- Proactive: state the next decision the engineer should make, not just facts.
- Synthesized: never surface a raw signal without one sentence of context. "3 deploys in 4h" is wrong; "3 deploys in 4h, last by raj-kumar 23m before this incident" is right.
- Autonomous: keep it tight — the engineer is on a phone, not a dashboard.

Output structure (exactly this order, plain text, no markdown formatting characters):
Line 1: One-sentence headline naming the service and the severity.
Line 2: empty.
Line 3-onwards: 3 to 5 short bullets prefixed "* ", in this priority:
  1. Causal chain: which recent deploy(s) likely caused this, who shipped it, when.
  2. Pattern context from the knowledge graph (recurring incidents, open ADRs).
  3. On-call engineer note (handle, why they're on-call).
  4. Recommended action (rollback specific deploy / acknowledge / escalate).

Hard rules:
- The first bullet MUST cite a deploy SHA or a recurring-incident count drawn from the input. Never speculate.
- If <recurring_patterns> shows >=2 incidents on this service in 30 days, you MUST mention "Nth incident" or "recurring".
- If <open_adrs> shows an open ADR for this service, you MUST name it (id and title) so the engineer knows about prior context.
- No closing line, no greeting, no markdown headings. Plain text bullets only.`;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildIncidentUserMessage(ctx: IncidentContext): string {
  const inc = ctx.incident;
  const incidentXml = `<incident id="${inc.id}" severity="${inc.payload.severity}" service="${ctx.service.payload.name}" started_at_ms="${inc.payload.started_at}" title="${escapeXml(inc.payload.title)}"/>`;

  const patternsXml =
    ctx.recurringPatterns.length > 0
      ? `<recurring_patterns count="${ctx.recurringPatterns.length}">\n${ctx.recurringPatterns
          .map((p) => {
            const daysAgo = Math.floor(
              (Date.now() - p.payload.started_at) / 86_400_000,
            );
            return `  <prior_incident id="${p.id}" severity="${p.payload.severity}" days_ago="${daysAgo}" title="${escapeXml(p.payload.title)}" root_cause="${escapeXml(p.payload.root_cause ?? '')}"/>`;
          })
          .join('\n')}\n</recurring_patterns>`
      : `<recurring_patterns count="0"/>`;

  const deploysXml =
    ctx.recentDeploys.length > 0
      ? `<recent_deploys count="${ctx.recentDeploys.length}">\n${ctx.recentDeploys
          .map((d) => {
            const minutesAgo = Math.floor(
              (Date.now() - d.deployed_at) / 60_000,
            );
            return `  <deploy sha="${d.short_sha}" author="${d.author_handle}" minutes_ago="${minutesAgo}" title="${escapeXml(d.title)}"/>`;
          })
          .join('\n')}\n</recent_deploys>`
      : `<recent_deploys count="0"/>`;

  const adrsXml =
    ctx.openADRs.length > 0
      ? `<open_adrs count="${ctx.openADRs.length}">\n${ctx.openADRs
          .map((d) => {
            const ageDays = Math.floor(
              (Date.now() - d.payload.created_at) / 86_400_000,
            );
            return `  <adr id="${d.id}" title="${escapeXml(d.payload.title)}" age_days="${ageDays}"/>`;
          })
          .join('\n')}\n</open_adrs>`
      : `<open_adrs count="0"/>`;

  const oncallXml = ctx.onCallEngineer
    ? `<oncall handle="${ctx.onCallEngineer.github_handle}" source="${ctx.onCallEngineer.source}"${ctx.onCallEngineer.name ? ` name="${escapeXml(ctx.onCallEngineer.name)}"` : ''}/>`
    : `<oncall available="false"/>`;

  return [incidentXml, patternsXml, deploysXml, adrsXml, oncallXml].join('\n\n');
}

const EDIT_THROTTLE_MS = 800;

function formatBody(body: string, ctx: IncidentContext, complete: boolean): string {
  const safeBody = escapeMarkdownV2(body.trim());
  const status = complete ? '' : ' \\(streaming…\\)';
  const header = `*${escapeMarkdownV2(ctx.incident.payload.severity)}* · ${escapeMarkdownV2(ctx.service.payload.name)}${status}`;
  const footer = `_${escapeMarkdownV2(`incident ${ctx.incident.id} · trace ${ctx.traceId}`)}_`;
  return `${header}\n\n${safeBody}\n\n${footer}`;
}

function buildFinalButtons(ctx: IncidentContext): InlineButton[][] {
  const incidentId = ctx.incident.id;
  const topDeploy = ctx.recentDeploys[0];
  const rollbackData = topDeploy
    ? `rollback:${incidentId}:${topDeploy.sha}`
    : `rollback:${incidentId}:`;
  return [
    [{ text: '↩ Rollback', callback_data: rollbackData }],
    [
      { text: '✓ Acknowledge', callback_data: `ack:${incidentId}` },
      { text: '↑ Escalate', callback_data: `escalate:${incidentId}` },
    ],
  ];
}

interface SynthesizeResult {
  messageRef: MessageRef;
  /** Wallclock from synthesize entry to first-token-sent. */
  totalMs: number;
}

interface ChatChunk {
  choices: Array<{ delta?: { content?: string | null } }>;
}

async function nextDelta(
  iter: AsyncIterator<ChatChunk>,
): Promise<{ delta: string; done: false } | { done: true }> {
  while (true) {
    const next = await iter.next();
    if (next.done) return { done: true };
    const delta = next.value.choices[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      return { delta, done: false };
    }
  }
}

/**
 * Background loop that consumes the rest of the stream after the first message
 * has been delivered. Edits are throttled and per-edit failures are swallowed
 * (Telegram occasionally rejects identical-text edits with HTTP 400; that's
 * fine to log-and-continue).
 */
async function continueStreaming(
  iter: AsyncIterator<ChatChunk>,
  initialBuffer: string,
  messageRef: MessageRef,
  telegram: TelegramClient,
  ctx: IncidentContext,
  log: IncidentJobContext['log'],
  now: () => number,
): Promise<void> {
  let buffer = initialBuffer;
  let lastEdit = now();
  try {
    while (true) {
      const step = await nextDelta(iter);
      if (step.done) break;
      buffer += step.delta;
      if (now() - lastEdit >= EDIT_THROTTLE_MS) {
        try {
          await telegram.editMessage(
            messageRef,
            formatBody(buffer, ctx, false),
            { skipEscape: true },
          );
        } catch (err) {
          log.debug(
            {
              component: 'incident',
              stage: 'edit',
              traceId: ctx.traceId,
              err: err instanceof Error ? err.message : String(err),
            },
            'mid-stream edit failed (non-fatal)',
          );
        }
        lastEdit = now();
      }
    }
    // Final edit: full body + buttons.
    try {
      await telegram.editMessage(
        messageRef,
        formatBody(buffer, ctx, true),
        { skipEscape: true, buttons: buildFinalButtons(ctx) },
      );
    } catch (err) {
      log.warn(
        {
          component: 'incident',
          stage: 'final-edit',
          traceId: ctx.traceId,
          err: err instanceof Error ? err.message : String(err),
        },
        'final edit failed',
      );
    }
  } catch (err) {
    log.error(
      {
        component: 'incident',
        stage: 'stream',
        traceId: ctx.traceId,
        err: err instanceof Error ? err.message : String(err),
      },
      'stream errored mid-incident',
    );
  }
}

interface SynthesizeDeps {
  log: IncidentJobContext['log'];
  env: IncidentJobContext['env'];
  client?: OpenAI;
  /** Test seam — replaces `Date.now` for deterministic timing assertions. */
  now?: () => number;
  /** Test seam — fires when the background edit loop has fully completed. */
  onBackgroundDone?: () => void;
}

/**
 * Stream an incident response to Telegram. Resolves at T3 (first chunk sent).
 * Continues consuming the stream and editing the message in the background;
 * does not await that work.
 */
export async function synthesizeIncidentResponse(
  ctx: IncidentContext,
  telegram: TelegramClient,
  deps: SynthesizeDeps,
): Promise<SynthesizeResult> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const client =
    deps.client ??
    new OpenAI({
      apiKey: deps.env.LLM_API_KEY,
      baseURL: deps.env.LLM_BASE_URL,
    });

  const stream = (await client.chat.completions.create({
    model: deps.env.LLM_MODEL_INCIDENT,
    stream: true,
    max_tokens: 800,
    temperature: 0.2,
    messages: [
      { role: 'system', content: INCIDENT_SYSTEM_PROMPT },
      { role: 'user', content: buildIncidentUserMessage(ctx) },
    ],
  })) as unknown as AsyncIterable<ChatChunk>;

  const iter = stream[Symbol.asyncIterator]();
  const first = await nextDelta(iter);

  if (first.done) {
    // Empty stream — degrade to a one-shot fallback message.
    const fallback = `${ctx.service.payload.name} ${ctx.incident.payload.severity}: ${ctx.incident.payload.title}\n\n* No synthesis available.`;
    const messageRef = await telegram.send(
      formatBody(fallback, ctx, true),
      { skipEscape: true, buttons: buildFinalButtons(ctx) },
    );
    return { messageRef, totalMs: now() - t0 };
  }

  const buffer = first.delta;
  const messageRef = await telegram.send(formatBody(buffer, ctx, false), {
    skipEscape: true,
  });
  const totalMs = now() - t0;

  // Hand the rest of the stream off to a background task so the caller can
  // record T3 and move on to spawning the recovery monitor.
  void continueStreaming(iter, buffer, messageRef, telegram, ctx, deps.log, now)
    .finally(() => {
      deps.onBackgroundDone?.();
    });

  return { messageRef, totalMs };
}
