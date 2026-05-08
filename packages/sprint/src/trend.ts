import type { KnowledgeGraph, NodeOf } from '@axon/kg';
import type { RiskTrendPoint } from './types.js';

/** Persist the latest risk score onto the Sprint node's `risk_score` field. */
export function persistRiskScore(
  sprintId: string,
  score: number,
  kg: KnowledgeGraph,
): void {
  if (!Number.isFinite(score)) {
    throw new Error(`persistRiskScore: non-finite score ${score}`);
  }
  kg.updatePayload(sprintId, 'Sprint', { risk_score: score });
}

/**
 * Return every Sprint node that currently carries a `risk_score`, ordered
 * by start_date (oldest first). This is our "trend" signal — once the cron
 * has run for a few sprints, the array becomes plottable.
 */
export function getRiskTrend(kg: KnowledgeGraph): RiskTrendPoint[] {
  const sprints = kg
    .sampleNodesByType('Sprint', 200)
    .filter((s): s is NodeOf<'Sprint'> => s.type === 'Sprint');
  const points: RiskTrendPoint[] = [];
  for (const s of sprints) {
    if (s.payload.risk_score === undefined) continue;
    points.push({
      sprint_id: s.id,
      sprint_number: s.payload.number,
      score: s.payload.risk_score,
      recorded_at: s.payload.start_date,
    });
  }
  return points.sort((a, b) => a.recorded_at - b.recorded_at);
}

export interface WeekOverWeekDelta {
  current_score: number | null;
  previous_score: number | null;
  delta_points: number | null;
}

/**
 * Convenience: given the trend array and a current score, compute the
 * week-over-week delta against the most recent prior sprint that has a
 * recorded score.
 */
export function weekOverWeekDelta(
  trend: RiskTrendPoint[],
  currentSprintId: string,
  currentScore: number,
): WeekOverWeekDelta {
  const others = trend.filter((p) => p.sprint_id !== currentSprintId);
  if (others.length === 0) {
    return {
      current_score: currentScore,
      previous_score: null,
      delta_points: null,
    };
  }
  const previous = others.reduce<RiskTrendPoint>((best, p) =>
    p.recorded_at > best.recorded_at ? p : best,
  others[0]!);
  return {
    current_score: currentScore,
    previous_score: previous.score,
    delta_points: Math.round((currentScore - previous.score) * 10) / 10,
  };
}
