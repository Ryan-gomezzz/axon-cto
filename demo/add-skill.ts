import { TelegramClient } from '@axon/shared';
import { env } from '@axon/shared/env';
import { logger } from '@axon/shared/logger';
import { openDb, KnowledgeGraph } from '@axon/kg';

/**
 * The "live extensibility flex". One command:
 *   pnpm exec tsx demo/add-skill.ts standup
 *
 * Reads the seeded KG, summarises yesterday's PR activity into a standup-style
 * Telegram message, and times itself. Total time to first delivery is the
 * proof point: "adding a skill against the KG is trivial."
 *
 * Constraint: this script intentionally uses only the @axon/* public surface
 * (KnowledgeGraph + TelegramClient). No new business logic.
 */

const skill = process.argv[2] ?? 'standup';
if (skill !== 'standup') {
  console.error(`add-skill: unknown skill "${skill}". Only "standup" is wired in this demo.`);
  process.exit(1);
}

const log = logger.child({ component: 'add-skill', skill });
const t0 = Date.now();
log.info('skill: started');

const db = openDb(env.KG_DB_PATH);
const kg = new KnowledgeGraph(db);

const allPrs = kg.sampleNodesByType('PR', 500);
const engineers = new Map<string, { name: string; handle: string }>();
for (const e of kg.sampleNodesByType('Engineer', 200)) {
  if (e.type !== 'Engineer') continue;
  engineers.set(e.id, {
    name: e.payload.name,
    handle: e.payload.github_handle,
  });
}

function describeAuthor(authorId: string): string {
  const eng = engineers.get(authorId);
  if (eng) return `${eng.name} (@${eng.handle})`;
  return authorId.startsWith('gh:') ? `@${authorId.slice(3)}` : authorId;
}

const DAY_MS = 86_400_000;
const yesterdayCutoff = Date.now() - DAY_MS;
const staleCutoff = Date.now() - 7 * DAY_MS;

const mergedYesterday = allPrs
  .filter(
    (p) =>
      p.type === 'PR' &&
      p.payload.merged_at !== undefined &&
      p.payload.merged_at >= yesterdayCutoff,
  )
  .sort((a, b) => {
    const at = a.type === 'PR' ? (a.payload.merged_at ?? 0) : 0;
    const bt = b.type === 'PR' ? (b.payload.merged_at ?? 0) : 0;
    return bt - at;
  });

const openToday = allPrs.filter(
  (p) => p.type === 'PR' && p.payload.status === 'open',
);

const staleOpens = openToday.filter(
  (p) => p.type === 'PR' && p.payload.created_at < staleCutoff,
);

function formatPRLine(p: (typeof allPrs)[number]): string {
  if (p.type !== 'PR') return '';
  return `• #${p.payload.number} ${p.payload.title} — ${describeAuthor(p.payload.author_id)}`;
}

const lines: string[] = [];
lines.push('Daily Standup');
lines.push('');
lines.push(`Merged in last 24h: ${mergedYesterday.length}`);
if (mergedYesterday.length === 0) {
  lines.push('  (none)');
} else {
  for (const p of mergedYesterday.slice(0, 6)) {
    lines.push(`  ${formatPRLine(p)}`);
  }
  if (mergedYesterday.length > 6) {
    lines.push(`  ...and ${mergedYesterday.length - 6} more.`);
  }
}
lines.push('');
lines.push(`Open PRs today: ${openToday.length}`);
if (openToday.length === 0) {
  lines.push('  (none)');
} else {
  for (const p of openToday.slice(0, 6)) {
    lines.push(`  ${formatPRLine(p)}`);
  }
  if (openToday.length > 6) {
    lines.push(`  ...and ${openToday.length - 6} more.`);
  }
}
if (staleOpens.length > 0) {
  lines.push('');
  lines.push(`Stale (>7d, ${staleOpens.length}):`);
  for (const p of staleOpens.slice(0, 4)) {
    lines.push(`  ${formatPRLine(p)}`);
  }
}

const text = lines.join('\n');

const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
try {
  const ref = await telegram.send(text);
  const elapsed = Date.now() - t0;
  log.info(
    {
      elapsed_ms: elapsed,
      sub_30s: elapsed < 30_000,
      telegram_message_id: ref.messageId,
      merged_24h: mergedYesterday.length,
      open: openToday.length,
      stale: staleOpens.length,
    },
    'skill: standup delivered',
  );
  console.log(
    `✓ Standup delivered in ${(elapsed / 1000).toFixed(2)}s` +
      (elapsed < 30_000 ? ' (under 30s target)' : ' (over 30s target)'),
  );
} catch (err) {
  const elapsed = Date.now() - t0;
  log.error(
    {
      elapsed_ms: elapsed,
      err: err instanceof Error ? err.message : String(err),
    },
    'skill: telegram send failed',
  );
  console.error(
    `✗ Standup send failed after ${(elapsed / 1000).toFixed(2)}s: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
  db.close();
  process.exit(1);
}

db.close();
process.exit(0);
