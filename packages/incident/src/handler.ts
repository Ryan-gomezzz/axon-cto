import { parseAndValidateSentry, sentryToIncident } from './ingest.js';
import { enrichIncident } from './enrich.js';
import { synthesizeIncidentResponse } from './synthesize.js';
import { RecoveryRegistry } from './recovery.js';
import type { IncidentJobContext } from './types.js';

export interface IncidentJobOptions {
  recovery: RecoveryRegistry;
  /** Test seam — injectable Date.now used by stage timing logs and synthesize. */
  now?: () => number;
}

/**
 * The full incident pipeline. Reads a Sentry payload off the gateway queue,
 * persists the incident, enriches it, streams a synthesised response to
 * Telegram (returns at first-token-sent), and spawns a recovery monitor.
 *
 * Always resolves; never throws. Failures are logged with stage-timing so we
 * can see *which* stage missed the <60s SLA.
 */
export async function incidentJob(
  payload: unknown,
  ctx: IncidentJobContext,
  traceId: string,
  options: IncidentJobOptions,
): Promise<void> {
  const now = options.now ?? Date.now;
  const T0 = now();
  let T1 = T0;
  let T2 = T0;
  let T3 = T0;
  let incidentId = 'unknown';

  try {
    const sentry = parseAndValidateSentry(payload);
    const incident = sentryToIncident(sentry, ctx.kg);
    incidentId = incident.id;
    T1 = now();

    const enriched = await enrichIncident(incident, ctx, traceId);
    T2 = now();

    const result = await synthesizeIncidentResponse(enriched, ctx.telegram, {
      log: ctx.log,
      env: ctx.env,
      ...(ctx.openaiClient ? { client: ctx.openaiClient } : {}),
      now,
    });
    T3 = now();

    ctx.log.info(
      {
        component: 'incident',
        traceId,
        incident_id: incidentId,
        stage_ingest_ms: T1 - T0,
        stage_enrich_ms: T2 - T1,
        stage_synth_first_chunk_ms: T3 - T2,
        total_ms: T3 - T0,
        sla_60s: T3 - T0 < 60_000,
        telegram_message_id: result.messageRef.messageId,
      },
      'incident pipeline first-token sent',
    );

    // Recovery monitor — fire and forget. Don't await.
    options.recovery.start(incident.id, enriched.service, ctx);
  } catch (err) {
    ctx.log.error(
      {
        component: 'incident',
        traceId,
        incident_id: incidentId,
        stage_ingest_ms: T1 - T0,
        stage_enrich_ms: T2 - T1,
        elapsed_ms: now() - T0,
        err: err instanceof Error ? err.message : String(err),
      },
      'incident pipeline failed',
    );
  }
}
