import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DB } from './db.js';

type Stmt = Database.Statement<unknown[]>;
import {
  EdgeInputSchema,
  NodeSchema,
  NodeTypeEnum,
  payloadSchemaFor,
  type Edge,
  type EdgeInput,
  type EdgeType,
  type Node,
  type NodeOf,
  type NodeType,
} from './schema.js';

// Local alias so the long name does not bloat the updatePayload body.
const schemaFor = payloadSchemaFor;

interface NodeRow {
  id: string;
  type: string;
  created_at: number;
  payload: string;
}

interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  created_at: number;
  metadata: string | null;
}

function rowToNode(row: NodeRow): Node {
  const parsedType = NodeTypeEnum.safeParse(row.type);
  if (!parsedType.success) {
    throw new Error(`Unknown node type in DB row ${row.id}: ${row.type}`);
  }
  const payloadJson = JSON.parse(row.payload) as unknown;
  const payloadParsed = payloadSchemaFor(parsedType.data).safeParse(payloadJson);
  if (!payloadParsed.success) {
    throw new Error(
      `Corrupt payload for node ${row.id} (${row.type}): ${payloadParsed.error.message}`,
    );
  }
  // Construct then validate the full discriminated union to keep types tight.
  const candidate = {
    id: row.id,
    type: parsedType.data,
    created_at: row.created_at,
    payload: payloadParsed.data,
  };
  const node = NodeSchema.safeParse(candidate);
  if (!node.success) {
    throw new Error(`Failed to reconstruct node ${row.id}: ${node.error.message}`);
  }
  return node.data;
}

function rowToEdge(row: EdgeRow): Edge {
  return {
    id: row.id,
    source_id: row.source_id,
    target_id: row.target_id,
    edge_type: row.edge_type as EdgeType,
    created_at: row.created_at,
    ...(row.metadata !== null
      ? { metadata: JSON.parse(row.metadata) as Record<string, unknown> }
      : {}),
  };
}

const DAY_MS = 86_400_000;

export class KnowledgeGraph {
  private readonly db: DB;
  private readonly stmts: {
    insertNode: Stmt;
    insertEdge: Stmt;
    getNodeById: Stmt;
    edgesOut: Stmt;
    edgesIn: Stmt;
    edgesBoth: Stmt;
    nodeExists: Stmt;
  };

  constructor(db: DB) {
    this.db = db;
    this.stmts = {
      insertNode: db.prepare(
        'INSERT INTO nodes (id, type, created_at, payload) VALUES (?, ?, ?, ?)',
      ),
      insertEdge: db.prepare(
        'INSERT INTO edges (id, source_id, target_id, edge_type, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      getNodeById: db.prepare(
        'SELECT id, type, created_at, payload FROM nodes WHERE id = ?',
      ),
      edgesOut: db.prepare(
        'SELECT id, source_id, target_id, edge_type, created_at, metadata FROM edges WHERE source_id = ?',
      ),
      edgesIn: db.prepare(
        'SELECT id, source_id, target_id, edge_type, created_at, metadata FROM edges WHERE target_id = ?',
      ),
      edgesBoth: db.prepare(
        'SELECT id, source_id, target_id, edge_type, created_at, metadata FROM edges WHERE source_id = ? OR target_id = ?',
      ),
      nodeExists: db.prepare('SELECT 1 FROM nodes WHERE id = ?'),
    };
  }

  addNode(node: Node): string {
    const parsed = NodeSchema.safeParse(node);
    if (!parsed.success) {
      throw new Error(`addNode validation failed: ${parsed.error.message}`);
    }
    const data = parsed.data;
    this.stmts.insertNode.run(
      data.id,
      data.type,
      data.created_at,
      JSON.stringify(data.payload),
    );
    return data.id;
  }

  /**
   * Merge a partial payload into an existing node and re-validate. Throws if
   * the node is missing or if the merged payload no longer satisfies the
   * type's schema. Used by mutating skills (acknowledge, recovery) where
   * adding a new node would distort the graph.
   */
  updatePayload<T extends NodeType>(
    id: string,
    type: T,
    partial: Partial<NodeOf<T>['payload']>,
  ): void {
    const node = this.getNode(id, type);
    if (!node) {
      throw new Error(`updatePayload: node ${id} not found`);
    }
    const merged = { ...(node.payload as object), ...partial };
    const parsed = schemaFor(type).safeParse(merged);
    if (!parsed.success) {
      throw new Error(
        `updatePayload validation failed for ${id}: ${parsed.error.message}`,
      );
    }
    this.db
      .prepare('UPDATE nodes SET payload = ? WHERE id = ?')
      .run(JSON.stringify(parsed.data), id);
  }

