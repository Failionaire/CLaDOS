/**
 * CLI subcommand: clados workflow
 *
 * Usage:
 *   clados workflow show [path/to/graph.json]
 *   clados workflow validate [path/to/graph.json]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkflowGraph } from '../types.js';
import { validateGraph } from '../graph-validator.js';

const DEFAULT_GRAPH = 'workflow-graph.default.json';

function loadGraph(graphPath: string): WorkflowGraph {
  if (!fs.existsSync(graphPath)) {
    console.error(`Graph file not found: ${graphPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
}

function resolveGraphPath(args: string[]): string {
  return args[0] ?? path.join(__dirname, '..', DEFAULT_GRAPH);
}

function showGraph(graph: WorkflowGraph): void {
  const title = graph.name ? `${graph.name} (v${graph.version})` : `v${graph.version}`;
  console.log(`\nWorkflow: ${title}\n`);

  for (const node of graph.nodes) {
    const isLast = !node.next;

    console.log(`  ┌─ Phase ${node.phase}: ${node.label}`);

    for (const step of node.agents) {
      if ('gate' in step) {
        console.log(`  │  ├─ [gate] ${step.gate}`);
      } else {
        const skip = step.skip_when ? ` (skip when: ${step.skip_when})` : '';
        const task = step.task ? ` — ${step.task}` : '';
        console.log(`  │  ├─ ${step.role}${task}${skip}`);
      }
    }

    if (node.gate) {
      console.log(`  │  └─ gate: ${node.gate.type} [${node.gate.artifacts.join(', ')}]`);
    }

    if (isLast) {
      console.log('  └─ (end)');
    } else {
      console.log(`  └─→ ${node.next}`);
    }
    console.log();
  }
}

function validateCommand(graph: WorkflowGraph): void {
  const errors = validateGraph(graph);

  if (errors.length === 0) {
    console.log('✓ Workflow graph is valid.');
    return;
  }

  console.error(`✗ ${errors.length} validation error(s):\n`);
  for (const err of errors) {
    console.error(`  [${err.node}] ${err.field}: ${err.message}`);
  }
  process.exit(1);
}

export async function workflowCommand(args: string[]): Promise<void> {
  const action = args[0];

  if (!action || action === 'show') {
    const graphPath = resolveGraphPath(args.slice(action ? 1 : 0));
    showGraph(loadGraph(graphPath));
    return;
  }

  if (action === 'validate') {
    const graphPath = resolveGraphPath(args.slice(1));
    validateCommand(loadGraph(graphPath));
    return;
  }

  console.error(`Unknown workflow action: ${action}`);
  console.error('Usage: clados workflow [show|validate] [graph-file]');
  process.exit(1);
}
