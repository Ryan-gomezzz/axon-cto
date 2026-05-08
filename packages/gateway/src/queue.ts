import type { Logger } from 'pino';
import { withTrace } from '@axon/shared';

export interface Job<T = unknown> {
  type: string;
  traceId: string;
  payload: T;
}

export type JobHandler<T = unknown> = (
  payload: T,
  traceId: string,
) => Promise<void>;

export interface JobQueueOptions {
  log: Logger;
  /** Backpressure cap — enqueue throws when this is hit. */
  maxQueueSize?: number;
}

export class JobQueue {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly queues = new Map<string, Job[]>();
  private readonly workers = new Map<string, Promise<void>>();
  private readonly maxQueueSize: number;
  private readonly log: Logger;

  constructor(opts: JobQueueOptions) {
    this.log = opts.log;
    this.maxQueueSize = opts.maxQueueSize ?? 1000;
  }

  registerHandler<T>(type: string, handler: JobHandler<T>): void {
    if (this.handlers.has(type)) {
      throw new Error(`queue: handler for "${type}" already registered`);
    }
    this.handlers.set(type, handler as JobHandler);
    if (!this.queues.has(type)) this.queues.set(type, []);
  }

  async enqueue(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      throw new Error(`queue: no handler registered for "${job.type}"`);
    }
    const q = this.queues.get(job.type);
    if (!q) {
      // Defensive: registerHandler should have created this.
      throw new Error(`queue: missing queue array for "${job.type}"`);
    }
    if (q.length >= this.maxQueueSize) {
      throw new Error(
        `queue: backpressure for "${job.type}" (size ${q.length} >= ${this.maxQueueSize})`,
      );
    }
    q.push(job);
    this.startWorker(job.type);
  }

  private startWorker(type: string): void {
    if (this.workers.has(type)) return;
    const handler = this.handlers.get(type);
    const q = this.queues.get(type);
    if (!handler || !q) return;

    const run = async (): Promise<void> => {
      try {
        while (q.length > 0) {
          const job = q.shift();
          if (!job) break;
          try {
            await withTrace(job.traceId, () => handler(job.payload, job.traceId));
          } catch (err) {
            this.log.error(
              {
                component: 'queue',
                jobType: type,
                traceId: job.traceId,
                err: err instanceof Error ? err.message : String(err),
              },
              'job handler failed',
            );
          }
        }
      } finally {
        this.workers.delete(type);
        if (q.length > 0) this.startWorker(type);
      }
    };

    this.workers.set(type, run());
  }

  /** Resolve once every queue is empty and every worker has exited. */
  async drain(): Promise<void> {
    // Snapshot active workers, await them, repeat until quiescent.
    while (true) {
      const inFlight = Array.from(this.workers.values());
      if (inFlight.length === 0) {
        const pending = Array.from(this.queues.values()).some(
          (q) => q.length > 0,
        );
        if (!pending) return;
      }
      await Promise.all(inFlight);
    }
  }

  size(type: string): number {
    return this.queues.get(type)?.length ?? 0;
  }

  registeredTypes(): string[] {
    return Array.from(this.handlers.keys());
  }
}
