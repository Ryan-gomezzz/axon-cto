import { describe, it, expect } from 'vitest';
import { computeSprintRisk, RISK_COMPONENT_WEIGHTS } from '../src/score.js';
import type { SprintSignals } from '../src/types.js';

const ZERO_SIGNALS: SprintSignals = {
  blocker_weight: 0,
  velocity_ratio: 1,
  scope_creep_pct: 0,
  days_to_deadline_pressure: 0,
  systemic_block: 0,
};

function withOnly(field: keyof SprintSignals, value: number): SprintSignals {
  // Start from "perfect sprint" (zero risk) and turn one knob to max.
  return { ...ZERO_SIGNALS, [field]: value };
}

describe('computeSprintRisk', () => {
  it('returns 0 for a perfect sprint (no blockers, full velocity, no creep)', () => {
    const out = computeSprintRisk(ZERO_SIGNALS);
    expect(out.score).toBe(0);
    expect(Object.values(out.breakdown).every((v) => v === 0)).toBe(true);
  });

  it('returns 100 when every signal is at maximum risk', () => {
    const out = computeSprintRisk({
      blocker_weight: 1,
      velocity_ratio: 0,
      scope_creep_pct: 1,
      days_to_deadline_pressure: 1,
      systemic_block: 1,
    });
    expect(out.score).toBe(100);
    expect(out.breakdown).toEqual({
      blocker_weight: RISK_COMPONENT_WEIGHTS.blocker_weight,
      velocity_gap: RISK_COMPONENT_WEIGHTS.velocity_gap,
      scope_creep: RISK_COMPONENT_WEIGHTS.scope_creep,
      deadline_pressure: RISK_COMPONENT_WEIGHTS.deadline_pressure,
      systemic_block: RISK_COMPONENT_WEIGHTS.systemic_block,
    });
  });

  it.each([
    ['blocker_weight', 1, 'blocker_weight', 30],
    ['scope_creep_pct', 1, 'scope_creep', 20],
    ['days_to_deadline_pressure', 1, 'deadline_pressure', 15],
    ['systemic_block', 1, 'systemic_block', 10],
  ] as const)(
    'each component contributes its full weight when isolated (%s)',
    (field, value, key, expected) => {
      const out = computeSprintRisk(withOnly(field, value));
      expect(out.breakdown[key]).toBe(expected);
      expect(out.score).toBe(expected);
    },
  );

  it('velocity_ratio inverts: ratio=0 -> velocity_gap is 25 / score is 25', () => {
    const out = computeSprintRisk({ ...ZERO_SIGNALS, velocity_ratio: 0 });
    expect(out.breakdown['velocity_gap']).toBe(25);
    expect(out.score).toBe(25);
  });

  it('clamps individual signals above 1 to the max contribution', () => {
    const out = computeSprintRisk({
      blocker_weight: 5, // wildly out of range
      velocity_ratio: 0,
      scope_creep_pct: 999,
      days_to_deadline_pressure: 12,
      systemic_block: 7,
    });
    expect(out.score).toBe(100);
    expect(out.breakdown['blocker_weight']).toBe(30);
    expect(out.breakdown['velocity_gap']).toBe(25);
    expect(out.breakdown['scope_creep']).toBe(20);
    expect(out.breakdown['deadline_pressure']).toBe(15);
    expect(out.breakdown['systemic_block']).toBe(10);
  });

  it('clamps the total to [0, 100] even with adversarial inputs', () => {
    const out = computeSprintRisk({
      blocker_weight: -5,
      velocity_ratio: 1.5,
      scope_creep_pct: -2,
      days_to_deadline_pressure: -1,
      systemic_block: -10,
    });
    expect(out.score).toBeGreaterThanOrEqual(0);
    expect(out.score).toBeLessThanOrEqual(100);
  });

  it('treats NaN / Infinity inputs as 0 rather than poisoning the score', () => {
    const out = computeSprintRisk({
      blocker_weight: Number.NaN,
      velocity_ratio: Number.POSITIVE_INFINITY,
      scope_creep_pct: Number.NaN,
      days_to_deadline_pressure: Number.NaN,
      systemic_block: Number.NaN,
    });
    expect(Number.isFinite(out.score)).toBe(true);
    expect(out.score).toBeGreaterThanOrEqual(0);
    expect(out.score).toBeLessThanOrEqual(100);
  });

  it('all-mid signals produce a partial score with all components positive', () => {
    const out = computeSprintRisk({
      blocker_weight: 0.5,
      velocity_ratio: 0.5,
      scope_creep_pct: 0.5,
      days_to_deadline_pressure: 0.5,
      systemic_block: 0.5,
    });
    // 0.5 * 30 + 0.5 * 25 + 0.5 * 20 + 0.5 * 15 + 0.5 * 10 = 50
    expect(out.score).toBeCloseTo(50, 5);
    for (const v of Object.values(out.breakdown)) {
      expect(v).toBeGreaterThan(0);
    }
  });
});
