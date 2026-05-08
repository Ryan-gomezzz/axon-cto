import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { KnowledgeGraph } from '../src/graph.js';
import type { Node } from '../src/schema.js';

function freshKG() {
  const db = openDb(':memory:');
  return new KnowledgeGraph(db);
}

const SVC_AUTH: Node = {
  id: 's-auth',
  type: 'Service',
  created_at: 1_700_000_000_000,
  payload: {
    name: 'auth-service',
    repo: 'org/auth-service',
    owner_team: 'platform',
    criticality: 'critical',
  },
};

const ENG_A: Node = {
  id: 'e-a',
  type: 'Engineer',
  created_at: 1_700_000_000_000,
  payload: {
    name: 'Engineer A',
    github_handle: 'eng-a',
    email: 'a@example.com',
    current_load: 4,
  },
};

const PR_1: Node = {
  id: 'p-1',
  type: 'PR',
  created_at: 1_700_000_000_000,
  payload: {
    number: 1,
    title: 'first PR',
    author_id: 'e-a',
    status: 'open',
    created_at: 1_700_000_000_000,
    files_changed: ['packages/auth/src/foo.ts'],
  },
};

describe('KnowledgeGraph.addNode / addEdge', () => {
  let kg: KnowledgeGraph;
  beforeEach(() => {
    kg = freshKG();
  });

  it('adds a node and returns its id', () => {
    expect(kg.addNode(SVC_AUTH)).toBe('s-auth');
    expect(kg.getNode('s-auth')?.type).toBe('Service');
  });

  it('rejects nodes that violate the Zod schema', () => {
    const bad = {
      id: 's-bad',
      type: 'Service',
      created_at: 1_700_000_000_000,
      payload: {
        name: 'x',
        repo: 'r',
        owner_team: 't',
        criticality: 'tier-1', // not 'critical' | 'standard'
      },
    } as unknown as Node;
    expect(() => kg.addNode(bad)).toThrow(/validation failed/);
  });

  it('rejects edges where source or target is missing', () => {
    kg.addNode(ENG_A);
    expect(() =>
      kg.addEdge({
        source_id: 'e-a',
        target_id: 'p-doesnt-exist',
        edge_type: 'AUTHORED',
        created_at: Date.now(),
      }),
    ).toThrow(/target node/);
  });

  it('adds a valid edge and returns a generated id', () => {
    kg.addNode(ENG_A);
    kg.addNode(PR_1);
    const id = kg.addEdge({
      source_id: 'e-a',
      target_id: 'p-1',
      edge_type: 'AUTHORED',
      created_at: Date.now(),
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe('KnowledgeGraph.getNode', () => {
  it('returns null for unknown ids', () => {
    const kg = freshKG();
    expect(kg.getNode('nope')).toBeNull();
  });

  it('throws when expectedType disagrees with stored type', () => {
    const kg = freshKG();
    kg.addNode(SVC_AUTH);
    expect(() => kg.getNode('s-auth', 'Engineer')).toThrow(/expected Engineer/);
  });

  it('narrows the return type when expectedType matches', () => {
    const kg = freshKG();
    kg.addNode(SVC_AUTH);
    const svc = kg.getNode('s-auth', 'Service');
    // Type-level narrowing means svc.payload.criticality is accessible.
    expect(svc?.payload.criticality).toBe('critical');
  });
});

describe('KnowledgeGraph.getEdges direction filtering', () => {
  it('separates out / in / both', () => {
    const kg = freshKG();
    kg.addNode(ENG_A);
    kg.addNode(PR_1);
    kg.addEdge({
      source_id: 'e-a',
      target_id: 'p-1',
      edge_type: 'AUTHORED',
      created_at: 1_700_000_000_000,
    });
    expect(kg.getEdges('e-a', 'out')).toHaveLength(1);
    expect(kg.getEdges('e-a', 'in')).toHaveLength(0);
    expect(kg.getEdges('p-1', 'in')).toHaveLength(1);
    expect(kg.getEdges('p-1', 'out')).toHaveLength(0);
    expect(kg.getEdges('p-1', 'both')).toHaveLength(1);
  });

  it('filters by edge type', () => {
    const kg = freshKG();
    kg.addNode(ENG_A);
    kg.addNode(PR_1);
    kg.addNode(SVC_AUTH);
    kg.addEdge({
      source_id: 'e-a',
      target_id: 'p-1',
      edge_type: 'AUTHORED',
      created_at: 1,
    });
    kg.addEdge({
      source_id: 'p-1',
      target_id: 's-auth',
      edge_type: 'TOUCHES',
      created_at: 1,
    });
    expect(kg.getEdges('p-1', 'both', ['TOUCHES'])).toHaveLength(1);
    expect(kg.getEdges('p-1', 'both', ['BLOCKS'])).toHaveLength(0);
  });
});

describe('KnowledgeGraph.traverse', () => {
  function diamond(): KnowledgeGraph {
    // a -AUTHORED-> b -RESOLVES-> c, and a -AUTHORED-> d -RESOLVES-> c
    const kg = freshKG();
    const eng = (id: string): Node => ({
      id,
      type: 'Engineer',
      created_at: 1,
      payload: {
        name: id,
        github_handle: id,
        email: `${id}@example.com`,
        current_load: 0,
      },
    });
    const prn = (id: string): Node => ({
      id,
      type: 'PR',
      created_at: 1,
      payload: {
        number: 1,
        title: id,
        author_id: 'a',
        status: 'open',
        created_at: 1,
        files_changed: [],
      },
    });
    const incn = (id: string): Node => ({
      id,
      type: 'Incident',
      created_at: 1,
      payload: {
        severity: 'P2',
        service_id: 'svc',
        title: id,
        started_at: 1,
      },
    });
    const svc: Node = {
      id: 'svc',
      type: 'Service',
      created_at: 1,
      payload: {
        name: 'svc',
        repo: 'r',
        owner_team: 't',
        criticality: 'standard',
      },
    };
    kg.addNode(svc);
    kg.addNode(eng('a'));
    kg.addNode(prn('b'));
    kg.addNode(prn('d'));
    kg.addNode(incn('c'));
    kg.addEdge({
      source_id: 'a',
      target_id: 'b',
      edge_type: 'AUTHORED',
      created_at: 1,
    });
    kg.addEdge({
      source_id: 'a',
      target_id: 'd',
      edge_type: 'AUTHORED',
      created_at: 1,
    });
    kg.addEdge({
      source_id: 'b',
      target_id: 'c',
      edge_type: 'RESOLVES',
      created_at: 1,
    });
    kg.addEdge({
      source_id: 'd',
      target_id: 'c',
      edge_type: 'RESOLVES',
      created_at: 1,
    });
    return kg;
  }

  it('returns only the start node at depth 0', () => {
    const kg = diamond();
    const visited = kg.traverse('a', ['AUTHORED', 'RESOLVES'], 0);
    expect(visited.map((n) => n.id)).toEqual(['a']);
  });

  it('respects maxDepth (depth 1 stops before grandchildren)', () => {
    const kg = diamond();
    const ids = kg.traverse('a', ['AUTHORED', 'RESOLVES'], 1).map((n) => n.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).toContain('d');
    expect(ids).not.toContain('c');
  });

  it('deduplicates nodes reachable via multiple paths', () => {
    const kg = diamond();
    const ids = kg.traverse('a', ['AUTHORED', 'RESOLVES'], 5).map((n) => n.id);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(ids.filter((x) => x === 'c')).toHaveLength(1);
  });

  it('returns empty for unknown start id', () => {
    const kg = diamond();
    expect(kg.traverse('nope', ['AUTHORED'], 5)).toEqual([]);
  });
});
