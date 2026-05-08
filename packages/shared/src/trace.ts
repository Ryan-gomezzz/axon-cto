import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

const storage = new AsyncLocalStorage<string>();

let lastMs = 0;
let counter = 0;

/**
 * Monotonic-ish trace id: ms since epoch + per-ms counter + random suffix.
 * Same-ms calls get distinct ids without coordination.
 */
export function newTraceId(): string {
  const now = Date.now();
  if (now === lastMs) {
    counter += 1;
  } else {
    lastMs = now;
    counter = 0;
  }
  const suffix = randomBytes(3).toString('hex');
  return `t-${now}-${counter.toString(36)}-${suffix}`;
}

/** Run `fn` with `traceId` available to `currentTrace()` for its async chain. */
export function withTrace<T>(traceId: string, fn: () => T): T {
  return storage.run(traceId, fn);
}

export function currentTrace(): string | undefined {
  return storage.getStore();
}
