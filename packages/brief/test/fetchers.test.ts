import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import { openDb, KnowledgeGraph, seed } from '@axon/kg';
import {
  fetchOpenPRs,
  fetchLinearBlockers,
  fetchSentryErrors,
  fetchKGSignals,
} from '../src/fetchers.js';
import type { BriefContext } from '../src/types.js';

const DAY_MS = 86_400_000;

function silentLogger() {
  return pino({ level: 'silent' });
}

function baseEnv(): BriefContext['env'] {
  return {
    GITHUB_TOKEN: 'gh-token',
    GITHUB_ORG: 'samsung-sri',
    GITHUB_REPO: 'auth-service',
    LINEAR_API_KEY: 'lin-key',
    LLM_API_KEY: 'llm-key',
    LLM_BASE_URL: 'https://api.together.xyz/v1',
    LLM_MODEL_ROUTINE: 'nvidia/Nemotron-Mini-4B-Instruct',
  };
}

function makeOctokit(openCall: unknown[], closedCall: unknown[]) {
  return {
    paginate: vi
      .fn()
      .mockResolvedValueOnce(openCall)
      .mockResolvedValueOnce(closedCall),
    pulls: { list: { __ref: 'pulls.list' } },
  } as unknown as BriefContext['octokit'];
}

describe('fetchOpenPRs', () => {
  it('returns currently open + last-24h merged, deduped', async () => {
    const now = Date.now();
    const open = [
      {
        number: 1,
        title: 'open one',
        html_url: 'https://x',
        user: { login: 'aditi' },
        merged_at: null,
        created_at: new Date(now - 3 * DAY_MS).toISOString(),
      },
    ];
    const closed = [
      {
        number: 2,
        title: 'merged 6h ago',
        html_url: 'https://x',
        user: { login: 'raj' },
        merged_at: new Date(now - 6 * 3600_000).toISOString(),
        created_at: new Date(now - 4 * DAY_MS).toISOString(),
      },
      {
        number: 3,
        title: 'merged 3 days ago',
        html_url: 'https://x',
        user: { login: 'priya' },
        merged_at: new Date(now - 3 * DAY_MS).toISOString(),
        created_at: new Date(now - 5 * DAY_MS).toISOString(),
      },
      {
        number: 4,
        title: 'closed never merged',
        html_url: 'https://x',
        user: { login: 'kavya' },
        merged_at: null,
        created_at: new Date(now - 2 * DAY_MS).toISOString(),
      },
    ];
    const ctx: BriefContext = {
      kg: new KnowledgeGraph(openDb(':memory:')),
      telegram: {} as never,
      log: silentLogger(),
      env: baseEnv(),
      octokit: makeOctokit(open, closed),
    };
    const result = await fetchOpenPRs(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((p) => p.number).sort()).toEqual([1, 2]);
    expect(result.data.find((p) => p.number === 2)?.state).toBe('merged');
    expect(result.data.find((p) => p.number === 1)?.state).toBe('open');
  });

  it('returns ok:false on Octokit failure', async () => {
    const ctx: BriefContext = {
      kg: new KnowledgeGraph(openDb(':memory:')),
      telegram: {} as never,
      log: silentLogger(),
      env: baseEnv(),
      octokit: {
        paginate: vi.fn().mockRejectedValue(new Error('boom')),
        pulls: { list: {} },
      } as unknown as BriefContext['octokit'],
    };
    const result = await fetchOpenPRs(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('boom');
  });
});

describe('fetchLinearBlockers', () => {
  it('parses urgent + blocker-labeled issues from Linear GraphQL', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          issues: {
            nodes: [
              {
                id: 'iss-1',
                identifier: 'AUTH-12',
                title: 'Login throttled',
                url: 'https://linear.app/x/AUTH-12',
                priority: 1,
                labels: { nodes: [{ name: 'blocker' }] },
                state: { name: 'In Progress' },
              },
            ],
          },
        },
      }),
    });
    const ctx: BriefContext = {
      kg: new KnowledgeGraph(openDb(':memory:')),
      telegram: {} as never,
      log: silentLogger(),
      env: baseEnv(),
      fetch: fakeFetch as unknown as typeof fetch,
    };
    const result = await fetchLinearBlockers(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.priority).toBe('Urgent');
    expect(result.data[0]?.labels).toEqual(['blocker']);

    const callArgs = fakeFetch.mock.calls[0]!;
    expect(callArgs[0]).toBe('https://api.linear.app/graphql');
    const init = callArgs[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      query: expect.stringContaining('issues('),
    });
    expect((init.headers as Record<string, string>)['authorization']).toBe(
      'lin-key',
    );
  });

  it('returns ok:false when Linear returns GraphQL errors', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: 'rate limited' }] }),
    });
    const ctx: BriefContext = {
      kg: new KnowledgeGraph(openDb(':memory:')),
      telegram: {} as never,
      log: silentLogger(),
      env: baseEnv(),
      fetch: fakeFetch as unknown as typeof fetch,
    };
    const result = await fetchLinearBlockers(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('rate limited');
  });
});

