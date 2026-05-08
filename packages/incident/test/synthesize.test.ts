import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type OpenAI from 'openai';
import type { TelegramClient, MessageRef } from '@axon/shared';
import {
  buildIncidentUserMessage,
  synthesizeIncidentResponse,
  INCIDENT_SYSTEM_PROMPT,
} from '../src/synthesize.js';
import type { IncidentContext } from '../src/types.js';

const FROZEN_NOW = 1_770_000_000_000;

function fixtureCtx(opts: { withRecurring?: boolean } = {}): IncidentContext {
  const recurring = opts.withRecurring ?? true;
  return {
    incident: {
      id: 'incident-evt-abc',
      type: 'Incident',
      created_at: FROZEN_NOW,
      payload: {
        severity: 'P0',
        service_id: 'service-auth',
        title: 'auth-service Redis pool exhausted',
        started_at: FROZEN_NOW,
      },
    },
    service: {
      id: 'service-auth',
      type: 'Service',
      created_at: FROZEN_NOW - 90 * 86_400_000,
      payload: {
        name: 'auth-service',
        repo: 'samsung-sri/auth-service',
        owner_team: 'platform-identity',
        criticality: 'critical',
      },
    },
    recurringPatterns: recurring
      ? [
          {
            id: 'incident-auth-2',
            type: 'Incident',
            created_at: FROZEN_NOW - 13 * 86_400_000,
            payload: {
              severity: 'P0',
              service_id: 'service-auth',
              title: 'auth-service login latency spike',
              started_at: FROZEN_NOW - 13 * 86_400_000,
              root_cause: 'Same Redis pool exhaustion path',
            },
          },
          {
            id: 'incident-auth-1',
            type: 'Incident',
            created_at: FROZEN_NOW - 23 * 86_400_000,
            payload: {
              severity: 'P1',
              service_id: 'service-auth',
              title: 'auth-service Redis connection storm',
              started_at: FROZEN_NOW - 23 * 86_400_000,
              root_cause: 'Redis connection pool unbounded',
            },
          },
        ]
      : [],
    recentDeploys: [
      {
        sha: '7a3c1d9f0a4e1b2e3d4c5f60718293a4b5c6d7e8',
        short_sha: '7a3c1d9f',
        title: 'auth: bump zod, fix any-cast in middleware',
        author_handle: 'aditi-sharma',
        deployed_at: FROZEN_NOW - 23 * 60_000,
        url: 'https://github.com/x/y/commit/7a3c',
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
    onCallEngineer: {
      github_handle: 'aditi-sharma',
      source: 'most-recent-committer',
      engineer_id: 'engineer-aditi',
      name: 'Aditi Sharma',
    },
    traceId: 't-test',
  };
}

describe('buildIncidentUserMessage', () => {
  it('includes <recurring_patterns> when KG has prior incidents on the service', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    const xml = buildIncidentUserMessage(fixtureCtx({ withRecurring: true }));
    vi.useRealTimers();
    expect(xml).toContain('<recurring_patterns count="2">');
    expect(xml).toContain('id="incident-auth-1"');
    expect(xml).toContain('root_cause="Redis connection pool unbounded"');
  });

  it('emits an empty marker when there are no recurring patterns', () => {
    const xml = buildIncidentUserMessage(fixtureCtx({ withRecurring: false }));
    expect(xml).toContain('<recurring_patterns count="0"/>');
  });

  it('always emits sections in the spec order: incident, patterns, deploys, adrs, oncall', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    const xml = buildIncidentUserMessage(fixtureCtx());
    vi.useRealTimers();
    const order = [
      '<incident',
      '<recurring_patterns',
      '<recent_deploys',
      '<open_adrs',
      '<oncall',
    ].map((tag) => xml.indexOf(tag));
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(order[i - 1]!);
    }
  });
});

describe('INCIDENT_SYSTEM_PROMPT', () => {
  it('encodes the three principles + KG-grounding requirement', () => {
    expect(INCIDENT_SYSTEM_PROMPT).toMatch(/Proactive/);
    expect(INCIDENT_SYSTEM_PROMPT).toMatch(/Synthesized/);
    expect(INCIDENT_SYSTEM_PROMPT).toMatch(/Autonomous/);
    expect(INCIDENT_SYSTEM_PROMPT).toMatch(/recurring/i);
    expect(INCIDENT_SYSTEM_PROMPT).toMatch(/(deploy SHA|recurring-incident count)/);
  });
});

describe('synthesizeIncidentResponse streaming', () => {
  it('sends the first chunk to Telegram and resolves at first-token-sent', async () => {
    async function* fakeStream() {
      yield {
        choices: [
          {
            delta: {
              content:
                'auth-service P0 — Redis pool exhausted on /token.\n\n',
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              content:
                '* 3rd auth-service incident this month — pattern matches Redis connection exhaustion.',
            },
          },
        ],
      };
    }
    const create = vi.fn().mockResolvedValue(fakeStream());
    const fakeClient = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const sendRef: MessageRef = { messageId: 42, chatId: 'cid' };
    const send = vi.fn().mockResolvedValue(sendRef);
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      send,
      editMessage,
    } as unknown as TelegramClient;

    let bgDone = false;
    const result = await synthesizeIncidentResponse(fixtureCtx(), telegram, {
      log: pino({ level: 'silent' }),
      env: {
        GITHUB_TOKEN: 't',
        GITHUB_ORG: 'o',
        LLM_API_KEY: 'k',
        LLM_BASE_URL: 'https://x',
        LLM_MODEL_INCIDENT: 'm',
      },
      client: fakeClient,
      onBackgroundDone: () => {
        bgDone = true;
      },
    });

    // Telegram.send was invoked once on first chunk.
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.messageRef.messageId).toBe(42);

    // Wait for background work — the second chunk must trigger a final edit
    // with buttons attached.
    while (!bgDone) await new Promise((r) => setTimeout(r, 5));
    expect(editMessage).toHaveBeenCalled();
    const lastEditOpts = editMessage.mock.calls.at(-1)?.[2] as
      | { buttons?: unknown[] }
      | undefined;
    expect(lastEditOpts?.buttons).toBeDefined();

    // OpenAI was called with the incident-tier model and streaming on.
    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(args['model']).toBe('m');
    expect(args['stream']).toBe(true);
    const messages = args['messages'] as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.content).toContain('<recurring_patterns');
  });

  it('falls back to a single send when the stream yields no content', async () => {
    async function* emptyStream() {
      // immediately done
    }
    const create = vi.fn().mockResolvedValue(emptyStream());
    const fakeClient = { chat: { completions: { create } } } as unknown as OpenAI;
    const send = vi
      .fn()
      .mockResolvedValue({ messageId: 7, chatId: 'cid' });
    const telegram = {
      send,
      editMessage: vi.fn(),
    } as unknown as TelegramClient;

    const out = await synthesizeIncidentResponse(fixtureCtx(), telegram, {
      log: pino({ level: 'silent' }),
      env: {
        GITHUB_TOKEN: 't',
        GITHUB_ORG: 'o',
        LLM_API_KEY: 'k',
        LLM_BASE_URL: 'https://x',
        LLM_MODEL_INCIDENT: 'm',
      },
      client: fakeClient,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(out.messageRef.messageId).toBe(7);
  });
});
