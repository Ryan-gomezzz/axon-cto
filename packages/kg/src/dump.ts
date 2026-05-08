import type { KnowledgeGraph } from './graph.js';
import {
  NodeTypeEnum,
  EdgeTypeEnum,
  type Node,
  type NodeType,
  type EdgeType,
} from './schema.js';

function describe(node: Node): string {
  switch (node.type) {
    case 'Engineer':
      return `${node.payload.name} (@${node.payload.github_handle}, load=${node.payload.current_load})`;
    case 'PR':
      return `#${node.payload.number} "${node.payload.title}" [${node.payload.status}] by ${node.payload.author_id}`;
    case 'Incident':
      return `[${node.payload.severity}] ${node.payload.title} on ${node.payload.service_id}`;
    case 'Service':
      return `${node.payload.name} (${node.payload.criticality}) -> ${node.payload.repo}`;
    case 'Sprint':
      return `Sprint ${node.payload.number} (${node.payload.planned_points}pts planned)`;
    case 'Decision':
      return `[${node.payload.type}] ${node.payload.title} (${node.payload.status})`;
    case 'Deploy':
      return `${node.payload.sha.slice(0, 8)} on ${node.payload.service_id} [${node.payload.status}]`;
  }
}

export function kgDump(kg: KnowledgeGraph): string {
  const lines: string[] = [];
  lines.push('=== Knowledge Graph dump ===');

  for (const type of NodeTypeEnum.options as NodeType[]) {
    const count = kg.countNodesByType(type);
    lines.push('');
    lines.push(`-- ${type} (${count}) --`);
    if (count === 0) continue;
    const samples = kg.sampleNodesByType(type, 3);
    for (const node of samples) {
      lines.push(`  ${node.id}: ${describe(node)}`);
    }
  }

  lines.push('');
  lines.push('=== Edges ===');
  for (const type of EdgeTypeEnum.options as EdgeType[]) {
    lines.push(`  ${type}: ${kg.countEdgesByType(type)}`);
  }

  lines.push('');
  lines.push(`Total: ${kg.totalNodeCount()} nodes, ${kg.totalEdgeCount()} edges`);
  return lines.join('\n');
}
