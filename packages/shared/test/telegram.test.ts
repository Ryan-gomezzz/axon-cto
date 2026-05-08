import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TelegramClient,
  escapeMarkdownV2,
  type InlineButton,
} from '../src/telegram.js';

describe('escapeMarkdownV2', () => {
  it('escapes every MarkdownV2 special character', () => {
    const specials = '_*[]()~`>#+-=|{}.!\\';
    const escaped = escapeMarkdownV2(specials);
    // Every original char must be preceded by a backslash in the result.
    for (const c of specials) {
      expect(escaped).toContain(`\\${c}`);
    }
    // No special character should appear un-escaped.
    expect(escaped.replace(/\\./g, '')).toBe('');
  });

  it('leaves regular text alone', () => {
    expect(escapeMarkdownV2('hello world 123 abc')).toBe(
      'hello world 123 abc',
    );
  });

  it('escapes inline within a sentence', () => {
    expect(escapeMarkdownV2('auth-service: 3rd incident.')).toBe(
      'auth\\-service: 3rd incident\\.',
    );
  });
});

function fakeFetchOk(result: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result }),
  } as unknown as Response;
}

function fakeFetchStatus(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({}),
  } as unknown as Response;
}

describe('TelegramClient.send retry behavior', () => {
  let fakeFetch: ReturnType<typeof vi.fn>;
  let sleep: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fakeFetch = vi.fn();
    sleep = vi.fn().mockResolvedValue(undefined);
  });

  it('retries on 429 then 503 and succeeds on the third try', async () => {
    fakeFetch
      .mockResolvedValueOnce(fakeFetchStatus(429))
      .mockResolvedValueOnce(fakeFetchStatus(503))
      .mockResolvedValueOnce(
        fakeFetchOk({ message_id: 42, chat: { id: 'chat-99' } }),
      );

    const tc = new TelegramClient('TOKEN', 'chat-99', {
      fetch: fakeFetch as unknown as typeof fetch,
      sleep: sleep as unknown as (ms: number) => Promise<void>,
    });

    const ref = await tc.send('hello world');
    expect(ref).toEqual({ messageId: 42, chatId: 'chat-99' });
    expect(fakeFetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 500);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  it('gives up after exhausting all retries on persistent 5xx', async () => {
    fakeFetch.mockResolvedValue(fakeFetchStatus(503));

    const tc = new TelegramClient('TOKEN', 'chat', {
      fetch: fakeFetch as unknown as typeof fetch,
      sleep: sleep as unknown as (ms: number) => Promise<void>,
    });

    await expect(tc.send('hi')).rejects.toThrow(/HTTP 503/);
    // 1 initial + 3 retries = 4 calls.
    expect(fakeFetch).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenNthCalledWith(1, 500);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
    expect(sleep).toHaveBeenNthCalledWith(3, 8000);
  });

  it('does not retry on 4xx other than 429', async () => {
    fakeFetch.mockResolvedValue(fakeFetchStatus(400));

    const tc = new TelegramClient('TOKEN', 'chat', {
      fetch: fakeFetch as unknown as typeof fetch,
      sleep: sleep as unknown as (ms: number) => Promise<void>,
    });

    await expect(tc.send('hi')).rejects.toThrow(/HTTP 400/);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('TelegramClient.send body shape', () => {
  it('escapes text by default and wraps inline buttons in reply_markup', async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce(
      fakeFetchOk({ message_id: 1, chat: { id: 'c' } }),
    );
    const tc = new TelegramClient('TOKEN', 'c', {
      fetch: fakeFetch as unknown as typeof fetch,
    });

    const buttons: InlineButton[][] = [
      [
        { text: 'Rollback', callback_data: 'rollback:abc' },
        { text: 'Acknowledge', callback_data: 'ack:abc' },
      ],
      [{ text: 'Escalate', callback_data: 'escalate:abc' }],
    ];

    await tc.send('auth-service down!', { buttons, silent: true });

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const call = fakeFetch.mock.calls[0]!;
    const url = call[0] as string;
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    const init = call[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(body['chat_id']).toBe('c');
    expect(body['text']).toBe('auth\\-service down\\!');
    expect(body['parse_mode']).toBe('MarkdownV2');
    expect(body['disable_notification']).toBe(true);
    expect(body['reply_markup']).toEqual({ inline_keyboard: buttons });
  });

  it('skips escaping when skipEscape is set', async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce(
      fakeFetchOk({ message_id: 1, chat: { id: 'c' } }),
    );
    const tc = new TelegramClient('TOKEN', 'c', {
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await tc.send('*already* escaped\\.', { skipEscape: true });
    const init = fakeFetch.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['text']).toBe('*already* escaped\\.');
  });
});

describe('TelegramClient.editMessage', () => {
  it('targets editMessageText with the original chat/message ids', async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce(fakeFetchOk(true));
    const tc = new TelegramClient('TOKEN', 'c', {
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await tc.editMessage(
      { messageId: 99, chatId: 'cid' },
      'updated text.',
    );
    const url = fakeFetch.mock.calls[0]![0] as string;
    expect(url).toBe('https://api.telegram.org/botTOKEN/editMessageText');
    const init = fakeFetch.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['chat_id']).toBe('cid');
    expect(body['message_id']).toBe(99);
    expect(body['text']).toBe('updated text\\.');
  });
});
