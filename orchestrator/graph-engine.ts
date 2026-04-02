/**
 * Graph Engine — reads a workflow DAG and drives phase transitions.
 *
 * Evaluates skip_when conditions using a safe DSL (no eval, no JS expressions).
 * The default graph matches the hardcoded conductor behavior.
 */

import type { WorkflowGraph, WorkflowNode, AgentStep, SessionState } from './types.js';

/**
 * Evaluate a skip_when condition against session state.
 *
 * Grammar: `field operator value`
 *   field    — dotted path into session state (e.g. "config.project_type")
 *   operator — ==, !=, >, >=, <, <=, in
 *   value    — string, number, boolean, or JSON array of strings
 *
 * No eval(), no arbitrary JS. All comparisons are literal.
 */
export function evaluateCondition(condition: string, state: SessionState): boolean {
  const match = condition.match(/^([\w.]+)\s+(==|!=|>=?|<=?|in)\s+(.+)$/);
  if (!match) return false;

  const [, fieldPath, operator, rawValue] = match;
  const actual = resolveField(state as unknown as Record<string, unknown>, fieldPath!);
  const expected = parseValue(rawValue!);

  switch (operator) {
    case '==':  return actual === expected || String(actual) === String(expected);
    case '!=':  return actual !== expected && String(actual) !== String(expected);
    case '>':   return Number(actual) > Number(expected);
    case '>=':  return Number(actual) >= Number(expected);
    case '<':   return Number(actual) < Number(expected);
    case '<=':  return Number(actual) <= Number(expected);
    case 'in': {
      if (!Array.isArray(expected)) return false;
      return expected.includes(String(actual));
    }
    default: return false;
  }
}

function resolveField(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function parseValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch { return trimmed; }
  }
  // Strip quotes if present
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export class GraphEngine {
  private nodeMap: Map<string, WorkflowNode>;

  constructor(private graph: WorkflowGraph) {
    this.nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  }

  /** Get the node for a given phase number. */
  getNodeByPhase(phase: number): WorkflowNode | undefined {
    return this.graph.nodes.find(n => n.phase === phase);
  }

  /** Get a node by its ID. */
  getNode(id: string): WorkflowNode | undefined {
    return this.nodeMap.get(id);
  }

  /** Get the current node based on session state's current phase. */
  currentNode(state: SessionState): WorkflowNode | undefined {
    return this.getNodeByPhase(state.current_phase);
  }

  /** Get the next node after the given node. */
  nextNode(node: WorkflowNode): WorkflowNode | null {
    if (!node.next) return null;
    return this.nodeMap.get(node.next) ?? null;
  }

  /** Get all nodes in execution order (following next links from the first node). */
  executionOrder(): WorkflowNode[] {
    const result: WorkflowNode[] = [];
    let current: WorkflowNode | undefined = this.graph.nodes[0];
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      result.push(current);
      current = current.next ? this.nodeMap.get(current.next) : undefined;
    }
    return result;
  }

  /** Filter agents for a node, applying skip_when conditions. */
  filterAgents(node: WorkflowNode, state: SessionState): AgentStep[] {
    return node.agents.filter(step => {
      if ('gate' in step) return true; // Inline gates never skip
      if (!step.skip_when) return true;
      return !evaluateCondition(step.skip_when, state);
    });
  }

  /** Get the full graph for introspection. */
  getGraph(): WorkflowGraph {
    return this.graph;
  }
}
