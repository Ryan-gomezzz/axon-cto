import { newTraceId } from '@axon/shared';
import { morningBriefJob } from './handler.js';
import type { BriefContext } from './types.js';

/**
 * Minimal duck-typed scheduler so this package doesn't depend on @axon/gateway
 * (gateway depends on us — it calls registerMorningBrief on boot — so the
 * reverse import would form a cycle).
 */
export interface SchedulerLike {
  register(
    name: string,
    cron: string,
    handler: () => Promise<void>,
    opts?: { timezone?: string },
  ): void;
}

export interface RegisterContext extends BriefContext {
  scheduler: SchedulerLike;
}

/** Wire the 8 AM IST morning brief into the gateway's scheduler. */
export function registerMorningBrief(ctx: RegisterContext): void {
  ctx.scheduler.register(
    'morning-brief',
    '0 8 * * *',
    () => morningBriefJob(ctx, newTraceId()),
    { timezone: 'Asia/Kolkata' },
  );
}
