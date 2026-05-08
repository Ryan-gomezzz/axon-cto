import { TelegramClient, newTraceId } from '@axon/shared';
import { env } from '@axon/shared/env';
import { logger } from '@axon/shared/logger';
import { openDb, KnowledgeGraph } from '@axon/kg';
import { sprintRiskBrief } from '../brief.js';
import type { SprintContext } from '../types.js';

const db = openDb(env.KG_DB_PATH);
const kg = new KnowledgeGraph(db);
const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);

const ctx: SprintContext = {
  kg,
  telegram,
  log: logger.child({ component: 'sprint-cli' }),
  env: {
    LLM_API_KEY: env.LLM_API_KEY,
    LLM_BASE_URL: env.LLM_BASE_URL,
    LLM_MODEL_ROUTINE: env.LLM_MODEL_ROUTINE,
  },
};

await sprintRiskBrief(ctx, newTraceId());
db.close();
process.exit(0);
