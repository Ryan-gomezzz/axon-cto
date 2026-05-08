import type { NodeOf } from '@axon/kg';
import { escapeMarkdownV2 } from '@axon/shared';
import type { IncidentJobContext } from './types.js';

export interface RecoveryHandle {
  incidentId: string;
  stop(reason: string): void;
  /** True once the monitor has finished or been stopped. */
  isStopped(): boolean;
}

interface RecoveryConfig {
  pollIntervalMs: number;
  maxDurationMs: number;
  errorThreshold: number;
  /** Test seam: replace setTimeout/clearTimeout for fake-timer flow. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

const DEFAULTS: RecoveryConfig = {
  pollIntervalMs: 30_000,
  maxDurationMs: 10 * 60_000,
  errorThreshold: 5,
};

interface SentryIssueRow {
  count?: string | number;
}

async function pollSentry(
  ctx: IncidentJobContext,
  service: NodeOf<'Service'>,
): Promise<number> {
  const token = ctx.env.SENTRY_AUTH_TOKEN;
  const org = ctx.env.SENTRY_ORG;
  const project = ctx.env.SENTRY_PROJECT;
  if (!token || !org || !project) return 0;
  const f = ctx.fetch ?? globalThis.fetch.bind(globalThis);
  const url = `https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?statsPeriod=5m&query=is:unresolved+level:error&limit=50`;
  try {
    const res = await f(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      ctx.log.warn(
        {
          component: 'incident',
          stage: 'recovery.poll',
          status: res.status,
        },
        'sentry poll non-ok',
      );
      return Number.POSITIVE_INFINITY;
    }
    const rows = (await res.json()) as SentryIssueRow[];
    return rows.reduce<number>((sum, r) => {
      const c = typeof r.count === 'string' ? parseInt(r.count, 10) : r.count ?? 0;
      return sum + (Number.isFinite(c) ? Number(c) : 0);
    }, 0);
  } catch (err) {
    ctx.log.warn(
      {
        component: 'incident',
        stage: 'recovery.poll',
        err: err instanceof Error ? err.message : String(err),
      },
      'sentry poll threw',
    );
    return Number.POSITIVE_INFINITY;
  }
}

async function announceRecovery(
  ctx: IncidentJobContext,
  service: NodeOf<'Service'>,
  incidentId: string,
  reason: 'recovered' | 'timeout',
  service_name: string,
): Promise<void> {
  const text =
    reason === 'recovered'
      ? `✅ Recovery confirmed for ${service_name}: error rate has dropped below threshold for two consecutive polls. Marking ${incidentId} resolved.`
      : `⏱ Recovery monitor for ${service_name} timed out after 10 minutes without confirmation. ${incidentId} left unresolved.`;
  try {
    await ctx.telegram.send(`> ${escapeMarkdownV2(text)}`, {
      skipEscape: true,
    });
  } catch (err) {
    ctx.log.warn(
      {
        component: 'incident',
        stage: 'recovery.notify',
        err: err instanceof Error ? err.message : String(err),
      },
      'recovery notification failed',
    );
  }
  if (reason === 'recovered') {
    try {
      ctx.kg.updatePayload(incidentId, 'Incident', {
        resolved_at: Date.now(),
      });
    } catch (err) {
      ctx.log.warn(
        {
          component: 'incident',
          stage: 'recovery.persist',
          err: err instanceof Error ? err.message : String(err),
        },
        'failed to persist resolved_at',
      );
    }
  }
}

export class RecoveryRegistry {
  private active = new Map<string, RecoveryHandle>();

  start(
    incidentId: string,
    service: NodeOf<'Service'>,
    ctx: IncidentJobContext,
    overrides: Partial<RecoveryConfig> = {},
  ): RecoveryHandle {
    const existing = this.active.get(incidentId);
    if (existing && !existing.isStopped()) return existing;

    const cfg: RecoveryConfig = { ...DEFAULTS, ...overrides };
    const setTimer =
      cfg.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer =
      cfg.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const now = cfg.now ?? Date.now;

    const startedAt = now();
    let consecutiveBelow = 0;
    let timer: unknown;
    let stopped = false;

    const handle: RecoveryHandle = {
      incidentId,
      isStopped: () => stopped,
      stop: (reason: string) => {
        if (stopped) return;
        stopped = true;
        if (timer !== undefined) {
          clearTimer(timer);
          timer = undefined;
        }
        ctx.log.info(
          {
            component: 'incident',
            stage: 'recovery.stop',
            incidentId,
            reason,
          },
          'recovery monitor stopped',
        );
        this.active.delete(incidentId);
      },
    };

    const tick = async (): Promise<void> => {
      if (stopped) return;
      if (now() - startedAt >= cfg.maxDurationMs) {
        await announceRecovery(ctx, service, incidentId, 'timeout', service.payload.name);
        handle.stop('timeout');
        return;
      }
      const errorCount = await pollSentry(ctx, service);
      ctx.log.info(
        {
          component: 'incident',
          stage: 'recovery.tick',
          incidentId,
          error_count: errorCount,
          threshold: cfg.errorThreshold,
          consecutive_below: consecutiveBelow,
        },
        'recovery tick',
      );
      if (errorCount < cfg.errorThreshold) {
        consecutiveBelow += 1;
        if (consecutiveBelow >= 2) {
          await announceRecovery(
            ctx,
            service,
            incidentId,
            'recovered',
            service.payload.name,
          );
          handle.stop('recovered');
          return;
        }
      } else {
        consecutiveBelow = 0;
      }
      if (!stopped) {
        timer = setTimer(() => {
          void tick();
        }, cfg.pollIntervalMs);
      }
    };

    timer = setTimer(() => {
      void tick();
    }, cfg.pollIntervalMs);

    this.active.set(incidentId, handle);
    return handle;
  }

  has(incidentId: string): boolean {
    const h = this.active.get(incidentId);
    return h !== undefined && !h.isStopped();
  }

  stopAll(reason = 'shutdown'): void {
    for (const h of Array.from(this.active.values())) {
      h.stop(reason);
    }
  }

  size(): number {
    return Array.from(this.active.values()).filter((h) => !h.isStopped())
      .length;
  }
}
