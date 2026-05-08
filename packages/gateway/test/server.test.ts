import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { type AddressInfo } from 'node:net';
import pino from 'pino';
import { createApp } from '../src/server.js';
import { JobQueue } from '../src/queue.js';

const SENTRY_SECRET = 'sentry-test-secret';
const GITHUB_SECRET = 'github-test-secret';

function silentLogger() {
  return pino({ level: 'silent' });
}

function buildCtx(extras: Partial<{ slowHandler: boolean; throwOnEnqueue: boolean }> = {}) {
  const log = silentLogger();
  const queue = new JobQueue({ log });
  if (extras.slowHandler) {
    queue.registerHandler('incident', async () => {
      // Simulate a slow downstream — webhook must 200 *before* this resolves.
      // 300ms is plenty given response should be sub-50ms in-process; using
      // an unref'd timer so a hung handler doesn't keep the test process alive.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 300);
        t.unref();
      });
    });
  } else {
    queue.registerHandler('incident', async () => {});
  }
  queue.registerHandler('pr-realtime', async () => {});
  queue.registerHandler('github-event', async () => {});
  return {
    env: {
      SENTRY_WEBHOOK_SECRET: SENTRY_SECRET,
      GITHUB_WEBHOOK_SECRET: GITHUB_SECRET,
      NODE_ENV: 'test' as const,
    },
    queue,
    log,
  };
}

async function startServer(ctx: ReturnType<typeof buildCtx>) {
  const app = createApp(ctx);
  const server = await new Promise<{
    base: string;
    close: () => Promise<void>;
  }>((resolve) => {
    const httpServer = app.listen(0, () => {
      const addr = httpServer.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r) => {
            httpServer.close(() => r());
          }),
      });
    });
  });
  return server;
}

function sentrySig(body: string): string {
  return createHmac('sha256', SENTRY_SECRET).update(body).digest('hex');
}

function githubSig(body: string): string {
  return (
    'sha256=' + createHmac('sha256', GITHUB_SECRET).update(body).digest('hex')
  );
}

describe('GET /healthz', () => {
  it('returns ok with uptime', async () => {
    const ctx = buildCtx();
    const server = await startServer(ctx);
    try {
      const res = await fetch(`${server.base}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; uptime: number };
      expect(body.status).toBe('ok');
      expect(typeof body.uptime).toBe('number');
    } finally {
      await server.close();
    }
  });
});

describe('POST /webhook/sentry', () => {
  let ctx: ReturnType<typeof buildCtx>;
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    ctx = buildCtx();
    server = await startServer(ctx);
  });

  afterEach(async () => {
    await server.close();
  });

  it('rejects bad signatures with 401', async () => {
    const body = JSON.stringify({ event_id: 'abc' });
    const res = await fetch(`${server.base}/webhook/sentry`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sentry-hook-signature': 'deadbeefdeadbeef',
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('rejects requests with no signature header with 401', async () => {
    const body = JSON.stringify({ event_id: 'abc' });
    const res = await fetch(`${server.base}/webhook/sentry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('accepts a valid signature and returns 200 in <2s', async () => {
    const body = JSON.stringify({
      event_id: 'evt-1',
      project: 'auth-service',
      level: 'error',
    });
    const t0 = Date.now();
    const res = await fetch(`${server.base}/webhook/sentry`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sentry-hook-signature': sentrySig(body),
      },
      body,
    });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(2000);
    const json = (await res.json()) as { status: string; traceId: string };
    expect(json.status).toBe('accepted');
    expect(json.traceId).toMatch(/^t-\d+/);
  });

  it('still responds in <2s even when the queue handler is slow', async () => {
    await server.close();
    ctx = buildCtx({ slowHandler: true });
    server = await startServer(ctx);
    const body = JSON.stringify({ event_id: 'evt-slow' });
    const t0 = Date.now();
    const res = await fetch(`${server.base}/webhook/sentry`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sentry-hook-signature': sentrySig(body),
      },
      body,
    });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(2000);
  });

  it('rejects malformed JSON with 400', async () => {
    const body = '{not-json';
    const res = await fetch(`${server.base}/webhook/sentry`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sentry-hook-signature': sentrySig(body),
      },
      body,
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /webhook/github', () => {
  it('rejects bad signatures with 401', async () => {
    const ctx = buildCtx();
    const server = await startServer(ctx);
    try {
      const body = JSON.stringify({ action: 'opened' });
      const res = await fetch(`${server.base}/webhook/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': 'sha256=deadbeef',
          'x-github-event': 'pull_request',
        },
        body,
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('accepts a valid signature for pull_request events', async () => {
    const ctx = buildCtx();
    const server = await startServer(ctx);
    try {
      const body = JSON.stringify({ action: 'opened', number: 42 });
      const res = await fetch(`${server.base}/webhook/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': githubSig(body),
          'x-github-event': 'pull_request',
        },
        body,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string };
      expect(json.status).toBe('accepted');
    } finally {
      await server.close();
    }
  });
});
