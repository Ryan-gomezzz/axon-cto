import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// env.ts lives at packages/shared/src/env.ts; three levels up is the repo root
// where .env / .env.example live.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
loadDotenv({ path: resolve(repoRoot, '.env') });

const EnvSchema = z.object({
  LLM_API_KEY: z.string().min(1, 'LLM_API_KEY is required'),
  LLM_BASE_URL: z.string().url().default('https://api.together.xyz/v1'),
  LLM_MODEL_INCIDENT: z
    .string()
    .min(1)
    .default('nvidia/Llama-3.1-Nemotron-70B-Instruct-HF'),
  LLM_MODEL_ROUTINE: z
    .string()
    .min(1)
    .default('nvidia/Nemotron-Mini-4B-Instruct'),
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_CHAT_ID: z.string().min(1, 'TELEGRAM_CHAT_ID is required'),
  GITHUB_TOKEN: z.string().min(1, 'GITHUB_TOKEN is required'),
  GITHUB_ORG: z.string().min(1, 'GITHUB_ORG is required'),
  GITHUB_REPO: z.string().min(1, 'GITHUB_REPO is required'),
  SENTRY_WEBHOOK_SECRET: z.string().min(1, 'SENTRY_WEBHOOK_SECRET is required'),
  GITHUB_WEBHOOK_SECRET: z
    .string()
    .min(1, 'GITHUB_WEBHOOK_SECRET is required'),
  LINEAR_API_KEY: z.string().min(1, 'LINEAR_API_KEY is required'),
  KG_DB_PATH: z.string().default('./data/axon.db'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n  ');
  throw new Error(`Invalid environment configuration:\n  ${issues}`);
}

export const env: Env = parsed.data;
