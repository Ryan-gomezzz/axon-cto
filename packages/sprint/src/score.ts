import type { RiskScore, SprintSignals } from './types.js';

const COMPONENT_WEIGHTS = {
  blocker_weight: 30,
  velocity_gap: 25,
  scope_creep: 20,
  deadline_pressure: 15,
  systemic_block: 10,
} as const;

function clamp01(n: number): number {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Risk-score formula per spec:
 *   blocker_weight * 30
 * + (1 - velocity_ratio) * 25
 * + scope_creep_pct * 20
 * + days_to_deadline_pressure * 15
 * + systemic_block * 10
 *
 * Each input is clamped to [0,1]; total is clamped to [0,100]. The breakdown
 * is returned unclamped-by-component (raw weighted contributions) so the
 * brief can show "what's driving this."
 */
export function computeSprintRisk(signals: SprintSignals): RiskScore {
  const components: Record<string, number> = {
    blocker_weight: clamp01(signals.blocker_weight) * COMPONENT_WEIGHTS.blocker_weight,
    velocity_gap:
      clamp01(1 - signals.velocity_ratio) * COMPONENT_WEIGHTS.velocity_gap,
    scope_creep:
      clamp01(signals.scope_creep_pct) * COMPONENT_WEIGHTS.scope_creep,
    deadline_pressure:
      clamp01(signals.days_to_deadline_pressure) *
      COMPONENT_WEIGHTS.deadline_pressure,
    systemic_block:
      clamp01(signals.systemic_block) * COMPONENT_WEIGHTS.systemic_block,
  };
  const total = Object.values(components).reduce((a, b) => a + b, 0);
  return {
    score: Math.max(0, Math.min(100, total)),
    breakdown: components,
  };
}

export const RISK_COMPONENT_WEIGHTS = COMPONENT_WEIGHTS;
