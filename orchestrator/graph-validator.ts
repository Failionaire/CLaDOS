/**
 * Graph Validator — validates a WorkflowGraph for correctness.
 *
 * Checks:
 *  1. All `next` refs point to existing node IDs
 *  2. No cycles (DFS)
 *  3. All agent roles are valid AgentRole values
 *  4. All skip_when conditions parse successfully
 *  5. Exactly one terminal node (no `next`)
 */

import type { WorkflowGraph, WorkflowNode, AgentStep } from './types.js';

export interface ValidationError {
  node: string;
  field: string;
  message: string;
}

const VALID_ROLES = new Set([
  'pm', 'architect', 'engineer', 'qa', 'docs', 'devops', 'security', 'wrecker', 'validator', 'refiner',
]);

const CONDITION_RE = /^([\w.]+)\s+(==|!=|>=?|<=?|in)\s+(.+)$/;

export function validateGraph(graph: WorkflowGraph): ValidationError[] {
  const errors: ValidationError[] = [];
  const ids = new Set(graph.nodes.map(n => n.id));

  if (graph.nodes.length === 0) {
    errors.push({ node: '(root)', field: 'nodes', message: 'Graph has no nodes' });
    return errors;
  }

  // 1. Check next refs
  for (const node of graph.nodes) {
    if (node.next && !ids.has(node.next)) {
      errors.push({ node: node.id, field: 'next', message: `References non-existent node "${node.next}"` });
    }
  }

  // 2. Cycle detection (DFS from first node)
  const visited = new Set<string>();
  const stack = new Set<string>();
  function dfs(id: string): boolean {
    if (stack.has(id)) return true; // cycle
    if (visited.has(id)) return false;
    visited.add(id);
    stack.add(id);
    const node = graph.nodes.find(n => n.id === id);
    if (node?.next) {
      if (dfs(node.next)) {
        errors.push({ node: id, field: 'next', message: `Cycle detected through "${node.next}"` });
        return true;
      }
    }
    stack.delete(id);
    return false;
  }
  dfs(graph.nodes[0]!.id);

  // 3. Validate agent roles and conditions
  for (const node of graph.nodes) {
    for (const [i, step] of node.agents.entries()) {
      if ('gate' in step) continue; // inline gate, no role to validate

      if (!VALID_ROLES.has(step.role)) {
        errors.push({ node: node.id, field: `agents[${i}].role`, message: `Unknown role "${step.role}"` });
      }
      if (step.skip_when && !CONDITION_RE.test(step.skip_when)) {
        errors.push({ node: node.id, field: `agents[${i}].skip_when`, message: `Unparseable condition: "${step.skip_when}"` });
      }
    }
  }

  // 4. Exactly one terminal node
  const terminals = graph.nodes.filter(n => !n.next);
  if (terminals.length === 0) {
    errors.push({ node: '(root)', field: 'next', message: 'No terminal node found (every node has a next)' });
  } else if (terminals.length > 1) {
    const names = terminals.map(t => t.id).join(', ');
    errors.push({ node: '(root)', field: 'next', message: `Multiple terminal nodes found: ${names}` });
  }

  return errors;
}
