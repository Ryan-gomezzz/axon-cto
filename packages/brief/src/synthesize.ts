import OpenAI from 'openai';
import type { BriefContext, BriefSignals } from './types.js';

export const SYSTEM_PROMPT = `You are Axon, a synthetic engineering chief of staff at a fast-moving engineering org.

Produce a morning intelligence brief as exactly 5 bullets, one short paragraph each. Use a "* " prefix for each bullet. No headings, no preamble, no closing line.

Hard rules:
- Lead with the highest-signal item from the knowledge graph (recurring incident patterns, open ADRs touching active services, engineer-load anomalies). KG-derived insights MUST appear in the brief — at least one bullet must cite a KG-grounded fact like "auth-service: 3rd incident this month" or "decision-1 (Bound Redis pools) still open after 21d".
- Never surface a raw number without a one-sentence reason it matters. "11 PRs merged in 24h" is wrong; "11 PRs merged in 24h, none touching critical paths — load is healthy" is right.
- If a fetcher failed (you'll see <error> tags), acknowledge the gap in one bullet rather than pretending the data is complete.
- Keep each bullet under ~30 words. Plain text, no markdown formatting characters inside the bullet content (the formatter handles emphasis later).
- Output ONLY the 5 bullets, separated by newlines.`;

export function buildUserMessage(signals: BriefSignals): string {
  const sections: string[] = [];

  // KG patterns lead the prompt to bias the LLM toward KG-grounded bullets.
  if (signals.kg.ok) {
    const kg = signals.kg.data;
    const patternLines = kg.recurringPatterns.length
      ? kg.recurringPatterns
          .map(
            (p) =>
              `  <pattern service="${p.service_name}" count_30d="${p.count_30d}" most_recent="${escapeXml(p.most_recent_title)}" days_ago="${p.most_recent_days_ago}"/>`,
          )
          .join('\n')
      : '  <none/>';
    sections.push(`<patterns>\n${patternLines}\n</patterns>`);

    const adrLines = kg.openADRs.length
      ? kg.openADRs
          .map((d) => {
            const ageDays = Math.floor(
              (Date.now() - d.payload.created_at) / 86_400_000,
            );
            return `  <adr id="${d.id}" title="${escapeXml(d.payload.title)}" age_days="${ageDays}"/>`;
          })
          .join('\n')
      : '  <none/>';
    sections.push(`<open_adrs>\n${adrLines}\n</open_adrs>`);

    const loadLines = kg.engineerLoad.length
      ? kg.engineerLoad
          .map(
            (e) =>
              `  <engineer name="${escapeXml(e.name)}" handle="${e.github_handle}" current_load="${e.current_load}" open_prs="${e.open_prs}" recent_incidents="${e.recent_incidents}" review_queue="${e.review_queue_size}"/>`,
          )
          .join('\n')
      : '  <none/>';
    sections.push(`<load>\n${loadLines}\n</load>`);

    sections.push(
      `<trend incidents_this_week="${kg.incidentTrend.thisWeek}" incidents_last_week="${kg.incidentTrend.lastWeek}" delta_pct="${kg.incidentTrend.deltaPct}"/>`,
    );
  } else {
    sections.push(`<patterns><error>${escapeXml(signals.kg.error)}</error></patterns>`);
  }

  if (signals.prs.ok) {
    const prs = signals.prs.data;
    const merged = prs.filter((p) => p.state === 'merged');
    const open = prs.filter((p) => p.state === 'open');
    sections.push(
      `<prs merged_24h="${merged.length}" open="${open.length}">\n${prs
        .slice(0, 8)
        .map(
          (p) =>
            `  <pr number="${p.number}" state="${p.state}" author="${p.author}" title="${escapeXml(p.title)}"/>`,
        )
        .join('\n')}\n</prs>`,
    );
  } else {
    sections.push(`<prs><error>${escapeXml(signals.prs.error)}</error></prs>`);
  }

  if (signals.blockers.ok) {
    const lines = signals.blockers.data.length
      ? signals.blockers.data
          .map(
            (b) =>
              `  <issue id="${b.identifier}" priority="${b.priority}" state="${b.state}" title="${escapeXml(b.title)}"/>`,
          )
          .join('\n')
      : '  <none/>';
    sections.push(`<blockers>\n${lines}\n</blockers>`);
  } else {
    sections.push(`<blockers><error>${escapeXml(signals.blockers.error)}</error></blockers>`);
  }

  if (signals.errors.ok) {
    const lines = signals.errors.data.length
      ? signals.errors.data
          .map(
            (e) =>
              `  <error_summary fingerprint="${e.fingerprint}" count="${e.count}" service="${e.service}" title="${escapeXml(e.title)}"/>`,
          )
          .join('\n')
      : '  <none/>';
    sections.push(`<errors>\n${lines}\n</errors>`);
  } else {
    sections.push(`<errors><error>${escapeXml(signals.errors.error)}</error></errors>`);
  }

  return sections.join('\n\n');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface SynthesizeDeps {
  /** Test seam — replace with a stub OpenAI client. */
  client?: OpenAI;
}

export async function synthesizeBrief(
  signals: BriefSignals,
  ctx: Pick<BriefContext, 'env' | 'log'>,
  deps: SynthesizeDeps = {},
): Promise<string> {
  const client =
    deps.client ??
    new OpenAI({
      apiKey: ctx.env.LLM_API_KEY,
      baseURL: ctx.env.LLM_BASE_URL,
    });

  const userMessage = buildUserMessage(signals);

  const stream = await client.chat.completions.create({
    model: ctx.env.LLM_MODEL_ROUTINE,
    stream: true,
    max_tokens: 600,
    temperature: 0.4,
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
