import { z } from 'zod';
import type { Octokit } from '@octokit/rest';
import type { Logger } from 'pino';
import type { KnowledgeGraph, NodeOf } from '@axon/kg';
import type { TelegramClient } from '@axon/shared';

/**
 * Sentry sends two common shapes: flat top-level fields, or wrapped under
 * { data: { event: ... } }. The schema below accepts the normalised projection.
 */
export const SentryWebhookSchema = z.object({
  event_id: z.string().min(1),
  project: z.string().min(1),
  level: z.string().min(1).default('error'),
  title: z.string().min(1),
  environment: z.string().optional(),
  fingerprint: z.union([z.string(), z.array(z.string())]).optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
});
export type SentryWebhookPayload = z.infer<typeof SentryWebhookSchema>;

export interface RecentDeploy {
  sha: string;
  short_sha: string;
  title: string;
  author_handle: string;
  deployed_at: number; // ms epoch
  url: string;
}

export interface OnCallEngineer {
  github_handle: string;
  source: 'most-recent-committer' | 'static-config';
  /** Resolved KG Engineer node, when the handle matches one we know about. */
  engineer_id?: string;
  name?: string;
}

export interface IncidentContext {
  incident: NodeOf<'Incident'>;
  service: NodeOf<'Service'>;
  recurringPatterns: NodeOf<'Incident'>[];
  recentDeploys: RecentDeploy[];
  openADRs: NodeOf<'Decision'>[];
  onCallEngineer?: OnCallEngineer;
  traceId: string;
}

export interface IncidentEnv {
  GITHUB_TOKEN: string;
  GITHUB_ORG: string;
  LLM_API_KEY: string;
  LLM_BASE_URL: string;
  LLM_MODEL_INCIDENT: string;
  TELEGRAM_ESCALATION_CHAT_ID?: string;
  /** Optional Sentry API config used by the recovery monitor. */
  SENTRY_AUTH_TOKEN?: string;
  SENTRY_ORG?: string;
  SENTRY_PROJECT?: string;
}

export interface IncidentJobContext {
  kg: KnowledgeGraph;
  telegram: TelegramClient;
  log: Logger;
  env: IncidentEnv;
  /** Test seam — replace the live Octokit. */
  octokit?: Octokit;
  /** Test seam — replace global fetch (Sentry recovery polling). */
  fetch?: typeof fetch;
  /** Test seam — replace OpenAI client construction (incident-tier model). */
  openaiClient?: import('openai').default;
  /** Test seam — clock for stage-timing logs. */
  now?: () => number;
}
