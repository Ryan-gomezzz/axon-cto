import { TelegramClient } from '@axon/shared';
import { env } from '@axon/shared/env';
import { logger } from '@axon/shared/logger';
import { openDb, KnowledgeGraph } from '@axon/kg';
import { registerMorningBrief, type BriefContext } from '@axon/brief';
import {
  registerIncidentHandlers,
  type IncidentJobContext,
} from '@axon/incident';
import { JobQueue } from './queue.js';
import { Scheduler } from './scheduler.js';
import { createApp, type ServerContext } from './server.js';

export interface AppContext extends ServerContext {
  kg: KnowledgeGraph;
  telegram: TelegramClient;
  scheduler: Scheduler;
}

const log = logger;

const db = openDb(env.KG_DB_PATH);
const kg = new KnowledgeGraph(db);
const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
const queue = new JobQueue({ log: log.child({ component: 'queue' }) });
const scheduler = new Scheduler({
  log: log.child({ component: 'scheduler' }),
  defaultTimezone: 'Asia/Kolkata',
});

// 'incident' is registered by registerIncidentHandlers below.
queue.registerHandler('pr-realtime', async (_payload, traceId) => {
  // TODO(phase-5): wire @axon/pr.handleGitHubPRWebhook here.
  log.info(
    { component: 'queue', jobType: 'pr-realtime', traceId },
    'pr-realtime job received (handler not yet wired)',
  );
});

queue.registerHandler('github-event', async (_payload, traceId) => {
  // TODO(phase-5): broaden when we add non-PR GitHub event handling.
  log.info(
    { component: 'queue', jobType: 'github-event', traceId },
    'github-event job received (handler not yet wired)',
  );
});

queue.registerHandler('brief', async (_payload, traceId) => {
  // TODO(phase-3): wire @axon/brief.morningBriefJob here.
  log.info(
    { component: 'queue', jobType: 'brief', traceId },
    'brief job received (handler not yet wired)',
  );
});

const ctx: AppContext = {
  env: {
    SENTRY_WEBHOOK_SECRET: env.SENTRY_WEBHOOK_SECRET,
    GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET,
    NODE_ENV: env.NODE_ENV,
  },
  kg,
  telegram,
  queue,
  scheduler,
  log,
};

// Wire skill packages.
const briefCtx: BriefContext = {
  kg,
  telegram,
  log: log.child({ component: 'brief' }),
  env: {
    GITHUB_TOKEN: env.GITHUB_TOKEN,
    GITHUB_ORG: env.GITHUB_ORG,
    GITHUB_REPO: env.GITHUB_REPO,
    LINEAR_API_KEY: env.LINEAR_API_KEY,
    LLM_API_KEY: env.LLM_API_KEY,
    LLM_BASE_URL: env.LLM_BASE_URL,
    LLM_MODEL_ROUTINE: env.LLM_MODEL_ROUTINE,
    ...(process.env['SENTRY_AUTH_TOKEN']
      ? { SENTRY_AUTH_TOKEN: process.env['SENTRY_AUTH_TOKEN'] }
      : {}),
    ...(process.env['SENTRY_ORG']
      ? { SENTRY_ORG: process.env['SENTRY_ORG'] }
      : {}),
    ...(process.env['SENTRY_PROJECT']
      ? { SENTRY_PROJECT: process.env['SENTRY_PROJECT'] }
      : {}),
  },
};
registerMorningBrief({ ...briefCtx, scheduler });

const incidentCtx: IncidentJobContext = {
  kg,
  telegram,
  log: log.child({ component: 'incident' }),
  env: {
    GITHUB_TOKEN: env.GITHUB_TOKEN,
    GITHUB_ORG: env.GITHUB_ORG,
    LLM_API_KEY: env.LLM_API_KEY,
    LLM_BASE_URL: env.LLM_BASE_URL,
    LLM_MODEL_INCIDENT: env.LLM_MODEL_INCIDENT,
    ...(process.env['TELEGRAM_ESCALATION_CHAT_ID']
      ? {
          TELEGRAM_ESCALATION_CHAT_ID:
            process.env['TELEGRAM_ESCALATION_CHAT_ID'],
        }
      : {}),
    ...(process.env['SENTRY_AUTH_TOKEN']
      ? { SENTRY_AUTH_TOKEN: process.env['SENTRY_AUTH_TOKEN'] }
      : {}),
    ...(process.env['SENTRY_ORG']
      ? { SENTRY_ORG: process.env['SENTRY_ORG'] }
      : {}),
    ...(process.env['SENTRY_PROJECT']
      ? { SENTRY_PROJECT: process.env['SENTRY_PROJECT'] }
      : {}),
  },
};
const { recovery } = registerIncidentHandlers({ ...incidentCtx, queue });

const app = createApp(ctx);

scheduler.announce();

const httpServer = app.listen(env.PORT, () => {
  log.info(
    {
      component: 'gateway',
      port: env.PORT,
      node_env: env.NODE_ENV,
      registered_jobs: queue.registeredTypes(),
    },
    'gateway listening',
  );
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ component: 'gateway', signal }, 'shutdown initiated');
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  scheduler.stop();
  recovery.stopAll('shutdown');
  await queue.drain();
  await telegram.stopPolling();
  db.close();
  log.info({ component: 'gateway' }, 'shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

export { ctx };
