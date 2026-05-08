import type { Octokit } from '@octokit/rest';
import type { Logger } from 'pino';
import type { KnowledgeGraph, NodeOf } from '@axon/kg';
import type { TelegramClient } from '@axon/shared';

export interface PRPackageEnv {
  GITHUB_TOKEN: string;
  GITHUB_ORG: string;
  GITHUB_REPO: string;
  LLM_API_KEY: string;
  LLM_BASE_URL: string;
  LLM_MODEL_ROUTINE: string;
}

export interface PRContext {
  kg: KnowledgeGraph;
  telegram: TelegramClient;
  log: Logger;
  env: PRPackageEnv;
  /** Test seam — replace the live Octokit. */
  octokit?: Octokit;
  /** Test seam — replace the OpenAI client used by the digest. */
  openaiClient?: import('openai').default;
}

export interface GitHubPRWebhook {
  action: string;
  number: number;
  pull_request: {
    number: number;
    title: string;
    html_url: string;
    state: 'open' | 'closed';
    user: { login: string } | null;
    requested_reviewers?: Array<{ login: string }>;
    base?: { ref: string };
    head?: { sha: string; ref: string };
    created_at: string;
    updated_at: string;
    merged_at: string | null;
  };
  repository: {
    name: string;
    full_name: string;
    owner: { login: string };
  };
}

export interface GatewayWebhookEnvelope {
  event?: string;
  body: GitHubPRWebhook;
}

export interface PullRequestRow {
  number: number;
  title: string;
  url: string;
  author_handle: string;
  author_engineer_id?: string;
  state: 'open' | 'merged';
  created_at: string;
  updated_at: string;
  requested_reviewers: string[];
  files_changed?: string[];
}

export interface ReviewerBottleneck {
  handle: string;
  pending_reviews: number;
  /** When the reviewer matches a KG Engineer, their full load metrics. */
  engineer?: {
    id: string;
    name: string;
    open_prs: number;
    recent_incidents: number;
    review_queue_size: number;
  };
}

export interface DigestSnapshot {
  generated_at: number;
  open_prs_total: number;
  critical_open_prs: PullRequestRow[];
  bottlenecks: ReviewerBottleneck[];
  stale_prs: PullRequestRow[];
  bottleneck_threshold: number;
  stale_threshold_days: number;
}

export type ResolvedEngineer = NodeOf<'Engineer'>;
