import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type OpenAI from 'openai';
import { openDb, KnowledgeGraph, seed } from '@axon/kg';
import {
  buildDigestUserMessage,
  computeDigestSnapshot,
  formatDigestForTelegram,
  synthesizeDigest,
} from '../src/digest.js';
import type { DigestSnapshot, PRContext } from '../src/types.js';

function silentLog() {
  return pino({ level: 'silent' });
}

function envFixture(): PRContext['env'] {
  return {
    GITHUB_TOKEN: 'gh',
    GITHUB_ORG: 'samsung-sri',
    GITHUB_REPO: 'auth-service',
    LLM_API_KEY: 'k',
    LLM_BASE_URL: 'https://x',
    LLM_MODEL_ROUTINE: 'nvidia/Nemotron-Mini-4B-Instruct',
  };
}

const NOW = 1_770_000_000_000; // anchor — week is "this week" relative.
const TWELVE_DAYS_AGO = new Date(NOW - 12 * 86_400_000).toISOString();
const ONE_DAY_AGO = new Date(NOW - 1 * 86_400_000).toISOString();

const MOCK_OPEN_PRS = [
  {
    number: 1001,
    title: 'auth: revoke refresh tokens on password change',
    html_url: 'https://x/1001',
    user: { login: 'aditi-sharma' },
    requested_reviewers: [
      { login: 'rajk' },
      { login: 'priya-i' },
      { login: 'vreddy' },
    ],
    state: 'open',
    created_at: ONE_DAY_AGO,
    updated_at: ONE_DAY_AGO,
    merged_at: null,
  },
  {
    number: 1002,
    title: 'docs: tweak README',
    html_url: 'https://x/1002',
    user: { login: 'arjun-n' },
    requested_reviewers: [{ login: 'rajk' }],
    state: 'open',
    created_at: TWELVE_DAYS_AGO,
    updated_at: TWELVE_DAYS_AGO,
    merged_at: null,
  },
  {
    number: 1003,
    title: 'payments: webhook signature hardening',
    html_url: 'https://x/1003',
    user: { login: 'vreddy' },
    requested_reviewers: [{ login: 'rajk' }, { login: 'aditi-sharma' }],
    state: 'open',
    created_at: ONE_DAY_AGO,
    updated_at: ONE_DAY_AGO,
    merged_at: null,
  },
];

function makeOctokitForDigest(prsByNumber: Record<number, string[]>) {
  const paginate = vi.fn().mockResolvedValue(MOCK_OPEN_PRS);
  const listFiles = vi
    .fn()
    .mockImplementation(async ({ pull_number }: { pull_number: number }) => ({
      data: (prsByNumber[pull_number] ?? []).map((filename) => ({ filename })),
    }));
  return {
    paginate,
    pulls: { list: { __ref: 'pulls.list' }, listFiles },
  } as unknown as PRContext['octokit'];
}

describe('computeDigestSnapshot', () => {
  let kg: KnowledgeGraph;
  beforeEach(() => {
    kg = new KnowledgeGraph(openDb(':memory:'));
    seed(kg);
  });

  it('computes critical_open, bottlenecks, stale, and total counts', async () => {
    const ctx: PRContext = {
      kg,
      telegram: {} as never,
      log: silentLog(),
      env: envFixture(),
      octokit: makeOctokitForDigest({
        1001: ['packages/auth/src/session.ts'],
        1002: ['docs/README.md'],
        1003: ['packages/payments/src/webhook.ts'],
      }),
    };

    const snap = await computeDigestSnapshot(ctx, {
      bottleneckThreshold: 1,
      now: NOW,
    });

    expect(snap.open_prs_total).toBe(3);
    expect(snap.critical_open_prs.map((p) => p.number).sort()).toEqual([
      1001, 1003,
    ]);
    expect(snap.stale_prs.map((p) => p.number)).toEqual([1002]);

    // Reviewer rajk has 3 pending reviews; threshold is 1, so they bottleneck.
    const raj = snap.bottlenecks.find((b) => b.handle === 'rajk');
    expect(raj?.pending_reviews).toBe(3);
    expect(raj?.engineer?.id).toBe('engineer-raj');
    expect(typeof raj?.engineer?.open_prs).toBe('number');
    expect(typeof raj?.engineer?.recent_incidents).toBe('number');
  });

  it('respects the configurable bottleneck threshold', async () => {
    const ctx: PRContext = {
      kg,
      telegram: {} as never,
      log: silentLog(),
      env: envFixture(),
      octokit: makeOctokitForDigest({
        1001: [],
        1002: [],
        1003: [],
      }),
    };
    const snap = await computeDigestSnapshot(ctx, {
      bottleneckThreshold: 5,
      now: NOW,
    });
    // No reviewer has > 5 pending; bottlenecks must be empty even though rajk has 3.
    expect(snap.bottlenecks).toHaveLength(0);
  });
});

