import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import { openDb, KnowledgeGraph, seed } from '@axon/kg';
import { enrichIncident } from '../src/enrich.js';
import { sentryToIncident, parseAndValidateSentry } from '../src/ingest.js';
import type { IncidentJobContext } from '../src/types.js';

function silentLog() {
  return pino({ level: 'silent' });
}

function envFixture(): IncidentJobContext['env'] {
  return {
    GITHUB_TOKEN: 'tok',
    GITHUB_ORG: 'samsung-sri',
    LLM_API_KEY: 'k',
    LLM_BASE_URL: 'https://api.together.xyz/v1',
    LLM_MODEL_INCIDENT: 'nvidia/Llama-3.1-Nemotron-70B-Instruct-HF',
  };
}

function makeOctokit(commits: unknown[]) {
  return {
    repos: { listCommits: vi.fn().mockResolvedValue({ data: commits }) },
  } as unknown as IncidentJobContext['octokit'];
}

describe('enrichIncident', () => {
  let kg: KnowledgeGraph;
  beforeEach(() => {
    kg = new KnowledgeGraph(openDb(':memory:'));
    seed(kg);
  });

  it('returns the full IncidentContext shape against the seed within 2s', async () => {
    const incident = sentryToIncident(
      parseAndValidateSentry({
        event_id: 'evt-enrich-1',
        project: 'auth-service',
        level: 'fatal',
        title: 'Redis pool exhausted again',
      }),
      kg,
    );

    const ctx: IncidentJobContext = {
      kg,
      telegram: {} as never,
      log: silentLog(),
      env: envFixture(),
      octokit: makeOctokit([
        {
          sha: '7a3c1d9f0a4e1b2e3d4c5f60718293a4b5c6d7e8',
          html_url: 'https://github.com/samsung-sri/auth-service/commit/7a3c',
          author: { login: 'rajk' },
          commit: {
            message: 'auth: cap Redis pool at 50\n\nCloses #99',
            author: { name: 'Raj Kumar', date: new Date().toISOString() },
          },
        },
      ]),
    };

    const t0 = Date.now();
    const enriched = await enrichIncident(incident, ctx, 't-test');
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(2000);

    expect(enriched.incident.id).toBe(incident.id);
    expect(enriched.service.id).toBe('service-auth');
    expect(enriched.recurringPatterns.length).toBeGreaterThanOrEqual(3); // seed has 3 auth incidents in 30d
    expect(enriched.openADRs).toHaveLength(1); // seed has 1 open ADR (auth-related)
    expect(enriched.recentDeploys).toHaveLength(1);
    expect(enriched.recentDeploys[0]?.short_sha).toBe('7a3c1d9f');
    expect(enriched.recentDeploys[0]?.author_handle).toBe('rajk');
    expect(enriched.onCallEngineer?.github_handle).toBe('rajk');
    expect(enriched.onCallEngineer?.engineer_id).toBe('engineer-raj');
    expect(enriched.traceId).toBe('t-test');
  });

  it('runs the four enrichment lookups in parallel (Octokit awaited once)', async () => {
    const incident = sentryToIncident(
      parseAndValidateSentry({
        event_id: 'evt-enrich-parallel',
        project: 'auth-service',
        level: 'error',
        title: 'parallel test',
      }),
      kg,
    );
    const listCommits = vi.fn().mockResolvedValue({ data: [] });
    const ctx: IncidentJobContext = {
      kg,
      telegram: {} as never,
      log: silentLog(),
      env: envFixture(),
      octokit: {
        repos: { listCommits },
      } as unknown as IncidentJobContext['octokit'],
    };
    await enrichIncident(incident, ctx, 't');
    // KG queries are sync; the only async wait is one Octokit listCommits call.
    expect(listCommits).toHaveBeenCalledTimes(1);
  });

  it('degrades gracefully when Octokit fails (deploys empty, on-call missing)', async () => {
    const incident = sentryToIncident(
      parseAndValidateSentry({
        event_id: 'evt-enrich-fail',
        project: 'auth-service',
        level: 'error',
        title: 'octokit down',
      }),
      kg,
    );
    const ctx: IncidentJobContext = {
      kg,
      telegram: {} as never,
      log: silentLog(),
      env: envFixture(),
      octokit: {
        repos: {
          listCommits: vi
            .fn()
            .mockRejectedValue(new Error('GitHub 502 bad gateway')),
        },
      } as unknown as IncidentJobContext['octokit'],
    };
    const enriched = await enrichIncident(incident, ctx, 't');
    expect(enriched.recentDeploys).toEqual([]);
    expect(enriched.onCallEngineer).toBeUndefined();
    // KG-derived fields still present.
    expect(enriched.recurringPatterns.length).toBeGreaterThan(0);
    expect(enriched.openADRs).toHaveLength(1);
  });
});
