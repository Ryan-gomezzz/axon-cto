import { describe, it, expect, beforeAll } from 'vitest';
import { performance } from 'node:perf_hooks';
import { openDb } from '../src/db.js';
import { KnowledgeGraph } from '../src/graph.js';
import { seed } from '../src/seed.js';

const RUNS = 100;
const P95_BUDGET_MS = 50;

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  // 95th percentile of 100 samples = 95th index (0-based 94).
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  const v = sorted[idx];
  if (v === undefined) {
    throw new Error('p95: empty sample set');
  }
  return v;
}

describe('KG named queries — perf budget (<50ms p95 over 100 runs)', () => {
  let kg: KnowledgeGraph;
  let incidentId: string;
  let engineerId: string;
  let deployId: string;

  beforeAll(() => {
    kg = new KnowledgeGraph(openDb(':memory:'));
    seed(kg);
    incidentId = 'incident-auth-1';
    engineerId = 'engineer-aditi';
    deployId = 'deploy-1';
  });

  function bench(label: string, fn: () => unknown): number {
    // Warmup so prepared-statement caches/JIT aren't on the critical path.
    for (let i = 0; i < 5; i++) fn();
    const samples: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      fn();
      samples.push(performance.now() - t0);
    }
    const v = p95(samples);
    // eslint-disable-next-line no-console
    console.log(
      `[perf] ${label}: p95=${v.toFixed(2)}ms (mean=${(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2)}ms)`,
    );
    return v;
  }

  it('findRecurringIncidents', () => {
    const v = bench('findRecurringIncidents', () =>
      kg.findRecurringIncidents('service-auth', 30),
    );
    expect(v).toBeLessThan(P95_BUDGET_MS);
  });

  it('getCausalChain', () => {
    const v = bench('getCausalChain', () => kg.getCausalChain(incidentId));
    expect(v).toBeLessThan(P95_BUDGET_MS);
  });

  it('getEngineerLoad', () => {
    const v = bench('getEngineerLoad', () => kg.getEngineerLoad(engineerId));
    expect(v).toBeLessThan(P95_BUDGET_MS);
  });

  it('getOpenADRs (no filter)', () => {
    const v = bench('getOpenADRs', () => kg.getOpenADRs());
    expect(v).toBeLessThan(P95_BUDGET_MS);
  });

  it('getOpenADRs (service filter)', () => {
    const v = bench('getOpenADRs(service-auth)', () =>
      kg.getOpenADRs('service-auth'),
    );
    expect(v).toBeLessThan(P95_BUDGET_MS);
  });

  it('getDeployImpact', () => {
    const v = bench('getDeployImpact', () => kg.getDeployImpact(deployId));
    expect(v).toBeLessThan(P95_BUDGET_MS);
  });
});
