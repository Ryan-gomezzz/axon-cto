import type { KnowledgeGraph, NodeOf } from '@axon/kg';
import { SentryWebhookSchema, type SentryWebhookPayload } from './types.js';

export function parseAndValidateSentry(raw: unknown): SentryWebhookPayload {
  const o = (raw ?? {}) as Record<string, unknown>;
  // Sentry's "issue alerts" wrap fields under data.event; "internal integrations"
  // send a flat shape. Try both.
  const data = (o['data'] as Record<string, unknown> | undefined) ?? undefined;
  const ev =
    (data?.['event'] as Record<string, unknown> | undefined) ?? o;
  const project =
    (o['project'] as string | undefined) ??
    (o['project_slug'] as string | undefined) ??
    (ev['project'] as string | undefined);
  const candidate = {
    event_id: ev['event_id'] ?? ev['id'],
    project,
    level: ev['level'] ?? 'error',
    title: ev['title'] ?? ev['message'],
    environment: ev['environment'],
    fingerprint: ev['fingerprint'],
    timestamp: ev['timestamp'],
  };
  const parsed = SentryWebhookSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`Sentry payload invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

function severityFromLevel(level: string): 'P0' | 'P1' | 'P2' {
  if (level === 'fatal') return 'P0';
  if (level === 'error') return 'P1';
  return 'P2';
}

function normalisedProjectKey(p: string): string {
  return p.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * Find the Service node whose payload.name (or repo trailing segment) matches
 * the Sentry project string. We don't have a named query for this; we iterate
 * via sampleNodesByType (an inspection helper, not a domain query).
 */
function resolveService(
  kg: KnowledgeGraph,
  project: string,
): NodeOf<'Service'> | null {
  const target = normalisedProjectKey(project);
  const services = kg.sampleNodesByType('Service', 100);
  for (const node of services) {
    if (node.type !== 'Service') continue;
    const candidates = [
      normalisedProjectKey(node.payload.name),
      normalisedProjectKey(node.id),
      normalisedProjectKey(node.payload.repo.split('/').pop() ?? ''),
    ];
    if (candidates.includes(target)) return node;
  }
  return null;
}

function startedAtMs(timestamp: SentryWebhookPayload['timestamp']): number {
  if (timestamp === undefined) return Date.now();
  if (typeof timestamp === 'number') {
    // Sentry occasionally reports seconds, occasionally ms. Heuristic: < 10^12 = seconds.
    return timestamp < 1e12 ? timestamp * 1000 : timestamp;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Convert a validated Sentry payload into a (possibly pre-existing) Incident
 * node. Idempotent on event_id — duplicate webhooks return the existing node
 * rather than creating a second one.
 */
export function sentryToIncident(
  payload: SentryWebhookPayload,
  kg: KnowledgeGraph,
): NodeOf<'Incident'> {
  const incidentId = `incident-evt-${payload.event_id}`;

  const existing = kg.getNode(incidentId);
  if (existing) {
    if (existing.type !== 'Incident') {
      throw new Error(
        `sentryToIncident: id collision — ${incidentId} exists as ${existing.type}`,
      );
    }
    return existing;
  }

  const service = resolveService(kg, payload.project);
  if (!service) {
    throw new Error(
      `sentryToIncident: no Service in KG matching project "${payload.project}"`,
    );
  }

  const startedAt = startedAtMs(payload.timestamp);
  kg.addNode({
    id: incidentId,
    type: 'Incident',
    created_at: startedAt,
    payload: {
      severity: severityFromLevel(payload.level),
      service_id: service.id,
      title: payload.title,
      started_at: startedAt,
    },
  });

  kg.addEdge({
    source_id: incidentId,
    target_id: service.id,
    edge_type: 'TOUCHES',
    created_at: startedAt,
    metadata: { source: 'sentry-webhook', event_id: payload.event_id },
  });

  const created = kg.getNode(incidentId, 'Incident');
  if (!created) {
    throw new Error(`sentryToIncident: failed to read back ${incidentId}`);
  }
  return created;
}
