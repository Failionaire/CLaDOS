/**
 * CLaDOS CLI entry point.
 * Handles `clados new <name>` and `clados resume <name>` commands.
 */

import path from 'path';
import fs from 'fs';

import type { SessionConfig } from './types.js';
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
  node bin/clados.js new <project-name>      Create a new project and start the pipeline
  node bin/clados.js resume <project-name>   Resume a stopped or crashed project
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

  console.log(`\nCreating project: ${projectName}`);
  await fs.promises.mkdir(projectDir, { recursive: true });

  // Initialize with a placeholder config (pipeline_status: 'idle').
  // The real config is provided by the user through the Phase 0 setup screen via POST /project/new.
  const placeholderConfig: SessionConfig = {
    project_type: 'backend-only',
    idea: '',
    security_enabled: false,
    wrecker_enabled: false,
    is_high_complexity: false,
    spend_cap: null,
  };

  const session = new SessionManager();
  try {
    await session.init(projectDir, projectName, placeholderConfig);
  } catch (err) {
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

  // For new projects, create a deferred promise that resolves when POST /project/new is received.
  let setupResolve: (() => void) | undefined;
  const setupPromise: Promise<void> | undefined = isNew
    ? new Promise<void>((resolve) => { setupResolve = resolve; })
    : undefined;

  const serverCtx = { conductor, session, logger, projectDir, setupResolver: setupResolve };
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

  // For new projects, wait for the Phase 0 setup screen to be submitted before running.
  if (setupPromise) {
    console.log('Open the browser to complete project setup.');
    await setupPromise;
  }

  await runPipelineLoop(conductor, projectDir, logger);
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
