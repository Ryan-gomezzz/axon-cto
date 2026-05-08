import { newTraceId } from '@axon/shared';
import { handleGitHubPRWebhook } from './realtime.js';
import { prDigestJob } from './digest.js';
import type { PRContext, GatewayWebhookEnvelope } from './types.js';

export interface QueueLike {
  registerHandler<T = unknown>(
    type: string,
    handler: (payload: T, traceId: string) => Promise<void>,
  ): void;
}

export interface SchedulerLike {
  register(
    name: string,
    cron: string,
    handler: () => Promise<void>,
    opts?: { timezone?: string },
  ): void;
}

export interface RegisterPRContext extends PRContext {
  queue: QueueLike;
  scheduler: SchedulerLike;
}

/**
 * Wire the PR-health pipeline into the gateway:
 *   - queue worker for type 'pr-realtime' delegates to handleGitHubPRWebhook
 *   - cron 'pr-digest' fires the digest at 18:00 IST on weekdays
 */
export function registerPRHealth(ctx: RegisterPRContext): void {
  ctx.queue.registerHandler<GatewayWebhookEnvelope>(
    'pr-realtime',
    (payload, traceId) => handleGitHubPRWebhook(payload, ctx, traceId),
  );

  ctx.scheduler.register(
    'pr-digest',
    '0 18 * * 1-5',
    () => prDigestJob(ctx, newTraceId()),
    { timezone: 'Asia/Kolkata' },
  );
}
