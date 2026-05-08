import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { KnowledgeGraph } from '../src/graph.js';
import { seed } from '../src/seed.js';
import type { Node } from '../src/schema.js';

const DAY = 86_400_000;

function fresh(): KnowledgeGraph {
  return new KnowledgeGraph(openDb(':memory:'));
}

function svc(id: string, name: string): Node {
  return {
    id,
    type: 'Service',
    created_at: 1,
    payload: {
      name,
      repo: `org/${name}`,
      owner_team: 'team',
      criticality: 'standard',
    },
  };
}

function inc(
  id: string,
  service_id: string,
  daysAgo: number,
  severity: 'P0' | 'P1' | 'P2' = 'P2',
): Node {
  return {
    id,
    type: 'Incident',
    created_at: Date.now() - daysAgo * DAY,
    payload: {
      severity,
      service_id,
      title: id,
      started_at: Date.now() - daysAgo * DAY,
    },
  };
}

function eng(id: string, load = 0): Node {
  return {
    id,
    type: 'Engineer',
    created_at: 1,
    payload: {
      name: id,
      github_handle: id,
      email: `${id}@example.com`,
      current_load: load,
    },
  };
}

function pr(
  id: string,
  author_id: string,
  status: 'open' | 'merged' | 'closed',
  daysAgo: number,
): Node {
  return {
    id,
    type: 'PR',
    created_at: Date.now() - daysAgo * DAY,
    payload: {
      number: parseInt(id.replace(/[^0-9]/g, ''), 10) || 1,
      title: id,
      author_id,
      status,
      created_at: Date.now() - daysAgo * DAY,
      files_changed: [],
    },
  };
}

function dep(
  id: string,
  service_id: string,
  by: string,
  daysAgo: number,
): Node {
  return {
    id,
    type: 'Deploy',
    created_at: Date.now() - daysAgo * DAY,
    payload: {
      sha: id.padEnd(40, '0'),
      service_id,
      deployed_at: Date.now() - daysAgo * DAY,
      deployed_by_id: by,
      status: 'success',
    },
  };
}

function adr(id: string, status: 'open' | 'accepted' | 'rejected'): Node {
  return {
    id,
    type: 'Decision',
    created_at: 1,
    payload: { type: 'ADR', title: id, status, created_at: 1 },
  };
}

describe('findRecurringIncidents', () => {
  it('returns only incidents on the given service within the window, newest first', () => {
    const kg = fresh();
    kg.addNode(svc('svc-x', 'x'));
    kg.addNode(svc('svc-y', 'y'));
    kg.addNode(inc('i-x-1', 'svc-x', 5));
    kg.addNode(inc('i-x-2', 'svc-x', 15));
    kg.addNode(inc('i-x-old', 'svc-x', 60)); // outside 30-day window
    kg.addNode(inc('i-y-1', 'svc-y', 3));

    const found = kg.findRecurringIncidents('svc-x', 30);
    expect(found.map((n) => n.id)).toEqual(['i-x-1', 'i-x-2']);
  });

  it('finds the 3 auth-service incidents in the seed', () => {
    const kg = fresh();
    seed(kg);
    const found = kg.findRecurringIncidents('service-auth', 30);
    expect(found).toHaveLength(3);
    for (const n of found) {
      expect(n.payload.service_id).toBe('service-auth');
    }
  });
});

