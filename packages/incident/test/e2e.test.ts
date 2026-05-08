import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { openDb, KnowledgeGraph, seed } from '@axon/kg';
import type { TelegramClient, MessageRef } from '@axon/shared';
import type { IncidentJobContext } from '../src/types.js';

vi.mock('openai', () => {
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
              '* 3rd auth-service incident this month — pattern matches Redis connection exhaustion.\n* Recommended: rollback deploy 7a3c1d9f, ack within 5m.',
          },
        },
      ],
    };
  }
  class FakeOpenAI {
    chat = {
      completions: {
        create: async () => fakeStream(),
      },
    };
  }
  return { default: FakeOpenAI };
});

const { incidentJob } = await import('../src/handler.js');
const { RecoveryRegistry } = await import('../src/recovery.js');

describe('incident pipeline e2e — first-token under 60s', () => {
  let kg: KnowledgeGraph;

  beforeEach(() => {
    kg = new KnowledgeGraph(openDb(':memory:'));
    seed(kg);
  });

  it('delivers the first Telegram message with virtual elapsed < 60_000ms', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_770_000_000_000);

    const sendRef: MessageRef = { messageId: 42, chatId: 'demo-chat' };
    let sendCalledAt: number | undefined;
    const send = vi.fn().mockImplementation(async () => {
      sendCalledAt = Date.now();
      return sendRef;
    });
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const telegram = {
      send,
      editMessage,
    } as unknown as TelegramClient;

    const ctx: IncidentJobContext = {
      kg,
      telegram,
      log: pino({ level: 'silent' }),
      env: {
        GITHUB_TOKEN: 'tok',
        GITHUB_ORG: 'samsung-sri',
        LLM_API_KEY: 'k',
        LLM_BASE_URL: 'https://x',
        LLM_MODEL_INCIDENT: 'm',
      },
      octokit: {
        repos: {
          listCommits: vi.fn().mockResolvedValue({
            data: [
              {
                sha: '7a3c1d9f0a4e1b2e3d4c5f60718293a4b5c6d7e8',
                html_url: 'https://x',
                author: { login: 'raj-kumar' },
                commit: {
                  message: 'auth: cap Redis pool',
                  author: {
                    name: 'Raj',
                    date: new Date(1_770_000_000_000).toISOString(),
                  },
                },
              },
            ],
          }),
        },
      } as unknown as IncidentJobContext['octokit'],
    };

    const recovery = new RecoveryRegistry();

    const t0 = Date.now();
    await incidentJob(
      {
        event_id: 'evt-e2e',
        project: 'auth-service',
        level: 'fatal',
        title: 'Redis pool exhausted on /token',
      },
      ctx,
      'trace-e2e',
      { recovery },
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(sendCalledAt).toBeDefined();
    expect((sendCalledAt as number) - t0).toBeLessThan(60_000);

    // Recovery monitor was started (visible in registry) and uses real timers.
    // Stop it to avoid leaking into other tests.
    expect(recovery.has('incident-evt-evt-e2e')).toBe(true);
    recovery.stopAll('test-cleanup');
    expect(recovery.size()).toBe(0);

    vi.useRealTimers();
  });
});

describe('RecoveryRegistry timer cleanup', () => {
  it('clears the polling timer on stop and leaves the registry empty', () => {
    const setTimer = vi.fn().mockReturnValue(101);
    const clearTimer = vi.fn();
    const log = pino({ level: 'silent' });
    const registry = new RecoveryRegistry();

    const fakeService = {
      id: 'service-x',
      type: 'Service',
      created_at: 0,
      payload: {
        name: 'service-x',
        repo: 'org/repo',
        owner_team: 't',
        criticality: 'standard' as const,
      },
    };

    const ctx = {
      kg: new KnowledgeGraph(openDb(':memory:')),
      telegram: {} as unknown as TelegramClient,
      log,
      env: {
        GITHUB_TOKEN: 't',
        GITHUB_ORG: 'o',
        LLM_API_KEY: 'k',
        LLM_BASE_URL: 'https://x',
        LLM_MODEL_INCIDENT: 'm',
      },
    } satisfies IncidentJobContext;

    const handle = registry.start('inc-1', fakeService, ctx, {
      setTimer,
      clearTimer,
      now: () => 0,
    });
    expect(setTimer).toHaveBeenCalledTimes(1); // initial poll scheduled
    expect(registry.size()).toBe(1);

    handle.stop('test');
    expect(clearTimer).toHaveBeenCalledWith(101);
    expect(handle.isStopped()).toBe(true);
    expect(registry.size()).toBe(0);
  });

  it('replays start() returns the existing handle (idempotent)', () => {
    const registry = new RecoveryRegistry();
    const ctx = {
      kg: new KnowledgeGraph(openDb(':memory:')),
      telegram: {} as unknown as TelegramClient,
      log: pino({ level: 'silent' }),
      env: {
        GITHUB_TOKEN: 't',
        GITHUB_ORG: 'o',
        LLM_API_KEY: 'k',
        LLM_BASE_URL: 'https://x',
        LLM_MODEL_INCIDENT: 'm',
      },
    } satisfies IncidentJobContext;
    const fakeService = {
      id: 'service-x',
      type: 'Service' as const,
      created_at: 0,
      payload: {
        name: 'service-x',
        repo: 'org/repo',
        owner_team: 't',
        criticality: 'standard' as const,
      },
    };
    const a = registry.start('inc-2', fakeService, ctx, {
      setTimer: () => 1,
      clearTimer: () => {},
    });
    const b = registry.start('inc-2', fakeService, ctx, {
      setTimer: () => 2,
      clearTimer: () => {},
    });
    expect(a).toBe(b);
    a.stop('cleanup');
  });
});
