import type { Logger } from 'pino';
import type { KnowledgeGraph } from '@axon/kg';
import type { TelegramClient } from '@axon/shared';

export interface SprintEnv {
  LLM_API_KEY: string;
  LLM_BASE_URL: string;
  LLM_MODEL_ROUTINE: string;
}

export interface SprintContext {
  kg: KnowledgeGraph;
  telegram: TelegramClient;
  log: Logger;
  env: SprintEnv;
  /** Test seam — replace the OpenAI client used by the brief. */
  openaiClient?: import('openai').default;
  /** Test seam — replaces Date.now() everywhere in this package. */
  now?: () => number;
}

export interface SprintSignals {
  /** Normalised count of BLOCKS edges into the sprint, in [0,1]. */
  blocker_weight: number;
  /** completed_points / planned_points, capped at 1. */
  velocity_ratio: number;
  /** (current_planned - original_planned) / original_planned, in [0,1]. */
  scope_creep_pct: number;
  /** 1 - (days_remaining / total_sprint_days), clamped to [0,1]. */
  days_to_deadline_pressure: number;
  /** 1 if any service has >2 incidents in the sprint window, else 0. */
  systemic_block: number;
}

export interface RiskScore {
  score: number;
  breakdown: Record<string, number>;
}

export interface RiskTrendPoint {
  sprint_id: string;
  sprint_number: number;
  score: number;
  recorded_at: number;
}
