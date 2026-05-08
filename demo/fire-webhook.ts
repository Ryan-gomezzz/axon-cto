import 'dotenv/config';
import * as crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Demo driver: stages a synthetic auth-service incident, fires it on keypress
 * with a valid HMAC, and (if LOG_FILE is set) tails the gateway log to print
 * the actual time-to-first-Telegram-message — the SLA the demo lives or dies on.
 *
 * Usage (from repo root):
 *   pnpm exec tsx demo/fire-webhook.ts
 *
 * Required env: SENTRY_WEBHOOK_SECRET. Optional: PORT (default 3000), LOG_FILE.
 */

const SECRET = process.env['SENTRY_WEBHOOK_SECRET'];
if (!SECRET) {
  console.error('fire-webhook: SENTRY_WEBHOOK_SECRET is required.');
  process.exit(1);
}
const PORT = process.env['PORT'] ?? '3000';
const URL = `http://localhost:${PORT}/webhook/sentry`;
const LOG_FILE = process.env['LOG_FILE'];

const PAYLOAD = {
  event_id: `demo-evt-${Date.now()}`,
  project: 'auth-service',
  level: 'fatal',
  title: 'auth-service: 5xx spike on /token — Redis pool exhausted',
  environment: 'production',
  fingerprint: ['auth-service', 'redis', 'pool-exhaustion'],
  timestamp: Math.floor(Date.now() / 1000),
};

const TARGET_LOG = 'incident pipeline first-token sent';
const SLA_BUDGET_MS = 60_000;

console.log('▣ Axon demo — synthetic auth-service incident');
console.log(`  target  ${URL}`);
console.log(`  event_id  ${PAYLOAD.event_id}`);
if (LOG_FILE) {
  console.log(`  tailing  ${LOG_FILE}`);
} else {
  console.log(
    '  (LOG_FILE unset — first-token-sent timing will be unavailable)',
  );
}
console.log('');
console.log('Press any key to fire ▶');

await waitForKeypress();

const body = JSON.stringify(PAYLOAD);
const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
const t0 = Date.now();
let res: Response;
try {
  res = await fetch(URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'sentry-hook-signature': sig,
    },
    body,
  });
} catch (err) {
  console.error('\nfire-webhook: POST failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
const ackElapsed = Date.now() - t0;

if (!res.ok) {
  console.error(`\nfire-webhook: webhook returned HTTP ${res.status}`);
  process.exit(1);
}
const ack = (await res.json().catch(() => ({}))) as {
  status?: string;
  traceId?: string;
};
const traceId = ack.traceId;
console.log(
  `\n[T+${pad4(ackElapsed)}ms] webhook ack 200 OK · trace ${traceId ?? '(none)'}`,
);

if (!LOG_FILE || !traceId) {
  console.log('\nDone (no log tail configured).');
  process.exit(0);
}

const result = await tailFor(LOG_FILE, traceId, t0, SLA_BUDGET_MS);
if (!result) {
  console.error(
    `\nfire-webhook: timed out after ${SLA_BUDGET_MS}ms waiting for "${TARGET_LOG}". SLA missed.`,
  );
  process.exit(2);
}
console.log(`[T+${pad4(result.elapsed)}ms] first Telegram message sent`);
console.log('');
const colour = result.elapsed < 60_000 ? '\x1b[32m' : '\x1b[31m';
const reset = '\x1b[0m';
console.log(
  `${colour}SLA <60s: ${result.elapsed < 60_000 ? 'PASSED' : 'FAILED'} (${(result.elapsed / 1000).toFixed(1)}s)${reset}`,
);
if (result.stages) {
  console.log(
    `  ingest  ${result.stages.stage_ingest_ms}ms | enrich  ${result.stages.stage_enrich_ms}ms | synth-first-chunk  ${result.stages.stage_synth_first_chunk_ms}ms`,
  );
}

async function waitForKeypress(): Promise<void> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    // Not a TTY (CI, piped). Just continue immediately.
    return;
  }
  stdin.setRawMode(true);
  stdin.resume();
  await new Promise<void>((resolve) => {
    stdin.once('data', () => {
      stdin.setRawMode(false);
      stdin.pause();
      resolve();
    });
  });
}

interface TailResult {
  elapsed: number;
  line: string;
  stages?: {
    stage_ingest_ms: number;
    stage_enrich_ms: number;
    stage_synth_first_chunk_ms: number;
  };
}

async function tailFor(
  file: string,
  traceId: string,
  startMs: number,
  timeoutMs: number,
): Promise<TailResult | null> {
  const deadline = startMs + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        const content = await readFile(file, 'utf8');
        const lines = content.split('\n');
        // Iterate newest-first so a busy log doesn't slow us down.
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];
          if (!line || !line.includes(traceId)) continue;
          if (!line.includes(TARGET_LOG)) continue;
          let parsed: Record<string, unknown> | undefined;
          try {
            parsed = JSON.parse(line) as Record<string, unknown>;
          } catch {
            // pino-pretty or partial line — ignore.
            continue;
          }
          const t = typeof parsed['time'] === 'number' ? parsed['time'] : Date.now();
          return {
            elapsed: t - startMs,
            line,
            stages: {
              stage_ingest_ms: Number(parsed['stage_ingest_ms'] ?? 0),
              stage_enrich_ms: Number(parsed['stage_enrich_ms'] ?? 0),
              stage_synth_first_chunk_ms: Number(
                parsed['stage_synth_first_chunk_ms'] ?? 0,
              ),
            },
          };
        }
      } catch {
        // EBUSY / mid-write — try again next loop.
      }
    }
    await sleep(150);
  }
  return null;
}

function pad4(ms: number): string {
  return String(ms).padStart(4, ' ');
}
