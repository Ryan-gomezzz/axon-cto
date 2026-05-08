import OpenAI from 'openai';
import { escapeMarkdownV2 } from '@axon/shared';
import { computeSprintRisk } from './score.js';
import { findCurrentSprint, gatherSprintSignals } from './signals.js';
import {
  getRiskTrend,
  persistRiskScore,
  weekOverWeekDelta,
} from './trend.js';
import type { RiskScore, SprintContext, SprintSignals } from './types.js';

const SYSTEM_PROMPT = `You are Axon, a synthetic engineering chief of staff. Produce a sprint risk digest as a 4-line message in this exact shape, no preamble, no closing line:

Line 1: One-line headline naming the sprint and the score with a directional arrow vs last week.
Line 2: empty.
Line 3-onwards: 3 bullets prefixed "* ", each surfacing one of the top contributing components from the breakdown. Each bullet must reframe the raw component into a sentence — "deadline_pressure 7.5/15" is wrong; "Halfway through the sprint with no points completed — deadline pressure is the dominant risk." is right.

Hard rules:
- The headline MUST cite the score and either the WoW delta or "(no prior data)" if absent.
- Pick the 3 bullets from the components with the largest weighted contributions (highest values in the breakdown).
- Plain text inside bullets, no markdown formatting characters beyond bullets.
- If the input has <signals_failed/>, emit a single bullet apologising and explaining which signals were missing — do not fabricate a score-derived sentence in that case.`;

interface FactorRow {
  key: string;
  weighted: number;
  raw: number;
}

