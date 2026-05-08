import { TelegramClient, newTraceId } from '@axon/shared';
import { env } from '@axon/shared/env';
import { logger } from '@axon/shared/logger';
import { openDb, KnowledgeGraph } from '@axon/kg';
import { prDigestJob } from '../digest.js';
import type { PRContext } from '../types.js';

const db = openDb(env.KG_DB_PATH);
const kg = new KnowledgeGraph(db);
const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);

const ctx: PRContext = {
  kg,
  telegram,
  log: logger.child({ component: 'pr-digest-cli' }),
  env: {
    GITHUB_TOKEN: env.GITHUB_TOKEN,
    GITHUB_ORG: env.GITHUB_ORG,
    GITHUB_REPO: env.GITHUB_REPO,
    LLM_API_KEY: env.LLM_API_KEY,
    LLM_BASE_URL: env.LLM_BASE_URL,
    LLM_MODEL_ROUTINE: env.LLM_MODEL_ROUTINE,
  },
};

await prDigestJob(ctx, newTraceId());
db.close();
process.exit(0);
