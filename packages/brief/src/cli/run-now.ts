import { TelegramClient, newTraceId } from '@axon/shared';
import { env } from '@axon/shared/env';
import { logger } from '@axon/shared/logger';
import { openDb, KnowledgeGraph } from '@axon/kg';
import { morningBriefJob } from '../handler.js';
import type { BriefContext } from '../types.js';

const db = openDb(env.KG_DB_PATH);
const kg = new KnowledgeGraph(db);
const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);

const ctx: BriefContext = {
  kg,
  telegram,
  log: logger.child({ component: 'brief-cli' }),
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

const traceId = newTraceId();
await morningBriefJob(ctx, traceId);
db.close();
process.exit(0);