function topFactors(score: RiskScore, signals: SprintSignals): FactorRow[] {
  const rawByKey: Record<string, number> = {
    blocker_weight: signals.blocker_weight,
    velocity_gap: 1 - signals.velocity_ratio,
    scope_creep: signals.scope_creep_pct,
    deadline_pressure: signals.days_to_deadline_pressure,
    systemic_block: signals.systemic_block,
  };
  const rows: FactorRow[] = Object.entries(score.breakdown).map(
    ([key, weighted]) => ({
      key,
      weighted,
      raw: rawByKey[key] ?? 0,
    }),
  );
  rows.sort((a, b) => b.weighted - a.weighted);
  return rows.slice(0, 3);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface UserMessageInput {
  sprint_id: string;
  sprint_number: number;
  score: RiskScore;
  signals: SprintSignals;
  delta: { current: number; previous: number | null; delta: number | null };
  factors: FactorRow[];
}

export function buildSprintUserMessage(input: UserMessageInput): string {
  const factorXml = input.factors
    .map(
      (f) =>
        `  <factor key="${f.key}" weighted="${f.weighted.toFixed(2)}" raw="${f.raw.toFixed(2)}"/>`,
    )
    .join('\n');
  return [
    `<sprint id="${escapeXml(input.sprint_id)}" number="${input.sprint_number}"/>`,
    `<score current="${input.score.score.toFixed(1)}" previous="${input.delta.previous ?? 'null'}" delta="${input.delta.delta ?? 'null'}"/>`,
    `<signals blocker_weight="${input.signals.blocker_weight.toFixed(2)}" velocity_ratio="${input.signals.velocity_ratio.toFixed(2)}" scope_creep_pct="${input.signals.scope_creep_pct.toFixed(2)}" days_to_deadline_pressure="${input.signals.days_to_deadline_pressure.toFixed(2)}" systemic_block="${input.signals.systemic_block}"/>`,
    `<top_factors>\n${factorXml}\n</top_factors>`,
  ].join('\n\n');
}

interface SynthesizeDeps {
  client?: OpenAI;
}

export async function synthesizeSprintBrief(
  userMessage: string,
  ctx: Pick<SprintContext, 'env'>,
  deps: SynthesizeDeps = {},
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
    max_tokens: 400,
    temperature: 0.3,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
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

export function formatSprintBriefForTelegram(
  body: string,
  traceId: string,
  generatedAt: Date,
): string {
  const safeBody = escapeMarkdownV2(body.trim());
  const stamp = `Sprint risk · ${istHourMinute(generatedAt)} IST · trace ${traceId}`;
  const safeFooter = `_${escapeMarkdownV2(stamp)}_`;
  return `${safeBody}\n\n${safeFooter}`;
}

/**
 * Run the sprint risk job once. Always resolves; never throws. If signals
 * gathering fails, sends a degraded brief acknowledging the failure rather
 * than crashing the cron.
 */
export async function sprintRiskBrief(
  ctx: SprintContext,
  traceId: string,
): Promise<void> {
  const t0 = Date.now();
  ctx.log.info({ component: 'sprint', traceId }, 'sprint risk brief start');

  const now = ctx.now ? ctx.now() : Date.now();
  let degraded: string | null = null;
  let userMessage = '';

  try {
    const sprint = findCurrentSprint(ctx.kg, now);
    if (!sprint) {
      degraded = 'No current sprint found in the knowledge graph.';
    } else {
      try {
        const signals = await gatherSprintSignals(sprint.id, ctx.kg, { now });
        const score = computeSprintRisk(signals);
        try {
          persistRiskScore(sprint.id, score.score, ctx.kg);
        } catch (err) {
          ctx.log.warn(
            {
              component: 'sprint',
              traceId,
              err: err instanceof Error ? err.message : String(err),
            },
            'persistRiskScore failed; continuing with in-memory result',
          );
        }
        const trend = getRiskTrend(ctx.kg);
        const wow = weekOverWeekDelta(trend, sprint.id, score.score);
        const factors = topFactors(score, signals);
        userMessage = buildSprintUserMessage({
          sprint_id: sprint.id,
          sprint_number: sprint.payload.number,
          score,
          signals,
          delta: {
            current: score.score,
            previous: wow.previous_score,
            delta: wow.delta_points,
          },
          factors,
        });
      } catch (err) {
        ctx.log.warn(
          {
            component: 'sprint',
            traceId,
            err: err instanceof Error ? err.message : String(err),
          },
          'gatherSprintSignals failed; sending degraded brief',
        );
        degraded = `Could not compute sprint risk for ${sprint.id}: ${
          err instanceof Error ? err.message : String(err)
        }.`;
      }
    }

    if (degraded !== null) {
      userMessage = `<signals_failed reason="${escapeXml(degraded)}"/>`;
    }

    let body: string;
    try {
      body = await synthesizeSprintBrief(userMessage, ctx, {
        ...(ctx.openaiClient ? { client: ctx.openaiClient } : {}),
      });
    } catch (err) {
      ctx.log.warn(
        {
          component: 'sprint',
          traceId,
          err: err instanceof Error ? err.message : String(err),
        },
        'LLM synthesis failed; falling back to deterministic body',
      );
      body =
        degraded !== null
          ? `Sprint risk: degraded — ${degraded}`
          : `Sprint risk: synthesis unavailable; raw input below:\n${userMessage}`;
    }

    const formatted = formatSprintBriefForTelegram(
      body,
      traceId,
      new Date(now),
    );
    try {
      await ctx.telegram.send(formatted, { skipEscape: true });
    } catch (err) {
      ctx.log.warn(
        {
          component: 'sprint',
          traceId,
          err: err instanceof Error ? err.message : String(err),
        },
        'telegram.send failed',
      );
    }

    ctx.log.info(
      {
        component: 'sprint',
        traceId,
        elapsed_ms: Date.now() - t0,
        degraded: degraded !== null,
      },
      'sprint risk brief delivered',
    );
  } catch (err) {
    ctx.log.error(
      {
        component: 'sprint',
        traceId,
        elapsed_ms: Date.now() - t0,
        err: err instanceof Error ? err.message : String(err),
      },
      'sprint risk brief threw — should be unreachable',
    );
  }
}