describe('fetchSentryErrors', () => {
  it('returns ok:false with a clear message when not configured', async () => {
    const ctx: BriefContext = {
      kg: new KnowledgeGraph(openDb(':memory:')),
      telegram: {} as never,
      log: silentLogger(),
      env: baseEnv(),
    };
    const result = await fetchSentryErrors(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not configured/);
  });

  it('filters Sentry results by error count threshold', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: '1',
          shortId: 'AUTH-1',
          title: 'Redis pool exhausted',
          count: '42',
          level: 'error',
          lastSeen: new Date().toISOString(),
          project: { slug: 'auth-service' },
        },
        {
          id: '2',
          shortId: 'AUTH-2',
          title: 'Quiet error',
          count: '2',
          level: 'error',
          lastSeen: new Date().toISOString(),
          project: { slug: 'auth-service' },
        },
      ],
    });
    const ctx: BriefContext = {
      kg: new KnowledgeGraph(openDb(':memory:')),
      telegram: {} as never,
      log: silentLogger(),
      env: {
        ...baseEnv(),
        SENTRY_AUTH_TOKEN: 'sntry-tok',
        SENTRY_ORG: 'samsung',
        SENTRY_PROJECT: 'auth',
      },
      fetch: fakeFetch as unknown as typeof fetch,
    };
    const result = await fetchSentryErrors(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.fingerprint).toBe('AUTH-1');
  });
});

describe('fetchKGSignals', () => {
  let kg: KnowledgeGraph;
  beforeEach(() => {
    kg = new KnowledgeGraph(openDb(':memory:'));
    seed(kg);
  });

  it('returns top recurring patterns, open ADRs, and engineer load', async () => {
    const ctx: BriefContext = {
      kg,
      telegram: {} as never,
      log: silentLogger(),
      env: baseEnv(),
    };
    const result = await fetchKGSignals(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sig = result.data;

    // auth-service has 3 incidents in 30d (per seed), so it must be a recurring
    // pattern at the top of the list.
    expect(sig.recurringPatterns.length).toBeGreaterThanOrEqual(1);
    expect(sig.recurringPatterns[0]?.service_name).toBe('auth-service');
    expect(sig.recurringPatterns[0]?.count_30d).toBe(3);

    // Seed has exactly 1 open ADR.
    expect(sig.openADRs).toHaveLength(1);
    expect(sig.openADRs[0]?.payload.status).toBe('open');

    // Top-3 engineers by load — Aditi (load=9) is the highest.
    expect(sig.engineerLoad).toHaveLength(3);
    expect(sig.engineerLoad[0]?.name).toBe('Aditi Sharma');

    // Trend is computed and is a number.
    expect(typeof sig.incidentTrend.thisWeek).toBe('number');
    expect(typeof sig.incidentTrend.lastWeek).toBe('number');
    expect(typeof sig.incidentTrend.deltaPct).toBe('number');
  });
});
