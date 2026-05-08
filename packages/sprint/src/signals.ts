import type { KnowledgeGraph, NodeOf } from '@axon/kg';
import type { SprintSignals } from './types.js';

const DAY_MS = 86_400_000;
const BLOCKER_NORMALISATION_CAP = 5;
const SYSTEMIC_INCIDENT_THRESHOLD = 2;

function clamp01(n: number): number {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Read the original_planned_points off Sprint metadata. CLAUDE.md's Sprint
 * payload doesn't include "original" planned points, so we fall back to
 * `current planned_points` (i.e. zero scope creep). When we eventually track
 * mid-sprint scope changes, this is the only place to update.
 */
function originalPlannedPoints(sprint: NodeOf<'Sprint'>): number {
  return sprint.payload.planned_points;
}

/**
 * Find the "current sprint" — the one whose [start_date, end_date] window
 * contains the given timestamp. Falls back to the latest-started sprint if
 * none match (e.g. between sprints).
 */
export function findCurrentSprint(
  kg: KnowledgeGraph,
  now: number = Date.now(),
): NodeOf<'Sprint'> | null {
  const sprints = kg
    .sampleNodesByType('Sprint', 100)
    .filter((s): s is NodeOf<'Sprint'> => s.type === 'Sprint');
  const live = sprints.filter(
    (s) =>
      s.payload.start_date <= now && now <= s.payload.end_date,
  );
  if (live.length > 0) {
    return live.sort(
      (a, b) => b.payload.start_date - a.payload.start_date,
    )[0] ?? null;
  }
  if (sprints.length === 0) return null;
  return sprints.sort(
    (a, b) => b.payload.start_date - a.payload.start_date,
  )[0] ?? null;
}

export interface GatherSignalsOptions {
  now?: number;
}

/**
 * Read all five risk signals out of the KG. Returns a fully-populated
 * `SprintSignals` shape; throws only if the sprint id can't be resolved.
 */
export async function gatherSprintSignals(
  sprintId: string,
  kg: KnowledgeGraph,
  options: GatherSignalsOptions = {},
): Promise<SprintSignals> {
  const sprint = kg.getNode(sprintId, 'Sprint');
  if (!sprint) {
    throw new Error(`gatherSprintSignals: sprint ${sprintId} not found`);
  }
  const now = options.now ?? Date.now();

  const totalDays = Math.max(
    1,
    (sprint.payload.end_date - sprint.payload.start_date) / DAY_MS,
  );
  const daysRemaining = (sprint.payload.end_date - now) / DAY_MS;
  const days_to_deadline_pressure = clamp01(1 - daysRemaining / totalDays);

  const planned = sprint.payload.planned_points;
  const completed = sprint.payload.completed_points ?? 0;
  const velocity_ratio =
    planned > 0 ? Math.min(1, completed / planned) : 1;

  const original = originalPlannedPoints(sprint);
  const scope_creep_pct =
    original > 0
      ? clamp01((planned - original) / original)
      : 0;

  // BLOCKS edges INTO the sprint (Incident -> Sprint, or PR -> Sprint).
  const blocksIn = kg.getEdges(sprintId, 'in', ['BLOCKS']);
  const blocker_weight =
    Math.min(blocksIn.length, BLOCKER_NORMALISATION_CAP) /
    BLOCKER_NORMALISATION_CAP;

  // Systemic block: any service with >threshold incidents in the sprint
  // window. We can't get this from a named query; iterate Service+Incident
  // nodes and filter (the same accommodation as enrich.ts).
  const services = kg
    .sampleNodesByType('Service', 100)
    .filter((n): n is NodeOf<'Service'> => n.type === 'Service');
  const incidents = kg
    .sampleNodesByType('Incident', 1000)
    .filter((n): n is NodeOf<'Incident'> => n.type === 'Incident');
  let systemic_block = 0;
  for (const svc of services) {
    const inWindow = incidents.filter(
      (i) =>
        i.payload.service_id === svc.id &&
        i.payload.started_at >= sprint.payload.start_date &&
        i.payload.started_at <= sprint.payload.end_date,
    );
    if (inWindow.length > SYSTEMIC_INCIDENT_THRESHOLD) {
      systemic_block = 1;
      break;
    }
  }

  return {
    blocker_weight,
    velocity_ratio,
    scope_creep_pct,
    days_to_deadline_pressure,
    systemic_block,
  };
}
