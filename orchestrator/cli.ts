/**
 * CLaDOS CLI entry point.
 * Handles `clados new <name>` and `clados resume <name>` commands.
 */

import path from 'path';
import fs from 'fs';
import readline from 'readline';

import type { SessionConfig, ProjectType } from './types.js';
import { SessionManager } from './session.js';
import { Logger } from './logger.js';
import { Conductor } from './conductor.js';
import { createExpressApp, findFreePort } from './server.js';

// ─── Validation ───────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`\nError: Environment variable ${key} is required.\n`);
    console.error(`  Set it with: export ${key}=your_api_key\n`);
    process.exit(1);
  }
  return val;
}

function printUsage(): void {
  console.log(`
Usage:
  npx clados new <project-name>      Create a new project and start the pipeline
  npx clados resume <project-name>   Resume a stopped or crashed project
`);
}

// ─── Command: new ────────────────────────────────────────────────────────────

async function handleNew(projectName: string): Promise<void> {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const cwd = process.cwd();
  const projectDir = path.resolve(cwd, projectName);

  if (fs.existsSync(projectDir)) {
    console.error(`\nError: Directory "${projectName}" already exists. Use "clados resume ${projectName}" to continue.\n`);
    process.exit(1);
  }

  // Collect setup inputs before creating any files — so Ctrl+C during prompts
  // leaves no orphaned directory that blocks a subsequent `clados new`.
  const config = await promptSetup();

  console.log(`\nCreating project: ${projectName}`);
  await fs.promises.mkdir(projectDir, { recursive: true });

  const session = new SessionManager();
  try {
    await session.init(projectDir, projectName, config);
  } catch (err) {
    // session.init failed before any valid state was written — clean up so the
    // user can retry `clados new` without hitting "directory already exists".
    try { await fs.promises.rm(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }

  const logger = new Logger(projectDir);
  await startServer(projectDir, projectName, apiKey, session, logger, true);
}

// ─── Command: resume ─────────────────────────────────────────────────────────

async function handleResume(projectName: string): Promise<void> {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const cwd = process.cwd();
  const projectDir = path.resolve(cwd, projectName);
  const stateFile = path.join(projectDir, '.clados', '00-session-state.json');

  if (!fs.existsSync(stateFile)) {
    console.error(`\nError: No session state found at "${projectDir}/.clados/". Is this a valid CLaDOS project?\n`);
    process.exit(1);
  }

  const session = new SessionManager();
  const state = await session.read(projectDir);
  const logger = new Logger(projectDir);
  logger.info('cli.resume', `Resuming project (status: ${state.pipeline_status})`);

  await startServer(projectDir, projectName, apiKey, session, logger, false);
}

// ─── Pipeline run loop ────────────────────────────────────────────────────────

async function runPipelineLoop(conductor: Conductor, projectDir: string, logger: Logger): Promise<void> {
  let keepRunning = true;
  while (keepRunning) {
    try {
      await conductor.runPipeline(projectDir);
      keepRunning = false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'PIPELINE_ABANDONED') {
        console.log('\nProject abandoned.');
        keepRunning = false;
      } else if (msg.startsWith('GOTO_PHASE_')) {
        // runPipeline re-reads current_phase from session state — just loop
        continue;
      } else {
        logger.error('cli.pipeline_error', msg, {
          stack: err instanceof Error ? err.stack : undefined,
        });
        console.error('\nPipeline error:', msg);
        keepRunning = false;
      }
    }
  }
}

// ─── Server startup ───────────────────────────────────────────────────────────

async function startServer(
  projectDir: string,
  projectName: string,
  apiKey: string,
  session: SessionManager,
  logger: Logger,
  isNew: boolean,
): Promise<void> {
  const conductor = new Conductor(
    apiKey,
    session,
    logger,
    () => { /* no-op; real broadcast wired by createExpressApp via setBroadcast */ },
  );

  await conductor.init();

  const serverCtx = { conductor, session, logger, projectDir };
  const httpServer = createExpressApp(serverCtx);

  const port = await findFreePort(3100, 3199);

  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));

  const url = `http://localhost:${port}`;
  console.log(`\nCLaDOS running at ${url}`);
  console.log(`Project: ${projectName}`);
  console.log('Press Ctrl+C to stop.\n');

  // Open browser
  try {
    const { default: open } = await import('open');
    await open(url);
  } catch { /* non-fatal — user can open manually */ }

  // Graceful shutdown — process.once prevents stacking if startServer is ever re-called
  process.once('SIGINT', async () => {
    logger.info('cli.shutdown', 'SIGINT received — shutting down');
    try {
      const state = await session.read(projectDir);
      if (state.pipeline_status === 'agent_running' || state.pipeline_status === 'gate_pending') {
        // Preserve status for resume
        logger.info('cli.shutdown', `Preserving pipeline_status: ${state.pipeline_status}`);
      }
    } catch { /* ignore */ }
    httpServer.close(() => process.exit(0));
    // Ensure exit even if live WebSocket connections prevent close() from draining
    setTimeout(() => process.exit(0), 3000).unref();
  });

  // Start the pipeline
  if (!isNew) {
    const state = await session.read(projectDir);
    if (state.pipeline_status === 'complete') {
      console.log('This project is complete. All phases have been approved.');
      return;
    } else if (state.pipeline_status === 'abandoned') {
      console.log('This project was previously abandoned. Restart to re-run from the last gate.');
      return;
    }
  }

  await runPipelineLoop(conductor, projectDir, logger);
}

