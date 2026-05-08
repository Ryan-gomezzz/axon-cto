// Barrel for the gateway package — safe to import without booting.
// Process entrypoint lives in src/main.ts; the dev script targets that.

export { createApp, type ServerContext, type ServerEnv } from './server.js';
export { JobQueue, type Job, type JobHandler } from './queue.js';
export { Scheduler, type SchedulerOptions } from './scheduler.js';

export const PACKAGE_NAME = '@axon/gateway';
