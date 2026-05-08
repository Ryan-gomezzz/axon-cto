import { dispatchCallback } from './actions.js';
import { incidentJob } from './handler.js';
import { RecoveryRegistry } from './recovery.js';
import type { IncidentJobContext } from './types.js';

/**
 * Minimal duck-typed queue interface so this package doesn't depend on
 * @axon/gateway (gateway depends on us — wiring registerIncidentHandlers at
 * boot — so the reverse import would form a cycle).
 */
export interface QueueLike {
  registerHandler<T = unknown>(
    type: string,
    handler: (payload: T, traceId: string) => Promise<void>,
  ): void;
}

export interface RegisterIncidentResult {
  recovery: RecoveryRegistry;
}

/**
 * Wire the incident pipeline into the gateway:
 *   - queue worker for type 'incident' delegates to incidentJob
 *   - Telegram callback router fans out rollback/ack/escalate to actions.ts
 *
 * Returns the RecoveryRegistry so the gateway shutdown handler can stop all
 * active recovery monitors.
 */
export function registerIncidentHandlers(
  ctx: IncidentJobContext & { queue: QueueLike },
): RegisterIncidentResult {
  const recovery = new RecoveryRegistry();

  ctx.queue.registerHandler('incident', (payload, traceId) =>
    incidentJob(payload, ctx, traceId, { recovery }),
  );

  // Telegram callback queries — only meaningful when the polling driver is
  // running. The TelegramClient lazily starts polling on first onCallback;
  // tests pass a mock driver via TelegramClientDeps.
  ctx.telegram.onCallback(async (data, callbackCtx) => {
    const fromHandle = callbackCtx.fromUserId
      ? `tg:${callbackCtx.fromUserId}`
      : 'tg:unknown';
    try {
      await dispatchCallback(
        data,
        {
          callbackQueryId: callbackCtx.callbackQueryId,
          fromUserHandle: fromHandle,
          ...(callbackCtx.message ? { message: callbackCtx.message } : {}),
        },
        ctx,
      );
    } catch (err) {
      ctx.log.error(
        {
          component: 'incident',
          stage: 'callback',
          data,
          err: err instanceof Error ? err.message : String(err),
        },
        'callback dispatch threw',
      );
    }
  });

  return { recovery };
}