describe('buildDigestUserMessage', () => {
  it('emits all 4 sections with section markers and proper count attributes', () => {
    const snap: DigestSnapshot = {
      generated_at: NOW,
      open_prs_total: 3,
      bottleneck_threshold: 5,
      stale_threshold_days: 7,
      critical_open_prs: [
        {
          number: 1001,
          title: 'auth: x',
          url: 'https://x',
          author_handle: 'aditi-sharma',
          state: 'open',
          created_at: ONE_DAY_AGO,
          updated_at: ONE_DAY_AGO,
          requested_reviewers: ['rajk'],
          files_changed: ['packages/auth/src/x.ts'],
        },
      ],
      bottlenecks: [
        {
          handle: 'rajk',
          pending_reviews: 6,
          engineer: {
            id: 'engineer-raj',
            name: 'Raj Kumar',
            open_prs: 4,
            recent_incidents: 1,
            review_queue_size: 3,
          },
        },
      ],
      stale_prs: [
        {
          number: 1002,
          title: 'docs',
          url: 'https://x',
          author_handle: 'arjun-n',
          state: 'open',
          created_at: TWELVE_DAYS_AGO,
          updated_at: TWELVE_DAYS_AGO,
          requested_reviewers: [],
        },
      ],
    };

    const xml = buildDigestUserMessage(snap);
    expect(xml).toContain('<summary open_prs_total="3"');
    expect(xml).toContain('<critical_open count="1">');
    expect(xml).toContain('<bottlenecks count="1">');
    expect(xml).toContain('open_prs="4" recent_incidents="1"');
    expect(xml).toContain('<stale count="1">');
    expect(xml).toContain('age_days="12"');
  });

  it('emits <none/> markers for empty sections rather than dropping them', () => {
    const empty: DigestSnapshot = {
      generated_at: NOW,
      open_prs_total: 0,
      bottleneck_threshold: 5,
      stale_threshold_days: 7,
      critical_open_prs: [],
      bottlenecks: [],
      stale_prs: [],
    };
    const xml = buildDigestUserMessage(empty);
    expect(xml).toContain('<critical_open><none/></critical_open>');
    expect(xml).toContain('<bottlenecks><none/></bottlenecks>');
    expect(xml).toContain('<stale><none/></stale>');
  });
});

describe('synthesizeDigest', () => {
  it('streams Nemotron-Mini and concatenates deltas', async () => {
    async function* fakeStream() {
      yield {
        choices: [
          {
            delta: { content: '## Open Critical PRs\n* (none)\n\n' },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              content:
                '## Reviewer Bottlenecks\n* rajk: 6 pending — also 1 incident this week.\n\n## Stale PRs (>7d)\n* (none)',
            },
          },
        ],
      };
    }
    const create = vi.fn().mockResolvedValue(fakeStream());
    const fakeClient = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const snap: DigestSnapshot = {
      generated_at: NOW,
      open_prs_total: 0,
      bottleneck_threshold: 5,
      stale_threshold_days: 7,
      critical_open_prs: [],
      bottlenecks: [],
      stale_prs: [],
    };
    const text = await synthesizeDigest(
      snap,
      { env: envFixture(), log: silentLog() },
      { client: fakeClient },
    );
    expect(text).toContain('## Open Critical PRs');
    expect(text).toContain('## Reviewer Bottlenecks');
    expect(text).toContain('## Stale PRs');

    const args = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(args['model']).toBe('nvidia/Nemotron-Mini-4B-Instruct');
    expect(args['stream']).toBe(true);
  });
});

describe('formatDigestForTelegram', () => {
  it('escapes the body and adds an italic IST footer with the trace id', () => {
    const out = formatDigestForTelegram(
      '## Section\n* item.',
      't-test',
      new Date(NOW),
    );
    // Body is MarkdownV2-escaped (e.g., '#' and '.' must be backslash-escaped).
    expect(out).toContain('\\#\\# Section');
    expect(out).toContain('\\* item\\.');
    expect(out).toMatch(/_PR digest · \d{2}:\d{2} IST · trace t\\?-test_/);
  });
});
