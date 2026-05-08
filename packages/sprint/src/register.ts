import { newTraceId } from '@axon/shared';
import { sprintRiskBrief } from './brief.js';
import type { SprintContext } from './types.js';

export interface SchedulerLike {
  register(
    name: string,
    cron: string,
    handler: () => Promise<void>,
    opts?: { timezone?: string },
  ): void;
}

export interface RegisterSprintContext extends SprintContext {
  scheduler: SchedulerLike;
}

/** Wire the sprint risk cron at 09:00 IST on weekdays. */
export function registerSprintRisk(ctx: RegisterSprintContext): void {
  ctx.scheduler.register(
    'sprint-risk',
    '0 9 * * 1-5',
    () => sprintRiskBrief(ctx, newTraceId()),
    { timezone: 'Asia/Kolkata' },
  );
}
