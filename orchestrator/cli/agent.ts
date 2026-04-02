/**
 * CLI subcommand: clados agent
 *
 * Usage:
 *   clados agent add --name "my-reviewer" --mode reviewer --phase 2
 *   clados agent list
 *   clados agent remove <name>
 *   clados agent test <name> [project-dir]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const REGISTRY_FILE = 'agent-registry.json';
const CUSTOM_AGENTS_DIR = 'agents/custom';

function resolveRegistryPath(): string {
  // Walk up from this file's directory to find agent-registry.json
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, REGISTRY_FILE);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  console.error(`Could not find ${REGISTRY_FILE}`);
  process.exit(1);
}

function resolveProjectRoot(registryPath: string): string {
  return path.dirname(registryPath);
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith('--') && i + 1 < args.length) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];
      if (nextArg !== undefined) {
        result[key] = nextArg;
        i++;
      }
    } else if (!arg.startsWith('--')) {
      result['_positional'] = arg;
    }
  }
  return result;
}

// ─── Scaffold prompt template ─────────────────────────────────────────────────

function scaffoldPrompt(name: string, mode: string, phase: number): string {
  const roleDesc = mode === 'reviewer'
    ? 'You review code and report issues in freeform markdown.'
    : 'You perform a specialized task in the pipeline.';

  return `## Identity

You are the ${name} agent for CLaDOS. ${roleDesc}

## Inputs

- List required context artifacts here

## Task

Describe what this agent should do.

## Output

${mode === 'reviewer'
    ? 'Write your review as freeform markdown. The findings adapter will convert it to structured findings.'
    : `Write your output using \`write_file\` to \`.clados/0${phase}-${name}.json\`.`}

## Constraints

- Stay focused on your specific responsibility
- Do not modify files outside your designated output path
`;
}

// ─── Subcommands ──────────────────────────────────────────────────────────────

function addAgent(args: string[]): void {
  const parsed = parseArgs(args);
  const name = parsed['name'];
  const mode = parsed['mode'] ?? 'agent';
  const phaseStr = parsed['phase'];

  if (!name) {
    console.error('Required: --name <agent-name>');
    console.error('Usage: clados agent add --name "my-agent" --mode reviewer|agent --phase N');
    process.exit(1);
  }
  if (mode !== 'reviewer' && mode !== 'agent') {
    console.error('--mode must be "reviewer" or "agent"');
    process.exit(1);
  }
  if (!phaseStr || isNaN(Number(phaseStr))) {
    console.error('Required: --phase <number>');
    process.exit(1);
  }

  const phase = Number(phaseStr);
  const registryPath = resolveRegistryPath();
  const projectRoot = resolveProjectRoot(registryPath);
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));

  // Check for duplicate name
  const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const existing = registry.agents.find((a: { role: string }) => a.role === safeName);
  if (existing) {
    console.error(`Agent "${safeName}" already exists in the registry.`);
    process.exit(1);
  }

  // Create custom agents directory
  const customDir = path.join(projectRoot, CUSTOM_AGENTS_DIR);
  if (!fs.existsSync(customDir)) {
    fs.mkdirSync(customDir, { recursive: true });
  }

  // Write prompt file
  const promptPath = path.join(customDir, `${safeName}.md`);
  fs.writeFileSync(promptPath, scaffoldPrompt(safeName, mode, phase));

  // Add to registry
  const entry = {
    role: safeName,
    system_prompt: `${CUSTOM_AGENTS_DIR}/${safeName}.md`,
    default_model: registry._model_reference?.haiku ?? 'claude-haiku-4-5-20251001',
    escalation_model: registry._model_reference?.sonnet ?? 'claude-sonnet-4-6',
    tools: ['read_file', 'write_file'],
    enabled_when: 'always',
    context_artifacts: [],
    system_prompt_tokens: null,
    expected_output_tokens_per_turn: 3000,
    expected_tool_turns: 1,
    source: 'custom',
    custom_mode: mode,
    custom_phase: phase,
  };

  registry.agents.push(entry);
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');

  console.log(`✓ Created custom ${mode} agent "${safeName}" for phase ${phase}`);
  console.log(`  Prompt: ${promptPath}`);
  console.log(`  Edit the prompt file, then run: clados agent test ${safeName}`);
}

function listAgents(): void {
  const registryPath = resolveRegistryPath();
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));

  console.log('\nRegistered agents:\n');
  console.log('  Name            Source    Mode       Phase  Enabled');
  console.log('  ──────────────  ────────  ─────────  ─────  ───────────────');

  for (const agent of registry.agents) {
    const name = (agent.role as string).padEnd(14);
    const source = (agent.source ?? 'built-in').padEnd(8);
    const mode = (agent.custom_mode ?? '—').padEnd(9);
    const phase = agent.custom_phase !== undefined ? String(agent.custom_phase).padEnd(5) : '—    ';
    const enabled = agent.enabled_when;
    console.log(`  ${name}  ${source}  ${mode}  ${phase}  ${enabled}`);
  }
  console.log();
}

function removeAgent(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: clados agent remove <name>');
    process.exit(1);
  }

  const registryPath = resolveRegistryPath();
  const projectRoot = resolveProjectRoot(registryPath);
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));

  const index = registry.agents.findIndex((a: { role: string; source?: string }) =>
    a.role === name && a.source === 'custom'
  );

  if (index === -1) {
    console.error(`Custom agent "${name}" not found. (Built-in agents cannot be removed.)`);
    process.exit(1);
  }

  const agent = registry.agents[index];
  registry.agents.splice(index, 1);
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');

  // Archive the prompt file
  const promptPath = path.join(projectRoot, agent.system_prompt);
  if (fs.existsSync(promptPath)) {
    const archivePath = promptPath + '.archived';
    fs.renameSync(promptPath, archivePath);
    console.log(`✓ Removed agent "${name}" and archived prompt to ${archivePath}`);
  } else {
    console.log(`✓ Removed agent "${name}" from registry.`);
  }
}

async function testAgent(args: string[]): Promise<void> {
  const name = args[0];
  const projectDir = args[1] ?? process.cwd();

  if (!name) {
    console.error('Usage: clados agent test <name> [project-dir]');
    process.exit(1);
  }

  const registryPath = resolveRegistryPath();
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  const agent = registry.agents.find((a: { role: string }) => a.role === name);

  if (!agent) {
    console.error(`Agent "${name}" not found in registry.`);
    process.exit(1);
  }

  console.log(`\nDry-run test for agent "${name}":\n`);
  console.log(`  Mode:    ${agent.custom_mode ?? 'built-in'}`);
  console.log(`  Phase:   ${agent.custom_phase ?? '(hardcoded)'}`);
  console.log(`  Model:   ${agent.default_model}`);
  console.log(`  Prompt:  ${agent.system_prompt}`);
  console.log(`  Tools:   ${agent.tools.join(', ')}`);

  const projectRoot = resolveProjectRoot(registryPath);
  const promptPath = path.join(projectRoot, agent.system_prompt);
  if (fs.existsSync(promptPath)) {
    const prompt = fs.readFileSync(promptPath, 'utf-8');
    console.log(`\n─── Prompt preview (first 500 chars) ───\n`);
    console.log(prompt.slice(0, 500));
    if (prompt.length > 500) console.log('\n  ... (truncated)');
  } else {
    console.log(`\n  Warning: Prompt file not found at ${promptPath}`);
  }

  console.log(`\nNote: Full dry-run dispatch requires a running CLaDOS session.`);
  console.log(`Start a session and use the UI to test agent dispatch.\n`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function agentCommand(args: string[]): Promise<void> {
  const action = args[0];

  switch (action) {
    case 'add':
      addAgent(args.slice(1));
      break;
    case 'list':
      listAgents();
      break;
    case 'remove':
      removeAgent(args.slice(1));
      break;
    case 'test':
      await testAgent(args.slice(1));
      break;
    default:
      console.error('Usage: clados agent <add|list|remove|test>');
      console.error('  add    --name <name> --mode reviewer|agent --phase N');
      console.error('  list   Show all registered agents');
      console.error('  remove <name>  Remove a custom agent');
      console.error('  test   <name>  Dry-run test a custom agent');
      process.exit(1);
  }
}
