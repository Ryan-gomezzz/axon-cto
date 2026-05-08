import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import { openDb, KnowledgeGraph, seed } from '@axon/kg';
import type { TelegramClient } from '@axon/shared';
import type { BriefContext } from '../src/types.js';

// Mock the OpenAI module before importing the handler so synthesizeBrief uses
// our stub stream instead of dialing Together.ai. vi.mock is hoisted; we use a
// class so `new OpenAI(...)` constructs cleanly in vitest's module mocker.
vi.mock('openai', () => {
  async function* fakeStream() {
    yield {
      choices: [
        {
          delta: {
            content:
              '* auth-service: 3rd incident this month, pattern matches Redis connection exhaustion. ADR-1 still open.',
          },
        },
      ],
    };
    yield {
      choices: [
        {
          delta: {
            content:
              '\n* 2 PRs merged in 24h, neither touched critical paths — load is healthy.',
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

const { morningBriefJob } = await import('../src/handler.js');

function silentLogger() {
  return pino({ level: 'silent' });
}

function fakeTelegram() {
  const send = vi.fn().mockResolvedValue({ messageId: 1, chatId: 'chat' });
  const editMessage = vi.fn().mockResolvedValue(undefined);
  return {
    send,
    editMessage,
    onCallback: vi.fn(),
    stopPolling: vi.fn().mockResolvedValue(undefined),
  } as unknown as TelegramClient & { send: typeof send };
}

const baseEnv: BriefContext['env'] = {
  GITHUB_TOKEN: 'gh',
  GITHUB_ORG: 'o',
  GITHUB_REPO: 'r',
  LINEAR_API_KEY: 'l',
  LLM_API_KEY: 'k',
  LLM_BASE_URL: 'https://api.together.xyz/v1',
  LLM_MODEL_ROUTINE: 'nvidia/Nemotron-Mini-4B-Instruct',
};

describe('morningBriefJob', () => {
  let kg: KnowledgeGraph;
  beforeEach(() => {
    kg = new KnowledgeGraph(openDb(':memory:'));
    seed(kg);
  });

  it('sends a non-empty MarkdownV2 message with KG-derived content and a footer', async () => {
    const telegram = fakeTelegram();
    // Mock all external fetchers via injection so the handler doesn't dial out.
    const ctx: BriefContext = {
      kg,
      telegram: telegram as unknown as TelegramClient,
      log: silentLogger(),
      env: baseEnv,
      octokit: {
        paginate: vi.fn().mockResolvedValue([]),
        pulls: { list: {} },
      } as unknown as BriefContext['octokit'],
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { issues: { nodes: [] } } }),
      }) as unknown as typeof fetch,
    };

    await morningBriefJob(ctx, 't-test-1');

    expect((telegram as unknown as { send: ReturnType<typeof vi.fn> }).send)
      .toHaveBeenCalledTimes(1);
    const sendCall = (telegram as unknown as { send: ReturnType<typeof vi.fn> })
      .send.mock.calls[0]!;
    const message = sendCall[0] as string;
    const opts = sendCall[1] as { skipEscape?: boolean };

    expect(message.length).toBeGreaterThan(20);
    expect(opts.skipEscape).toBe(true);
    // The escaped brief includes our mocked KG bullet.
    expect(message).toContain('auth\\-service');
    expect(message).toContain('3rd incident this month');
    // Footer with trace id, italicised via _..._ markers. Hyphens in the
    // trace id get MarkdownV2-escaped, so match through escapes.
    expect(message).toMatch(/_Generated at .* IST · trace t\\?-test\\?-1_/);
  });

  it('still completes and sends a brief when one fetcher fails', async () => {
    const telegram = fakeTelegram();
    const ctx: BriefContext = {
      kg,
      telegram: telegram as unknown as TelegramClient,
      log: silentLogger(),
      env: baseEnv,
      octokit: {
        paginate: vi.fn().mockRejectedValue(new Error('GitHub rate limit')),
        pulls: { list: {} },
      } as unknown as BriefContext['octokit'],
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { issues: { nodes: [] } } }),
      }) as unknown as typeof fetch,
    };

    await morningBriefJob(ctx, 't-test-2');

    // Telegram still received the message — the failure didn't kill the job.
    expect((telegram as unknown as { send: ReturnType<typeof vi.fn> }).send)
      .toHaveBeenCalledTimes(1);
  });

  it('never throws even when telegram.send fails', async () => {
    const telegram = {
      send: vi.fn().mockRejectedValue(new Error('telegram down')),
      editMessage: vi.fn(),
      onCallback: vi.fn(),
      stopPolling: vi.fn(),
    };
    const ctx: BriefContext = {
      kg,
      telegram: telegram as unknown as TelegramClient,
      log: silentLogger(),
      env: baseEnv,
      octokit: {
        paginate: vi.fn().mockResolvedValue([]),
        pulls: { list: {} },
      } as unknown as BriefContext['octokit'],
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { issues: { nodes: [] } } }),
      }) as unknown as typeof fetch,
    };
    await expect(morningBriefJob(ctx, 't-test-3')).resolves.toBeUndefined();
  });
});