describe('getCausalChain', () => {
  it('returns deploys (CAUSED_BY) and PRs (RESOLVES) plus engineers behind them', () => {
    const kg = fresh();
    kg.addNode(svc('s', 's'));
    kg.addNode(eng('e1'));
    kg.addNode(eng('e2'));
    kg.addNode(pr('pr1', 'e1', 'merged', 1));
    kg.addNode(dep('d1', 's', 'e2', 2));
    kg.addNode(inc('i1', 's', 1));

    kg.addEdge({
      source_id: 'i1',
      target_id: 'd1',
      edge_type: 'CAUSED_BY',
      created_at: 1,
    });
    kg.addEdge({
      source_id: 'pr1',
      target_id: 'i1',
      edge_type: 'RESOLVES',
      created_at: 1,
    });
    kg.addEdge({
      source_id: 'e1',
      target_id: 'pr1',
      edge_type: 'AUTHORED',
      created_at: 1,
    });
    kg.addEdge({
      source_id: 'e2',
      target_id: 'd1',
      edge_type: 'DEPLOYED',
      created_at: 1,
    });

    const chain = kg.getCausalChain('i1');
    expect(chain.incident.id).toBe('i1');
    expect(chain.deploys.map((d) => d.id)).toEqual(['d1']);
    expect(chain.prs.map((p) => p.id)).toEqual(['pr1']);
    expect(chain.engineers.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
  });

  it('throws on unknown incident id', () => {
    const kg = fresh();
    expect(() => kg.getCausalChain('nope')).toThrow(/not found/);
  });
});

describe('getEngineerLoad', () => {
  it('counts open PRs, recent linked incidents, and review queue proxy', () => {
    const kg = fresh();
    kg.addNode(svc('s', 's'));
    kg.addNode(eng('me', 5));
    kg.addNode(eng('them'));

    kg.addNode(pr('mine-open-1', 'me', 'open', 2));
    kg.addNode(pr('mine-open-2', 'me', 'open', 3));
    kg.addNode(pr('mine-merged', 'me', 'merged', 4));
    kg.addNode(pr('theirs-open', 'them', 'open', 1));

    for (const id of ['mine-open-1', 'mine-open-2', 'mine-merged']) {
      kg.addEdge({
        source_id: 'me',
        target_id: id,
        edge_type: 'AUTHORED',
        created_at: 1,
      });
    }
    kg.addEdge({
      source_id: 'them',
      target_id: 'theirs-open',
      edge_type: 'AUTHORED',
      created_at: 1,
    });

    // A recent incident resolved by my open PR.
    kg.addNode(inc('i-recent', 's', 5));
    kg.addEdge({
      source_id: 'mine-open-1',
      target_id: 'i-recent',
      edge_type: 'RESOLVES',
      created_at: 1,
    });

    const load = kg.getEngineerLoad('me');
    expect(load.open_prs).toBe(2);
    expect(load.recent_incidents).toBe(1);
    expect(load.review_queue_size).toBe(1); // theirs-open in last 7d, not authored by me
  });
});

describe('getOpenADRs', () => {
  it('returns all open ADRs when no service filter is given', () => {
    const kg = fresh();
    kg.addNode(adr('a-open', 'open'));
    kg.addNode(adr('a-accepted', 'accepted'));
    kg.addNode(adr('a-rejected', 'rejected'));

    const open = kg.getOpenADRs();
    expect(open.map((n) => n.id)).toEqual(['a-open']);
  });

  it('filters to ADRs INFORMED by an incident on the given service', () => {
    const kg = fresh();
    kg.addNode(svc('s-auth', 'auth'));
    kg.addNode(svc('s-other', 'other'));
    kg.addNode(inc('i-auth', 's-auth', 1));
    kg.addNode(inc('i-other', 's-other', 1));
    kg.addNode(adr('adr-auth', 'open'));
    kg.addNode(adr('adr-other', 'open'));
    kg.addEdge({
      source_id: 'adr-auth',
      target_id: 'i-auth',
      edge_type: 'INFORMED',
      created_at: 1,
    });
    kg.addEdge({
      source_id: 'adr-other',
      target_id: 'i-other',
      edge_type: 'INFORMED',
      created_at: 1,
    });

    const result = kg.getOpenADRs('s-auth');
    expect(result.map((n) => n.id)).toEqual(['adr-auth']);
  });

  it('returns 1 open ADR in the seed', () => {
    const kg = fresh();
    seed(kg);
    const open = kg.getOpenADRs();
    expect(open).toHaveLength(1);
    expect(open[0]?.payload.status).toBe('open');
  });
});

describe('getDeployImpact', () => {
  it('returns the touched service plus incidents that started after the deploy', () => {
    const kg = fresh();
    kg.addNode(svc('s', 's'));
    kg.addNode(eng('e'));
    kg.addNode(dep('d', 's', 'e', 5)); // deployed 5 days ago
    kg.addNode(inc('i-before', 's', 6)); // before deploy
    kg.addNode(inc('i-after-1', 's', 4)); // 1 day after deploy
    kg.addNode(inc('i-after-2', 's', 2)); // 3 days after deploy

    kg.addEdge({
      source_id: 'd',
      target_id: 's',
      edge_type: 'TOUCHES',
      created_at: 1,
    });

    const impact = kg.getDeployImpact('d');
    expect(impact.service.id).toBe('s');
    expect(impact.incidents_after.map((n) => n.id)).toEqual([
      'i-after-1',
      'i-after-2',
    ]);
    // First incident is i-after-1, ~1 day after deploy.
    expect(impact.time_to_first_incident_ms).toBeGreaterThan(0);
    expect(impact.time_to_first_incident_ms).toBeLessThan(2 * DAY);
  });

  it('returns null time-to-first when no incident followed', () => {
    const kg = fresh();
    kg.addNode(svc('s', 's'));
    kg.addNode(eng('e'));
    kg.addNode(dep('d', 's', 'e', 1));
    kg.addEdge({
      source_id: 'd',
      target_id: 's',
      edge_type: 'TOUCHES',
      created_at: 1,
    });
    const impact = kg.getDeployImpact('d');
    expect(impact.incidents_after).toEqual([]);
    expect(impact.time_to_first_incident_ms).toBeNull();
  });
});
