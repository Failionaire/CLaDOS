/**
 * clados model-update — re-resolve model aliases in agent-registry.json
 *
 * Reads the _model_reference section and shows a diff of what would change.
 * Pass --apply to write the changes.
 *
 * Flags:
 *   --apply   Actually write updated model names to agent-registry.json
 */

import fs from 'fs';
import path from 'path';

interface AgentEntry {
  role: string;
  default_model: string;
  escalation_model: string;
  [key: string]: unknown;
}

interface Registry {
  _model_reference: Record<string, string>;
  agents: AgentEntry[];
  utility_models: Record<string, string>;
  [key: string]: unknown;
}

export async function modelUpdateCommand(args: string[]): Promise<void> {
  const apply = args.includes('--apply');
  const registryPath = path.join(process.cwd(), 'agent-registry.json');

  if (!fs.existsSync(registryPath)) {
    console.error(`No agent-registry.json found at ${registryPath}`);
    process.exit(1);
  }

  const raw = await fs.promises.readFile(registryPath, 'utf-8');
  const registry: Registry = JSON.parse(raw);
  const refs = registry._model_reference;

  if (!refs || typeof refs !== 'object') {
    console.error('No _model_reference section found in registry');
    process.exit(1);
  }

  // Build alias→full map from _model_reference
  // The reference maps short names like "haiku", "sonnet", "opus" to full model IDs
  const aliasMap = new Map<string, string>();
  for (const [alias, fullName] of Object.entries(refs)) {
    if (alias.startsWith('_')) continue;
    aliasMap.set(alias, fullName);
  }

  // Also build reverse: full→short for detecting when a full model name could be updated
  const fullToAlias = new Map<string, string>();
  for (const [alias, fullName] of aliasMap) {
    fullToAlias.set(fullName, alias);
  }

  const changes: Array<{ location: string; from: string; to: string }> = [];

  // Check agents
  for (const agent of registry.agents) {
    for (const field of ['default_model', 'escalation_model'] as const) {
      const current = agent[field];
      // Check if it matches an alias (shouldn't normally, but handle it)
      if (aliasMap.has(current)) {
        const resolved = aliasMap.get(current)!;
        if (resolved !== current) {
          changes.push({ location: `agents.${agent.role}.${field}`, from: current, to: resolved });
          if (apply) agent[field] = resolved;
        }
      }
      // Check if the current full name differs from what the alias resolves to
      const alias = fullToAlias.get(current);
      if (!alias) {
        // current model not in reference — check if a short prefix matches
        for (const [a, full] of aliasMap) {
          if (current.includes(a) && current !== full) {
            changes.push({ location: `agents.${agent.role}.${field}`, from: current, to: full });
            if (apply) agent[field] = full;
            break;
          }
        }
      }
    }
  }

  // Check utility models
  for (const [key, current] of Object.entries(registry.utility_models)) {
    if (aliasMap.has(current)) {
      const resolved = aliasMap.get(current)!;
      if (resolved !== current) {
        changes.push({ location: `utility_models.${key}`, from: current, to: resolved });
        if (apply) registry.utility_models[key] = resolved;
      }
    }
  }

  if (changes.length === 0) {
    console.log('All models are up to date — no changes needed.');
    return;
  }

  console.log(`\n${changes.length} model reference(s) ${apply ? 'updated' : 'would change'}:\n`);
  for (const c of changes) {
    console.log(`  ${c.location}`);
    console.log(`    ${c.from} → ${c.to}`);
  }

  if (apply) {
    await fs.promises.writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
    console.log(`\nWrote updated agent-registry.json`);
  } else {
    console.log(`\nRun with --apply to write changes.`);
  }
}
