import { createRequire } from 'node:module';

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface MessageRef {
  messageId: number;
  chatId: string;
}

export interface SendOptions {
  chatId?: string;
  buttons?: InlineButton[][];
  silent?: boolean;
  /** Skip auto-escaping; caller has produced valid MarkdownV2 themselves. */
  skipEscape?: boolean;
}

export interface EditOptions {
  buttons?: InlineButton[][];
  skipEscape?: boolean;
}

export interface TelegramClientDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Override for unit-testing the polling/callback path; left unset in prod. */
  pollingDriver?: PollingDriver;
}

export interface CallbackContext {
  data: string;
  callbackQueryId: string;
  fromUserId: number | undefined;
  message?: MessageRef;
}

export type CallbackHandler = (
  data: string,
  ctx: CallbackContext,
) => Promise<void>;

export interface PollingDriver {
  on(event: 'callback_query', listener: (q: TelegramCallbackQuery) => void): void;
  answerCallbackQuery(id: string): Promise<unknown>;
  stopPolling(): Promise<void>;
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from?: { id: number };
  message?: { message_id: number; chat: { id: number | string } };
}

const RETRY_DELAYS_MS = [500, 2000, 8000] as const;

const MARKDOWN_V2_SPECIALS = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(s: string): string {
  return s.replace(MARKDOWN_V2_SPECIALS, '\\$&');
}

export class TelegramClient {
  private readonly token: string;
  private readonly defaultChatId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private polling: PollingDriver | undefined;

  constructor(
    token: string,
    defaultChatId: string,
    deps: TelegramClientDeps = {},
  ) {
    this.token = token;
    this.defaultChatId = defaultChatId;
    this.fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep =
      deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (deps.pollingDriver) {
      this.polling = deps.pollingDriver;
    }
  }

  async send(text: string, opts: SendOptions = {}): Promise<MessageRef> {
    const body: Record<string, unknown> = {
      chat_id: opts.chatId ?? this.defaultChatId,
      text: opts.skipEscape ? text : escapeMarkdownV2(text),
      parse_mode: 'MarkdownV2',
      disable_notification: opts.silent ?? false,
    };
    if (opts.buttons) {
      body['reply_markup'] = { inline_keyboard: opts.buttons };
    }
    const result = (await this.callWithRetry('sendMessage', body)) as {
      message_id: number;
      chat: { id: number | string };
    };
    return {
      messageId: result.message_id,
      chatId: String(result.chat.id),
    };
  }

  async editMessage(
    ref: MessageRef,
    text: string,
    opts: EditOptions = {},
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: ref.chatId,
      message_id: ref.messageId,
      text: opts.skipEscape ? text : escapeMarkdownV2(text),
      parse_mode: 'MarkdownV2',
    };
    if (opts.buttons) {
      body['reply_markup'] = { inline_keyboard: opts.buttons };
    }
    await this.callWithRetry('editMessageText', body);
  }

  /**
   * Register a callback-query handler. The polling driver is created lazily
   * on first registration so unit tests that never call `onCallback` don't
   * accidentally start a Telegram poller.
   */
  onCallback(handler: CallbackHandler): void {
    const driver = this.polling ?? this.createDefaultPollingDriver();
    this.polling = driver;
    driver.on('callback_query', (query) => {
      void this.dispatchCallback(driver, query, handler);
    });
  }

  private async dispatchCallback(
    driver: PollingDriver,
    query: TelegramCallbackQuery,
    handler: CallbackHandler,
  ): Promise<void> {
    if (query.data === undefined) return;
    const ctx: CallbackContext = {
      data: query.data,
      callbackQueryId: query.id,
      fromUserId: query.from?.id,
      ...(query.message
        ? {
            message: {
              messageId: query.message.message_id,
              chatId: String(query.message.chat.id),
            },
          }
        : {}),
    };
    try {
      await handler(query.data, ctx);
    } finally {
      try {
        await driver.answerCallbackQuery(query.id);
      } catch {
        // best-effort ack; failures here are non-fatal
      }
    }
  }

  /** Stop the polling driver if one was started; safe to call repeatedly. */
  async stopPolling(): Promise<void> {
    if (this.polling) {
      await this.polling.stopPolling();
      this.polling = undefined;
    }
  }

  private createDefaultPollingDriver(): PollingDriver {
    // Lazily load the SDK via createRequire so non-callback consumers (and
    // most tests) never pull node-telegram-bot-api into memory.
    const requireFn = createRequire(import.meta.url);
    const TelegramBot = requireFn('node-telegram-bot-api') as new (
      token: string,
      opts: { polling: boolean },
    ) => {
      on: (event: string, listener: (q: TelegramCallbackQuery) => void) => void;
      answerCallbackQuery: (id: string) => Promise<unknown>;
      stopPolling: () => Promise<void>;
    };
    const bot = new TelegramBot(this.token, { polling: true });
    return {
      on: (event, listener) => bot.on(event, listener),
      answerCallbackQuery: (id) => bot.answerCallbackQuery(id),
      stopPolling: () => bot.stopPolling(),
    };
  }

  private async callWithRetry(
    method: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    let lastError: unknown;
    // 1 initial attempt + up to 3 retries with the configured backoff.
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1];
        if (delay !== undefined) await this.sleep(delay);
      }
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (networkErr) {
        // Network-level failures (DNS, TCP reset, abort, etc.) are retryable.
        lastError = networkErr;
        continue;
      }
      if (res.ok) {
        const json = (await res.json()) as { ok?: boolean; result?: unknown };
        if (json.ok === false) {
          // Telegram-level error inside a 200 response. Don't retry — the
          // payload is malformed in some way the API understood.
          throw new Error(`Telegram ${method} returned ok=false`);
        }
        return json.result;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Telegram ${method} HTTP ${res.status}`);
        continue;
      }
      // 4xx other than 429: non-retryable, surface immediately.
      throw new Error(`Telegram ${method} HTTP ${res.status}`);
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Telegram ${method} failed after retries`);
  }
}
