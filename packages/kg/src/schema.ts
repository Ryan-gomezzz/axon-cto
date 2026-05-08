import { z } from 'zod';

export const EngineerPayload = z.object({
  name: z.string().min(1),
  github_handle: z.string().min(1),
  email: z.string().email(),
  current_load: z.number(),
});
export type EngineerPayload = z.infer<typeof EngineerPayload>;

export const PRPayload = z.object({
  number: z.number().int(),
  title: z.string().min(1),
  author_id: z.string().min(1),
  status: z.enum(['open', 'merged', 'closed']),
  created_at: z.number().int(),
  merged_at: z.number().int().optional(),
  files_changed: z.array(z.string()),
});
export type PRPayload = z.infer<typeof PRPayload>;

export const IncidentPayload = z.object({
  severity: z.enum(['P0', 'P1', 'P2']),
  service_id: z.string().min(1),
  title: z.string().min(1),
  started_at: z.number().int(),
  resolved_at: z.number().int().optional(),
  root_cause: z.string().optional(),
});
export type IncidentPayload = z.infer<typeof IncidentPayload>;

export const ServicePayload = z.object({
  name: z.string().min(1),
  repo: z.string().min(1),
  owner_team: z.string().min(1),
  criticality: z.enum(['critical', 'standard']),
});
export type ServicePayload = z.infer<typeof ServicePayload>;

export const SprintPayload = z.object({
  number: z.number().int(),
  start_date: z.number().int(),
  end_date: z.number().int(),
  planned_points: z.number(),
  completed_points: z.number().optional(),
  risk_score: z.number().optional(),
});
export type SprintPayload = z.infer<typeof SprintPayload>;

export const DecisionPayload = z.object({
  type: z.enum(['ADR', 'RFC']),
  title: z.string().min(1),
  status: z.enum(['open', 'accepted', 'rejected']),
  created_at: z.number().int(),
});
export type DecisionPayload = z.infer<typeof DecisionPayload>;

export const DeployPayload = z.object({
  sha: z.string().min(1),
  service_id: z.string().min(1),
  deployed_at: z.number().int(),
  deployed_by_id: z.string().min(1),
  status: z.enum(['success', 'rolled_back']),
});
export type DeployPayload = z.infer<typeof DeployPayload>;

export const NodeTypeEnum = z.enum([
  'Engineer',
  'PR',
  'Incident',
  'Service',
  'Sprint',
  'Decision',
  'Deploy',
]);
export type NodeType = z.infer<typeof NodeTypeEnum>;

const nodeBase = {
  id: z.string().min(1),
  created_at: z.number().int(),
};

export const EngineerNode = z.object({
  ...nodeBase,
  type: z.literal('Engineer'),
  payload: EngineerPayload,
});
export const PRNode = z.object({
  ...nodeBase,
  type: z.literal('PR'),
  payload: PRPayload,
});
export const IncidentNode = z.object({
  ...nodeBase,
  type: z.literal('Incident'),
  payload: IncidentPayload,
});
export const ServiceNode = z.object({
  ...nodeBase,
  type: z.literal('Service'),
  payload: ServicePayload,
});
export const SprintNode = z.object({
  ...nodeBase,
  type: z.literal('Sprint'),
  payload: SprintPayload,
});
export const DecisionNode = z.object({
  ...nodeBase,
  type: z.literal('Decision'),
  payload: DecisionPayload,
});
export const DeployNode = z.object({
  ...nodeBase,
  type: z.literal('Deploy'),
  payload: DeployPayload,
});

export const NodeSchema = z.discriminatedUnion('type', [
  EngineerNode,
  PRNode,
  IncidentNode,
  ServiceNode,
  SprintNode,
  DecisionNode,
  DeployNode,
]);
export type Node = z.infer<typeof NodeSchema>;

export type NodeOf<T extends NodeType> = Extract<Node, { type: T }>;

const PayloadByType = {
  Engineer: EngineerPayload,
  PR: PRPayload,
  Incident: IncidentPayload,
  Service: ServicePayload,
  Sprint: SprintPayload,
  Decision: DecisionPayload,
  Deploy: DeployPayload,
} as const;

export function payloadSchemaFor(type: NodeType) {
  return PayloadByType[type];
}

export const EdgeTypeEnum = z.enum([
  'CAUSED_BY',
  'TOUCHES',
  'AUTHORED',
  'INFORMED',
  'RESOLVES',
  'BLOCKS',
  'DEPLOYED',
]);
export type EdgeType = z.infer<typeof EdgeTypeEnum>;

export const EdgeInputSchema = z.object({
  source_id: z.string().min(1),
  target_id: z.string().min(1),
  edge_type: EdgeTypeEnum,
  created_at: z.number().int(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type EdgeInput = z.infer<typeof EdgeInputSchema>;

export const EdgeSchema = EdgeInputSchema.extend({
  id: z.string().min(1),
});
export type Edge = z.infer<typeof EdgeSchema>;
