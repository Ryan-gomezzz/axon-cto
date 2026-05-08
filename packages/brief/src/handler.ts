import {
  fetchKGSignals,
  fetchLinearBlockers,
  fetchOpenPRs,
  fetchSentryErrors,
} from './fetchers.js';
import { synthesizeBrief } from './synthesize.js';
import { formatForTelegram } from './format.js';
import type { BriefContext, BriefSignals, FetcherResult } from './types.js';

function settledToResult<T>(
  settled: PromiseSettledResult<FetcherResult<T>>,
): FetcherResult<T> {
  if (settled.status === 'fulfilled') return settled.value;
  return {
    ok: false,
    error:
      settled.reason instanceof Error
        ? settled.reason.message
        : String(settled.reason),
  };
}

/**
 * Run the morning brief once. Always returns; never throws. Failures inside
 * any single fetcher show up as `{ ok: false, error }` in the signals object
 * and are acknowledged by the LLM rather than aborting the brief.
 */
export async function morningBriefJob(
  ctx: BriefContext,
  traceId: string,
): Promise<void> {
  const t0 = Date.now();
  ctx.log.info({ component: 'brief', traceId }, 'morning brief start');

  try {
    const settled = await Promise.allSettled([
      fetchOpenPRs(ctx),
      fetchLinearBlockers(ctx),
      fetchSentryErrors(ctx),
      fetchKGSignals(ctx),
    ]);

    const signals: BriefSignals = {
      prs: settledToResult(settled[0]),
      blockers: settledToResult(settled[1]),
      errors: settledToResult(settled[2]),
      kg: settledToResult(settled[3]),
    };

    ctx.log.info(
      {
        component: 'brief',
        traceId,
        prs_ok: signals.prs.ok,
        blockers_ok: signals.blockers.ok,
        errors_ok: signals.errors.ok,
        kg_ok: signals.kg.ok,
      },
      'fetchers settled',
    );

    const tSynth = Date.now();
    const brief = await synthesizeBrief(signals, ctx);
    ctx.log.info(
      {
        component: 'brief',
        traceId,
        synth_ms: Date.now() - tSynth,
        chars: brief.length,
      },
      'synthesis done',
    );

    const formatted = formatForTelegram(brief, traceId, new Date());
    const ref = await ctx.telegram.send(formatted, { skipEscape: true });

    ctx.log.info(
      {
        component: 'brief',
        traceId,
        elapsed_ms: Date.now() - t0,
        telegram_message_id: ref.messageId,
      },
      'morning brief delivered',
    );
  } catch (err) {
    // Per spec: never throws. Log and exit cleanly so the scheduler doesn't
    // see a rejected promise.
    ctx.log.error(
      {
        component: 'brief',
        traceId,
        elapsed_ms: Date.now() - t0,
        err: err instanceof Error ? err.message : String(err),
      },
      'morning brief failed',
    );
  }
}
