import type { KnowledgeGraph, NodeOf } from '@axon/kg';
import type { Octokit } from '@octokit/rest';
import type { Logger } from 'pino';
import type { TelegramClient } from '@axon/shared';

export type FetcherResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface BriefEnv {
  GITHUB_TOKEN: string;
  GITHUB_ORG: string;
  GITHUB_REPO: string;
  LINEAR_API_KEY: string;
  LLM_API_KEY: string;
  LLM_BASE_URL: string;
  LLM_MODEL_ROUTINE: string;
  /**
   * Sentry API access is configured via process.env at fetch time. Phase 3
   * doesn't add these to the validated env schema — if absent, the fetcher
   * returns ok:false and the brief degrades gracefully.
   */
  SENTRY_AUTH_TOKEN?: string;
  SENTRY_ORG?: string;
  SENTRY_PROJECT?: string;
}

export interface BriefContext {
  kg: KnowledgeGraph;
  telegram: TelegramClient;
  log: Logger;
  env: BriefEnv;
  /** Test seam — replace the live Octokit with a mock. */
  octokit?: Octokit;
  /** Test seam — replace global fetch (Linear, Sentry). */
  fetch?: typeof fetch;
}

export interface PRSummary {
  number: number;
  title: string;
  url: string;
  author: string;
  state: 'open' | 'merged';
  files_changed: number;
  created_at: string;
  merged_at: string | null;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: 'Urgent' | 'High' | 'Medium' | 'Low' | 'NoPriority';
  labels: string[];
  state: string;
}

export interface ErrorSummary {
  fingerprint: string;
  title: string;
  count: number;
  service: string;
  level: string;
  last_seen: string;
}

export interface RecurringPattern {
  service_id: string;
  service_name: string;
  count_30d: number;
  most_recent_title: string;
  most_recent_days_ago: number;
}

export interface EngineerLoadEntry {
  id: string;
  name: string;
  github_handle: string;
  current_load: number;
  open_prs: number;
  recent_incidents: number;
  review_queue_size: number;
}

export interface KGSignals {
  recurringPatterns: RecurringPattern[];
  openADRs: NodeOf<'Decision'>[];
  engineerLoad: EngineerLoadEntry[];
  incidentTrend: { thisWeek: number; lastWeek: number; deltaPct: number };
}

export interface BriefSignals {
  prs: FetcherResult<PRSummary[]>;
  blockers: FetcherResult<LinearIssue[]>;
  errors: FetcherResult<ErrorSummary[]>;
  kg: FetcherResult<KGSignals>;
}
