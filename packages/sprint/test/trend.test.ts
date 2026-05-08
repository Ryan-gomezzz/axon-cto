import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, KnowledgeGraph, seed } from '@axon/kg';
import {
  getRiskTrend,
  persistRiskScore,
  weekOverWeekDelta,
} from '../src/trend.js';

describe('persistRiskScore', () => {
  let kg: KnowledgeGraph;
  beforeEach(() => {
    kg = new KnowledgeGraph(openDb(':memory:'));
    seed(kg);
  });

  it('writes the score onto the Sprint node and survives a re-read', () => {
    persistRiskScore('sprint-23', 42.5, kg);
    const after = kg.getNode('sprint-23', 'Sprint');
    expect(after?.payload.risk_score).toBe(42.5);
  });

  it('overwrites a prior score (latest write wins)', () => {
    persistRiskScore('sprint-23', 10, kg);
    persistRiskScore('sprint-23', 20, kg);
    expect(kg.getNode('sprint-23', 'Sprint')?.payload.risk_score).toBe(20);
  });

  it('rejects non-finite scores', () => {
    expect(() =>
      persistRiskScore('sprint-23', Number.NaN, kg),
    ).toThrow(/non-finite/);
    expect(() =>
      persistRiskScore('sprint-23', Number.POSITIVE_INFINITY, kg),
    ).toThrow(/non-finite/);
  });

  it('throws on unknown sprint id', () => {
    expect(() => persistRiskScore('sprint-doesnotexist', 50, kg)).toThrow(
      /not found/,
    );
  });
});

describe('getRiskTrend', () => {
  let kg: KnowledgeGraph;
  beforeEach(() => {
    kg = new KnowledgeGraph(openDb(':memory:'));
    seed(kg);
  });

  it('returns only sprints with a recorded risk_score, ordered oldest first', () => {
    // Seed sets sprint-22 to risk_score 18; sprint-23 has none.
    let trend = getRiskTrend(kg);
    expect(trend).toHaveLength(1);
    expect(trend[0]?.sprint_id).toBe('sprint-22');
    expect(trend[0]?.score).toBe(18);

    persistRiskScore('sprint-23', 42, kg);
    trend = getRiskTrend(kg);
    expect(trend.map((t) => t.sprint_id)).toEqual(['sprint-22', 'sprint-23']);
    expect(trend.map((t) => t.score)).toEqual([18, 42]);
  });
});

describe('weekOverWeekDelta', () => {
  it('reports delta against the most recent prior sprint', () => {
    const trend = [
      {
        sprint_id: 'sprint-22',
        sprint_number: 22,
        score: 18,
        recorded_at: 1_000_000,
      },
    ];
    const wow = weekOverWeekDelta(trend, 'sprint-23', 42);
    expect(wow.previous_score).toBe(18);
    expect(wow.delta_points).toBe(24);
    expect(wow.current_score).toBe(42);
  });

  it('returns null delta when there is no prior data', () => {
    const wow = weekOverWeekDelta([], 'sprint-23', 42);
    expect(wow.previous_score).toBeNull();
    expect(wow.delta_points).toBeNull();
  });
});
