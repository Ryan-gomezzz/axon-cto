import nodeCron, { type ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';
import { newTraceId, withTrace } from '@axon/shared';

export interface SchedulerOptions {
  log: Logger;
  defaultTimezone?: string;
}

export interface SchedulerJob {
  name: string;
  cron: string;
  timezone: string;
  task: ScheduledTask;
}

export interface RegisterOptions {
  timezone?: string;
}

export class Scheduler {
  private readonly jobs = new Map<string, SchedulerJob>();
  private readonly log: Logger;
  private readonly defaultTimezone: string;

  constructor(opts: SchedulerOptions) {
    this.log = opts.log;
    this.defaultTimezone = opts.defaultTimezone ?? 'UTC';
  }

  register(
    name: string,
    cron: string,
    handler: () => Promise<void>,
    opts: RegisterOptions = {},
  ): void {
    if (this.jobs.has(name)) {
      throw new Error(`scheduler: job "${name}" is already registered`);
    }
    if (!nodeCron.validate(cron)) {
      throw new Error(`scheduler: invalid cron expression for "${name}": ${cron}`);
    }
    const timezone = opts.timezone ?? this.defaultTimezone;
    const task = nodeCron.schedule(
      cron,
      async () => {
        const traceId = newTraceId();
        const t0 = Date.now();
        this.log.info(
          { component: 'scheduler', cron_name: name, cron, traceId },
          'cron fired',
        );
        try {
          await withTrace(traceId, () => handler());
          this.log.info(
            {
              component: 'scheduler',
              cron_name: name,
              traceId,
              elapsed_ms: Date.now() - t0,
            },
            'cron handler ok',
          );
        } catch (err) {
          this.log.error(
            {
              component: 'scheduler',
              cron_name: name,
              traceId,
              elapsed_ms: Date.now() - t0,
              err: err instanceof Error ? err.message : String(err),
            },
            'cron handler threw',
          );
        }
      },
      { timezone },
    );

    this.jobs.set(name, { name, cron, timezone, task });
    this.log.info(
      { component: 'scheduler', cron_name: name, cron, timezone },
      'cron registered',
    );
  }

  /** Log every registered cron. Called once at gateway boot. */
  announce(): void {
    const all = Array.from(this.jobs.values());
    if (all.length === 0) {
      this.log.info(
        { component: 'scheduler', count: 0 },
        'no cron jobs registered',
      );
      return;
    }
    for (const j of all) {
      this.log.info(
        {
          component: 'scheduler',
          cron_name: j.name,
          cron: j.cron,
          timezone: j.timezone,
        },
        'cron registered (next fire computed by node-cron at runtime)',
      );
    }
  }

  list(): Array<Pick<SchedulerJob, 'name' | 'cron' | 'timezone'>> {
    return Array.from(this.jobs.values()).map(({ name, cron, timezone }) => ({
      name,
      cron,
      timezone,
    }));
  }

  stop(): void {
    for (const job of this.jobs.values()) {
      job.task.stop();
    }
  }
}
