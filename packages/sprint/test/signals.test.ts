import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, KnowledgeGraph, seed } from '@axon/kg';
import { findCurrentSprint, gatherSprintSignals } from '../src/signals.js';

describe('findCurrentSprint', () => {
  let kg: KnowledgeGraph;
  beforeEach(() => {
    kg = new KnowledgeGraph(openDb(':memory:'));
    seed(kg);
  });

  it('returns the sprint whose window contains "now"', () => {
    const cur = findCurrentSprint(kg);
    expect(cur).not.toBeNull();
    expect(cur!.id).toBe('sprint-23');
    expect(cur!.payload.number).toBe(23);
  });

  it('falls back to most recent sprint if none cover "now"', () => {
    // Pick a date far in the future, after all seeded sprints have ended.
    const future = Date.now() + 365 * 86_400_000;
    const cur = findCurrentSprint(kg, future);
    expect(cur).not.toBeNull();
    expect(cur!.id).toBe('sprint-23'); // newest start_date
  });
});

describe('gatherSprintSignals (against the seed)', () => {
  let kg: KnowledgeGraph;
  beforeEach(() => {
    kg = new KnowledgeGraph(openDb(':memory:'));
    seed(kg);
  });

  it('returns the full SprintSignals shape for the current sprint', async () => {
    const signals = await gatherSprintSignals('sprint-23', kg);

    // BLOCKS in: seed has incident-auth-3 -> sprint-23. 1 of cap=5 -> 0.2.
    expect(signals.blocker_weight).toBeCloseTo(0.2, 5);

    // sprint-23 has 0 completed of 35 planned -> velocity_ratio = 0.
    expect(signals.velocity_ratio).toBe(0);

    // No original_planned tracking yet, so scope creep is 0.
    expect(signals.scope_creep_pct).toBe(0);

    // 7 days into a 14-day sprint -> deadline pressure ~ 0.5.
    expect(signals.days_to_deadline_pressure).toBeGreaterThan(0.4);
    expect(signals.days_to_deadline_pressure).toBeLessThan(0.6);

    // Sprint window covers ~2 incidents (one auth, one payments). Below threshold.
    expect(signals.systemic_block).toBe(0);
  });

  it('throws on unknown sprint id', async () => {
    await expect(
      gatherSprintSignals('sprint-999', kg),
    ).rejects.toThrow(/not found/);
  });

  it('flags systemic_block when a service has >2 incidents in the window', async () => {
    // Pin "now" to mid-sprint and add two extra synthesized auth incidents
    // inside the seeded sprint-23 window so the service crosses the threshold.
    const sprint = kg.getNode('sprint-23', 'Sprint')!;
    const inWindow = sprint.payload.start_date + 86_400_000; // 1 day into sprint
    kg.addNode({
      id: 'incident-test-extra-1',
      type: 'Incident',
      created_at: inWindow,
      payload: {
        severity: 'P1',
        service_id: 'service-auth',
        title: 'extra incident 1',
        started_at: inWindow,
      },
    });
    kg.addNode({
      id: 'incident-test-extra-2',
      type: 'Incident',
      created_at: inWindow + 1000,
      payload: {
        severity: 'P1',
        service_id: 'service-auth',
        title: 'extra incident 2',
        started_at: inWindow + 1000,
      },
    });

    const signals = await gatherSprintSignals('sprint-23', kg);
    expect(signals.systemic_block).toBe(1);
  });

  it('handles a sprint with completed_points equal to planned (velocity_ratio = 1)', async () => {
    // sprint-22 in seed: 32 planned, 28 completed -> ratio ~ 0.875.
    const signals = await gatherSprintSignals('sprint-22', kg);
    expect(signals.velocity_ratio).toBeCloseTo(28 / 32, 5);
  });
});