// ─── Interactive setup prompt ─────────────────────────────────────────────────

async function promptSetup(): Promise<SessionConfig> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

  console.log('\n── CLaDOS Project Setup ──────────────────────────────────────\n');

  // Re-prompt until a non-empty idea is given
  let idea = '';
  while (!idea) {
    idea = (await ask('Describe your project idea:\n> ')).trim();
    if (!idea) console.log('Project idea cannot be empty. Please try again.');
  }

  console.log('\nProject type:');
  console.log('  1. backend-only');
  console.log('  2. full-stack');
  console.log('  3. cli-tool');
  console.log('  4. library');
  const typeChoice = await ask('Select (1-4): ');
  const projectTypes: ProjectType[] = ['backend-only', 'full-stack', 'cli-tool', 'library'];
  const selectedType = projectTypes[parseInt(typeChoice, 10) - 1];
  if (!selectedType) {
    console.log('Invalid selection — defaulting to "backend-only".');
  }
  const projectType: ProjectType = selectedType ?? 'backend-only';

  console.log('\nOptional agents (press Enter to skip):');
  const securityRaw = await ask('Enable Security agent? (y/N): ');
  const wreckerRaw = await ask('Enable Wrecker agent? (y/N): ');
  const complexityRaw = await ask('Flag as high-complexity project? Escalates all agents to Opus immediately. (y/N): ');

  const spendCapRaw = await ask('\nSpend cap in USD (optional, press Enter to skip): $');

  rl.close();

  const trimmedCap = spendCapRaw.trim();
  const parsedCap = parseFloat(trimmedCap);
  const spend_cap = trimmedCap && !isNaN(parsedCap) && parsedCap > 0 ? parsedCap : null;
  if (trimmedCap && spend_cap === null) {
    console.log('Invalid spend cap — no budget limit will be enforced.');
  }

  console.log('\n──────────────────────────────────────────────────────────────\n');

  return {
    project_type: projectType,
    idea,
    security_enabled: securityRaw.trim().toLowerCase() === 'y',
    wrecker_enabled: wreckerRaw.trim().toLowerCase() === 'y',
    is_high_complexity: complexityRaw.trim().toLowerCase() === 'y',
    spend_cap,
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const projectName = args[1];

  if (!command || !projectName) {
    printUsage();
    process.exit(0);
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
    console.error('\nError: Project name may only contain letters, numbers, hyphens, and underscores.\n');
    process.exit(1);
  }

  switch (command) {
    case 'new':
      await handleNew(projectName);
      break;
    case 'resume':
      await handleResume(projectName);
      break;
    default:
      console.error(`\nUnknown command: ${command}\n`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nFatal error:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
