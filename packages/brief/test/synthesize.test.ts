import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { buildUserMessage, synthesizeBrief, SYSTEM_PROMPT } from '../src/synthesize.js';
import type { BriefSignals } from '../src/types.js';
import type OpenAI from 'openai';

const FROZEN_NOW = 1_770_000_000_000; // 2026-02-01ish — anchors age-based output.

const SAMPLE_SIGNALS: BriefSignals = {
  prs: {
    ok: true,
    data: [
      {
        number: 1201,
        title: 'auth: cap Redis pool at 50',
        url: 'https://x',
        author: 'aditi-sharma',
        state: 'merged',
        files_changed: 2,
        created_at: '2026-04-15T00:00:00Z',
        merged_at: '2026-04-16T00:00:00Z',
      },
      {
        number: 1217,
        title: 'auth: typed errors for OAuth flow',
        url: 'https://x',
        author: 'rohan',
        state: 'open',
        files_changed: 1,
        created_at: '2026-05-07T00:00:00Z',
        merged_at: null,
      },
    ],
  },
  blockers: {
    ok: true,
    data: [
      {
        id: 'lin-1',
        identifier: 'AUTH-12',
        title: 'Login throttled',
        url: 'https://linear.app/x/AUTH-12',
        priority: 'Urgent',
        labels: ['blocker'],
        state: 'In Progress',
      },
    ],
  },
  errors: { ok: false, error: 'Sentry API not configured' },
  kg: {
    ok: true,
    data: {
      recurringPatterns: [
        {
          service_id: 'service-auth',
          service_name: 'auth-service',
          count_30d: 3,
          most_recent_title: 'auth-service intermittent 500s on /token',
          most_recent_days_ago: 3,
        },
      ],
      openADRs: [
        {
          id: 'decision-1',
          type: 'Decision',
          created_at: FROZEN_NOW - 21 * 86_400_000,
          payload: {
            type: 'ADR',
            title: 'Bound Redis connection pools across services',
            status: 'open',
            created_at: FROZEN_NOW - 21 * 86_400_000,
          },
        },
      ],
      engineerLoad: [
        {
          id: 'engineer-aditi',
          name: 'Aditi Sharma',
          github_handle: 'aditi-sharma',
          current_load: 9,
          open_prs: 4,
          recent_incidents: 1,
          review_queue_size: 3,
        },
      ],
      incidentTrend: { thisWeek: 2, lastWeek: 4, deltaPct: -50 },
    },
  },
};

describe('buildUserMessage', () => {
  it('places <patterns> first and includes every section as XML', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    const xml = buildUserMessage(SAMPLE_SIGNALS);
    vi.useRealTimers();

    // KG sections must appear (and patterns must lead).
    const patternsIdx = xml.indexOf('<patterns>');
    const prsIdx = xml.indexOf('<prs');
    const blockersIdx = xml.indexOf('<blockers>');
    const errorsIdx = xml.indexOf('<errors>');
    expect(patternsIdx).toBe(0);
    expect(patternsIdx).toBeLessThan(prsIdx);
    expect(prsIdx).toBeLessThan(blockersIdx);
    expect(blockersIdx).toBeLessThan(errorsIdx);

    // Pattern content shows the canonical "3rd incident" signal.
    expect(xml).toContain('service="auth-service"');
    expect(xml).toContain('count_30d="3"');

    // Failed Sentry fetch is acknowledged inline.
    expect(xml).toContain('<errors><error>');
    expect(xml).toContain('Sentry API not configured');
  });

  it('matches snapshot for the canonical signals fixture', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    const xml = buildUserMessage(SAMPLE_SIGNALS);
    vi.useRealTimers();
    expect(xml).toMatchInlineSnapshot(`
      "<patterns>
        <pattern service="auth-service" count_30d="3" most_recent="auth-service intermittent 500s on /token" days_ago="3"/>
      </patterns>

      <open_adrs>
        <adr id="decision-1" title="Bound Redis connection pools across services" age_days="21"/>
      </open_adrs>

      <load>
        <engineer name="Aditi Sharma" handle="aditi-sharma" current_load="9" open_prs="4" recent_incidents="1" review_queue="3"/>
      </load>

      <trend incidents_this_week="2" incidents_last_week="4" delta_pct="-50"/>

      <prs merged_24h="1" open="1">
        <pr number="1201" state="merged" author="aditi-sharma" title="auth: cap Redis pool at 50"/>
        <pr number="1217" state="open" author="rohan" title="auth: typed errors for OAuth flow"/>
      </prs>

      <blockers>
        <issue id="AUTH-12" priority="Urgent" state="In Progress" title="Login throttled"/>
      </blockers>

      <errors><error>Sentry API not configured</error></errors>"
    `);
  });
});

describe('SYSTEM_PROMPT', () => {
  it('mandates KG-grounded bullets and 5-bullet shape', () => {
    expect(SYSTEM_PROMPT).toMatch(/5 bullets/);
    expect(SYSTEM_PROMPT).toMatch(/knowledge graph/i);
    expect(SYSTEM_PROMPT).toMatch(/never surface a raw number/i);
  });
});

describe('synthesizeBrief streaming', () => {
  it('concatenates streamed deltas into the returned string', async () => {
    async function* fakeStream() {
      yield {
        choices: [{ delta: { content: '* auth-service: 3rd incident this month\n' } }],
      };
      yield { choices: [{ delta: { content: '* 2 PRs open on critical paths' } }] };
      yield { choices: [{ delta: {} }] };
    }
    const create = vi.fn().mockResolvedValue(fakeStream());
    const fakeClient = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const text = await synthesizeBrief(
      SAMPLE_SIGNALS,
      {
        env: {
          GITHUB_TOKEN: 'gh',
          GITHUB_ORG: 'o',
          GITHUB_REPO: 'r',
          LINEAR_API_KEY: 'l',
          LLM_API_KEY: 'k',
          LLM_BASE_URL: 'https://api.together.xyz/v1',
          LLM_MODEL_ROUTINE: 'nvidia/Nemotron-Mini-4B-Instruct',
        },
        log: pino({ level: 'silent' }),
      },
      { client: fakeClient },
    );
    expect(text).toBe(
      '* auth-service: 3rd incident this month\n* 2 PRs open on critical paths',
    );
    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(args['model']).toBe('nvidia/Nemotron-Mini-4B-Instruct');
    expect(args['stream']).toBe(true);
  });
});