  addEdge(edge: EdgeInput): string {
    const parsed = EdgeInputSchema.safeParse(edge);
    if (!parsed.success) {
      throw new Error(`addEdge validation failed: ${parsed.error.message}`);
    }
    const data = parsed.data;
    if (!this.stmts.nodeExists.get(data.source_id)) {
      throw new Error(`addEdge: source node ${data.source_id} does not exist`);
    }
    if (!this.stmts.nodeExists.get(data.target_id)) {
      throw new Error(`addEdge: target node ${data.target_id} does not exist`);
    }
    const id = randomUUID();
    this.stmts.insertEdge.run(
      id,
      data.source_id,
      data.target_id,
      data.edge_type,
      data.created_at,
      data.metadata !== undefined ? JSON.stringify(data.metadata) : null,
    );
    return id;
  }

  getNode(id: string): Node | null;
  getNode<T extends NodeType>(id: string, expectedType: T): NodeOf<T> | null;
  getNode(id: string, expectedType?: NodeType): Node | null {
    const row = this.stmts.getNodeById.get(id) as NodeRow | undefined;
    if (!row) return null;
    const node = rowToNode(row);
    if (expectedType !== undefined && node.type !== expectedType) {
      throw new Error(
        `getNode: node ${id} has type ${node.type}, expected ${expectedType}`,
      );
    }
    return node;
  }

  getEdges(
    nodeId: string,
    direction: 'out' | 'in' | 'both',
    edgeTypes?: EdgeType[],
  ): Edge[] {
    let rows: EdgeRow[];
    if (direction === 'out') {
      rows = this.stmts.edgesOut.all(nodeId) as EdgeRow[];
    } else if (direction === 'in') {
      rows = this.stmts.edgesIn.all(nodeId) as EdgeRow[];
    } else {
      rows = this.stmts.edgesBoth.all(nodeId, nodeId) as EdgeRow[];
    }
    const edges = rows.map(rowToEdge);
    if (edgeTypes && edgeTypes.length > 0) {
      const allow = new Set<EdgeType>(edgeTypes);
      return edges.filter((e) => allow.has(e.edge_type));
    }
    return edges;
  }

