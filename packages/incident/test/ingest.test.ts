import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, KnowledgeGraph, seed } from '@axon/kg';
import {
  parseAndValidateSentry,
  sentryToIncident,
} from '../src/ingest.js';

function freshKg(): KnowledgeGraph {
  const kg = new KnowledgeGraph(openDb(':memory:'));
  seed(kg);
  return kg;
}

describe('parseAndValidateSentry', () => {
  it('accepts a flat top-level event payload', () => {
    const out = parseAndValidateSentry({
      event_id: 'evt-1',
      project: 'auth-service',
      level: 'fatal',
      title: 'Redis pool exhausted',
      environment: 'prod',
    });
    expect(out.event_id).toBe('evt-1');
    expect(out.level).toBe('fatal');
    expect(out.project).toBe('auth-service');
  });

  it('unwraps Sentry "data.event" wrapper shape', () => {
    const out = parseAndValidateSentry({
      project: 'auth-service',
      data: {
        event: {
          event_id: 'evt-2',
          level: 'error',
          title: 'Login latency spike',
          environment: 'prod',
          fingerprint: ['auth', 'redis'],
          timestamp: 1_770_000_000,
        },
      },
    });
    expect(out.event_id).toBe('evt-2');
    expect(out.title).toBe('Login latency spike');
    expect(out.fingerprint).toEqual(['auth', 'redis']);
  });

  it('throws on payloads missing required fields', () => {
    expect(() =>
      parseAndValidateSentry({ project: 'auth-service' }),
    ).toThrow(/Sentry payload invalid/);
    expect(() =>
      parseAndValidateSentry({ event_id: 'x', title: 'y' }),
    ).toThrow(/project/);
  });
});

describe('sentryToIncident', () => {
  let kg: KnowledgeGraph;
  beforeEach(() => {
    kg = freshKg();
  });

  it('creates an Incident node + TOUCHES edge to the resolved Service', () => {
    const inc = sentryToIncident(
      parseAndValidateSentry({
        event_id: 'evt-A',
        project: 'auth-service',
        level: 'fatal',
        title: 'Redis pool exhausted on /token',
      }),
      kg,
    );
    expect(inc.type).toBe('Incident');
    expect(inc.payload.severity).toBe('P0');
    expect(inc.payload.service_id).toBe('service-auth');

    const edges = kg.getEdges(inc.id, 'out', ['TOUCHES']);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.target_id).toBe('service-auth');
  });

  it('is idempotent on event_id (duplicate webhook returns same node)', () => {
    const payload = parseAndValidateSentry({
      event_id: 'evt-dup',
      project: 'auth-service',
      level: 'error',
      title: 'Same incident, fired twice',
    });
    const a = sentryToIncident(payload, kg);
    const b = sentryToIncident(payload, kg);
    expect(a.id).toBe(b.id);
    // Only one TOUCHES edge — the second call must not double-link.
    const edges = kg.getEdges(a.id, 'out', ['TOUCHES']);
    expect(edges).toHaveLength(1);
  });

  it('throws when no Service in the KG matches the project name', () => {
    expect(() =>
      sentryToIncident(
        parseAndValidateSentry({
          event_id: 'evt-x',
          project: 'unknown-service',
          level: 'error',
          title: 'orphan',
        }),
        kg,
      ),
    ).toThrow(/no Service in KG/);
  });

  it('maps Sentry "fatal" -> P0, "error" -> P1, others -> P2', () => {
    const fatal = sentryToIncident(
      parseAndValidateSentry({
        event_id: 'evt-fatal',
        project: 'auth-service',
        level: 'fatal',
        title: 't',
      }),
      kg,
    );
    expect(fatal.payload.severity).toBe('P0');
    const err = sentryToIncident(
      parseAndValidateSentry({
        event_id: 'evt-err',
        project: 'auth-service',
        level: 'error',
        title: 't',
      }),
      kg,
    );
    expect(err.payload.severity).toBe('P1');
    const warn = sentryToIncident(
      parseAndValidateSentry({
        event_id: 'evt-warn',
        project: 'auth-service',
        level: 'warning',
        title: 't',
      }),
      kg,
    );
    expect(warn.payload.severity).toBe('P2');
  });
});
