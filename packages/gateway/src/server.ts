import * as crypto from 'node:crypto';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { z } from 'zod';
import type { Logger } from 'pino';
import { newTraceId, withTrace, currentTrace } from '@axon/shared';
import type { JobQueue } from './queue.js';

export interface ServerEnv {
  SENTRY_WEBHOOK_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  NODE_ENV: 'development' | 'test' | 'production';
}

export interface ServerContext {
  env: ServerEnv;
  queue: JobQueue;
  log: Logger;
}

/**
 * Both Sentry and GitHub schemas are intentionally permissive at the gateway
 * — full validation happens in the per-skill packages (incident, pr, etc.).
 * The gateway only enforces "is JSON" so we can forward shape-valid payloads
 * through the queue.
 */
const SentryWebhookSchema = z.record(z.string(), z.unknown());
const GithubWebhookSchema = z.record(z.string(), z.unknown());

function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function readSingleHeader(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

export function verifySentrySignature(
  body: Buffer,
  sigHeader: string | undefined,
  secret: string,
): boolean {
  if (!sigHeader || !secret) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return timingSafeStringEqual(expected, sigHeader);
}

export function verifyGithubSignature(
  body: Buffer,
  sigHeader: string | undefined,
  secret: string,
): boolean {
  if (!sigHeader || !secret) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(body).digest('hex');
  return timingSafeStringEqual(expected, sigHeader);
}

export function createApp(ctx: ServerContext): Express {
  const app = express();
  app.disable('x-powered-by');

  // 1) trace middleware — wraps every downstream handler in an ALS scope so
  //    currentTrace() works through the async chain.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const inboundTrace = readSingleHeader(req, 'x-trace-id');
    const traceId = inboundTrace ?? newTraceId();
    res.setHeader('x-trace-id', traceId);
    withTrace(traceId, () => next());
  });

  // 2) raw body for webhooks — HMAC must validate the unparsed bytes.
  app.use(
    '/webhook',
    express.raw({ type: '*/*', limit: '5mb' }),
  );

  // 3) regular JSON for everything else.
  app.use(express.json());

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
  });

  app.post('/webhook/sentry', async (req, res) => {
    const traceId = currentTrace() ?? newTraceId();
    const sig = readSingleHeader(req, 'sentry-hook-signature');
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body)) {
      ctx.log.warn(
        { component: 'gateway', route: '/webhook/sentry', traceId },
        'sentry webhook body was not captured as a buffer',
      );
      res.status(400).json({ error: 'raw body required' });
      return;
    }
    if (
      !verifySentrySignature(body, sig, ctx.env.SENTRY_WEBHOOK_SECRET)
    ) {
      ctx.log.warn(
        { component: 'gateway', route: '/webhook/sentry', traceId },
        'sentry webhook bad signature',
      );
      res.status(401).json({ error: 'invalid signature' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'invalid json' });
      return;
    }
    const validated = SentryWebhookSchema.safeParse(parsed);
    if (!validated.success) {
      res.status(400).json({ error: 'invalid payload shape' });
      return;
    }
    try {
      await ctx.queue.enqueue({
        type: 'incident',
        traceId,
        payload: validated.data,
      });
    } catch (err) {
      // Always 200 the caller — we own this work now. Log and move on; the
      // alternative is Sentry retrying, which doesn't help if our queue is
      // genuinely overloaded.
      ctx.log.error(
        {
          component: 'gateway',
          route: '/webhook/sentry',
          traceId,
          err: err instanceof Error ? err.message : String(err),
        },
        'failed to enqueue incident job',
      );
    }
    res.status(200).json({ status: 'accepted', traceId });
  });

  app.post('/webhook/github', async (req, res) => {
    const traceId = currentTrace() ?? newTraceId();
    const sig = readSingleHeader(req, 'x-hub-signature-256');
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body)) {
      res.status(400).json({ error: 'raw body required' });
      return;
    }
    if (!verifyGithubSignature(body, sig, ctx.env.GITHUB_WEBHOOK_SECRET)) {
      ctx.log.warn(
        { component: 'gateway', route: '/webhook/github', traceId },
        'github webhook bad signature',
      );
      res.status(401).json({ error: 'invalid signature' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'invalid json' });
      return;
    }
    const validated = GithubWebhookSchema.safeParse(parsed);
    if (!validated.success) {
      res.status(400).json({ error: 'invalid payload shape' });
      return;
    }
    const eventName = readSingleHeader(req, 'x-github-event');
    const jobType = eventName === 'pull_request' ? 'pr-realtime' : 'github-event';
    try {
      await ctx.queue.enqueue({
        type: jobType,
        traceId,
        payload: { event: eventName, body: validated.data },
      });
    } catch (err) {
      ctx.log.error(
        {
          component: 'gateway',
          route: '/webhook/github',
          traceId,
          err: err instanceof Error ? err.message : String(err),
        },
        'failed to enqueue github job',
      );
    }
    res.status(200).json({ status: 'accepted', traceId });
  });

  // 4) Error handler — last. JSON only, never leaks stack outside dev.
  app.use(
    (err: unknown, _req: Request, res: Response, next: NextFunction) => {
      const traceId = currentTrace();
      ctx.log.error(
        {
          component: 'gateway',
          traceId,
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        'unhandled error',
      );
      if (res.headersSent) {
        next(err);
        return;
      }
      const body =
        ctx.env.NODE_ENV === 'development'
          ? {
              error: 'internal',
              ...(err instanceof Error ? { message: err.message } : {}),
            }
          : { error: 'internal' };
      res.status(500).json(body);
    },
  );

  return app;
}