  /**
   * BFS along outgoing edges of the given types. Returns visited nodes in BFS
   * order (start node first), deduplicated by id, capped at maxDepth.
   */
  traverse(startId: string, edgeTypes: EdgeType[], maxDepth: number): Node[] {
    const start = this.getNode(startId);
    if (!start) return [];
    if (maxDepth < 0) return [];

    const visited = new Set<string>([startId]);
    const out: Node[] = [start];
    let frontier: string[] = [startId];

    for (let depth = 0; depth < maxDepth; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        const edges = this.getEdges(id, 'out', edgeTypes);
        for (const edge of edges) {
          if (visited.has(edge.target_id)) continue;
          visited.add(edge.target_id);
          const node = this.getNode(edge.target_id);
          if (node) {
            out.push(node);
            next.push(edge.target_id);
          }
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
    return out;
  }

  /** Drop every node and edge. Used by tests and the seed CLI. */
  wipe(): void {
    this.db.exec('DELETE FROM edges; DELETE FROM nodes;');
  }

  // ---------- Inspection helpers (used by dump.ts) ----------

  countNodesByType(type: NodeType): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM nodes WHERE type = ?')
      .get(type) as { c: number };
    return row.c;
  }

  sampleNodesByType(type: NodeType, limit: number): Node[] {
    const rows = this.db
      .prepare(
        `SELECT id, type, created_at, payload FROM nodes
         WHERE type = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(type, limit) as NodeRow[];
    return rows.map(rowToNode);
  }

  countEdgesByType(type: EdgeType): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM edges WHERE edge_type = ?')
      .get(type) as { c: number };
    return row.c;
  }

  totalNodeCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as {
      c: number;
    };
    return row.c;
  }

  totalEdgeCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM edges').get() as {
      c: number;
    };
    return row.c;
  }

  // ---------- Named queries (the contract) ----------

  /**
   * Incidents on a service whose started_at falls within the last `days`.
   * Sorted newest first.
   */
  findRecurringIncidents(serviceId: string, days: number): NodeOf<'Incident'>[] {
    const cutoff = Date.now() - days * DAY_MS;
    const rows = this.db
      .prepare(
        `SELECT id, type, created_at, payload
         FROM nodes
         WHERE type = 'Incident'
           AND json_extract(payload, '$.service_id') = ?
           AND json_extract(payload, '$.started_at') >= ?
         ORDER BY json_extract(payload, '$.started_at') DESC`,
      )
      .all(serviceId, cutoff) as NodeRow[];
    return rows.map(rowToNode) as NodeOf<'Incident'>[];
  }

  /**
   * For an incident, the deploys/PRs it was caused by (or that resolved it),
   * plus the engineers involved.
   */
  getCausalChain(incidentId: string): {
    incident: NodeOf<'Incident'>;
    deploys: NodeOf<'Deploy'>[];
    prs: NodeOf<'PR'>[];
    engineers: NodeOf<'Engineer'>[];
  } {
    const incident = this.getNode(incidentId, 'Incident');
    if (!incident) {
      throw new Error(`getCausalChain: incident ${incidentId} not found`);
    }

    const causedByRows = this.db
      .prepare(
        `SELECT n.id AS id, n.type AS type, n.created_at AS created_at, n.payload AS payload
         FROM edges e JOIN nodes n ON n.id = e.target_id
         WHERE e.source_id = ? AND e.edge_type = 'CAUSED_BY'`,
      )
      .all(incidentId) as NodeRow[];

    const resolvedByRows = this.db
      .prepare(
        `SELECT n.id AS id, n.type AS type, n.created_at AS created_at, n.payload AS payload
         FROM edges e JOIN nodes n ON n.id = e.source_id
         WHERE e.target_id = ? AND e.edge_type = 'RESOLVES'`,
      )
      .all(incidentId) as NodeRow[];

    const deployIds: string[] = [];
    const prIds: string[] = [];
    const deploys: NodeOf<'Deploy'>[] = [];
    const prs: NodeOf<'PR'>[] = [];
    const seen = new Set<string>();

    for (const r of [...causedByRows, ...resolvedByRows]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const node = rowToNode(r);
      if (node.type === 'Deploy') {
        deploys.push(node);
        deployIds.push(node.id);
      } else if (node.type === 'PR') {
        prs.push(node);
        prIds.push(node.id);
      }
    }

    const engineers: NodeOf<'Engineer'>[] = [];
    const engSeen = new Set<string>();
    if (prIds.length > 0) {
      const placeholders = prIds.map(() => '?').join(',');
      const engRows = this.db
        .prepare(
          `SELECT n.id AS id, n.type AS type, n.created_at AS created_at, n.payload AS payload
           FROM edges e JOIN nodes n ON n.id = e.source_id
           WHERE e.target_id IN (${placeholders}) AND e.edge_type = 'AUTHORED'`,
        )
        .all(...prIds) as NodeRow[];
      for (const r of engRows) {
        if (engSeen.has(r.id)) continue;
        engSeen.add(r.id);
        const node = rowToNode(r);
        if (node.type === 'Engineer') engineers.push(node);
      }
    }
    if (deployIds.length > 0) {
      const placeholders = deployIds.map(() => '?').join(',');
      const engRows = this.db
        .prepare(
          `SELECT n.id AS id, n.type AS type, n.created_at AS created_at, n.payload AS payload
           FROM edges e JOIN nodes n ON n.id = e.source_id
           WHERE e.target_id IN (${placeholders}) AND e.edge_type = 'DEPLOYED'`,
        )
        .all(...deployIds) as NodeRow[];
      for (const r of engRows) {
        if (engSeen.has(r.id)) continue;
        engSeen.add(r.id);
        const node = rowToNode(r);
        if (node.type === 'Engineer') engineers.push(node);
      }
    }

    return { incident, deploys, prs, engineers };
  }

  /**
   * Open PRs by this engineer, recent incidents linked to their PRs/Deploys,
   * and a proxy for review queue (open PRs by other engineers in last 7d).
   */
  getEngineerLoad(engineerId: string): {
    open_prs: number;
    recent_incidents: number;
    review_queue_size: number;
  } {
    const openPrsRow = this.db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM edges e JOIN nodes n ON n.id = e.target_id
         WHERE e.source_id = ?
           AND e.edge_type = 'AUTHORED'
           AND n.type = 'PR'
           AND json_extract(n.payload, '$.status') = 'open'`,
      )
      .get(engineerId) as { c: number };

    const recentCutoff = Date.now() - 30 * DAY_MS;

    // Incidents linked via the engineer's PRs (CAUSED_BY or RESOLVES)
    const incidentsViaPrsRow = this.db
      .prepare(
        `SELECT COUNT(DISTINCT i.id) AS c
         FROM edges authored
         JOIN nodes pr ON pr.id = authored.target_id
         JOIN edges link ON
              (link.source_id = pr.id AND link.edge_type = 'RESOLVES')
           OR (link.target_id = pr.id AND link.edge_type = 'CAUSED_BY')
         JOIN nodes i ON i.id = CASE
              WHEN link.edge_type = 'RESOLVES' THEN link.target_id
              ELSE link.source_id END
         WHERE authored.source_id = ?
           AND authored.edge_type = 'AUTHORED'
           AND pr.type = 'PR'
           AND i.type = 'Incident'
           AND json_extract(i.payload, '$.started_at') >= ?`,
      )
      .get(engineerId, recentCutoff) as { c: number };

    // Incidents linked via the engineer's Deploys (Incident -CAUSED_BY-> Deploy)
    const incidentsViaDeploysRow = this.db
      .prepare(
        `SELECT COUNT(DISTINCT i.id) AS c
         FROM edges deployed
         JOIN nodes d ON d.id = deployed.target_id
         JOIN edges caused ON caused.target_id = d.id AND caused.edge_type = 'CAUSED_BY'
         JOIN nodes i ON i.id = caused.source_id
         WHERE deployed.source_id = ?
           AND deployed.edge_type = 'DEPLOYED'
           AND d.type = 'Deploy'
           AND i.type = 'Incident'
           AND json_extract(i.payload, '$.started_at') >= ?`,
      )
      .get(engineerId, recentCutoff) as { c: number };

    // Review-queue proxy: open PRs not authored by this engineer, last 7 days.
    const reviewCutoff = Date.now() - 7 * DAY_MS;
    const reviewRow = this.db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM nodes n
         WHERE n.type = 'PR'
           AND json_extract(n.payload, '$.status') = 'open'
           AND json_extract(n.payload, '$.created_at') >= ?
           AND json_extract(n.payload, '$.author_id') != ?`,
      )
      .get(reviewCutoff, engineerId) as { c: number };

    return {
      open_prs: openPrsRow.c,
      recent_incidents: incidentsViaPrsRow.c + incidentsViaDeploysRow.c,
      review_queue_size: reviewRow.c,
    };
  }

  /**
   * Open ADRs (Decision nodes with type=ADR, status=open). If a service is
   * given, restrict to ADRs INFORMED by an incident on that service.
   */
  getOpenADRs(serviceId?: string): NodeOf<'Decision'>[] {
    if (serviceId === undefined) {
      const rows = this.db
        .prepare(
          `SELECT id, type, created_at, payload
           FROM nodes
           WHERE type = 'Decision'
             AND json_extract(payload, '$.type') = 'ADR'
             AND json_extract(payload, '$.status') = 'open'
           ORDER BY json_extract(payload, '$.created_at') DESC`,
        )
        .all() as NodeRow[];
      return rows.map(rowToNode) as NodeOf<'Decision'>[];
    }
    const rows = this.db
      .prepare(
        `SELECT DISTINCT d.id AS id, d.type AS type, d.created_at AS created_at, d.payload AS payload
         FROM nodes d
         JOIN edges informed ON informed.source_id = d.id AND informed.edge_type = 'INFORMED'
         JOIN nodes i ON i.id = informed.target_id
         WHERE d.type = 'Decision'
           AND json_extract(d.payload, '$.type') = 'ADR'
           AND json_extract(d.payload, '$.status') = 'open'
           AND i.type = 'Incident'
           AND json_extract(i.payload, '$.service_id') = ?
         ORDER BY json_extract(d.payload, '$.created_at') DESC`,
      )
      .all(serviceId) as NodeRow[];
    return rows.map(rowToNode) as NodeOf<'Decision'>[];
  }

  /**
   * For a deploy, the service it touched, incidents that started after it,
   * and ms to the first such incident.
   */
  getDeployImpact(deployId: string): {
    service: NodeOf<'Service'>;
    incidents_after: NodeOf<'Incident'>[];
    time_to_first_incident_ms: number | null;
  } {
    const deploy = this.getNode(deployId, 'Deploy');
    if (!deploy) {
      throw new Error(`getDeployImpact: deploy ${deployId} not found`);
    }

    const serviceRow = this.db
      .prepare(
        `SELECT n.id AS id, n.type AS type, n.created_at AS created_at, n.payload AS payload
         FROM edges e JOIN nodes n ON n.id = e.target_id
         WHERE e.source_id = ? AND e.edge_type = 'TOUCHES' AND n.type = 'Service'
         LIMIT 1`,
      )
      .get(deployId) as NodeRow | undefined;
    if (!serviceRow) {
      throw new Error(
        `getDeployImpact: deploy ${deployId} has no TOUCHES->Service edge`,
      );
    }
    const service = rowToNode(serviceRow) as NodeOf<'Service'>;

    const incidentRows = this.db
      .prepare(
        `SELECT id, type, created_at, payload
         FROM nodes
         WHERE type = 'Incident'
           AND json_extract(payload, '$.service_id') = ?
           AND json_extract(payload, '$.started_at') > ?
         ORDER BY json_extract(payload, '$.started_at') ASC`,
      )
      .all(service.id, deploy.payload.deployed_at) as NodeRow[];

    const incidents_after = incidentRows.map(rowToNode) as NodeOf<'Incident'>[];
    const first = incidents_after[0];
    const time_to_first_incident_ms =
      first === undefined
        ? null
        : first.payload.started_at - deploy.payload.deployed_at;

    return { service, incidents_after, time_to_first_incident_ms };
  }
}
