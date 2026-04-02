/**
 * CLaDOS CLI entry point.
 * Run `node bin/clados.js` — opens the browser to the project picker UI.
 * Subcommands:
 *   clados doctor [project-dir]
 *   clados logs [project-dir] [--agent X] [--phase N] [--event X] [--since ISO] [--errors] [--raw]
 *   clados model-update [--apply]
 */

import { createExpressApp, findFreePort } from './server.js';
import { runDoctor, formatDoctorResult } from './doctor.js';
import { logsCommand } from './cli/logs.js';
import { modelUpdateCommand } from './cli/model-update.js';
import { workflowCommand } from './cli/workflow.js';
import { agentCommand } from './cli/agent.js';
import { continueCommand } from './cli/continue.js';
import { templateCommand } from './cli/template.js';
import { costCommand } from './cli/cost.js';

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

// ─── Subcommand: doctor ───────────────────────────────────────────────────────

async function doctorCommand(args: string[]): Promise<void> {
  const projectDir = args[0] ?? process.cwd();
  const result = await runDoctor(projectDir);
  console.log(formatDoctorResult(result));
  process.exit(result.valid ? 0 : 1);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const subcommand = process.argv[2];

  if (subcommand === 'doctor') {
    await doctorCommand(process.argv.slice(3));
    return;
  }

  if (subcommand === 'logs') {
    await logsCommand(process.argv.slice(3));
    return;
  }

  if (subcommand === 'model-update') {
    await modelUpdateCommand(process.argv.slice(3));
    return;
  }

  if (subcommand === 'workflow') {
    await workflowCommand(process.argv.slice(3));
    return;
  }

  if (subcommand === 'agent') {
    await agentCommand(process.argv.slice(3));
    return;
  }

  if (subcommand === 'continue') {
    await continueCommand(process.argv.slice(3));
    return;
  }

  if (subcommand === 'template') {
    await templateCommand(process.argv.slice(3));
    return;
  }

  if (subcommand === 'cost') {
    await costCommand(process.argv.slice(3));
    return;
  }

  if (subcommand === 'help' || subcommand === '--help') {
    console.log(`
CLaDOS — AI code generation pipeline

Usage: clados [subcommand] [options]

Subcommands:
  (none)          Start the CLaDOS server and open the UI
  doctor [dir]    Validate session state integrity
  logs [dir]      View filtered run.log entries
  model-update    Check/apply model reference updates in agent-registry.json
  workflow        Show or validate a workflow graph
  agent           Add, list, remove, or test custom agents
  continue <dir>  Re-invoke a completed project with changes
  template        Manage project templates (list, use, save)
  cost <dir>      Show detailed cost breakdown for a project
  help            Show this help message
`);
    return;
  }

  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const projectsRoot = process.cwd();

  const httpServer = createExpressApp({ apiKey, projectsRoot });
  const port = await findFreePort(3100, 3199);
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));

  const url = `http://localhost:${port}`;
  console.log(`\nCLaDOS running at ${url}`);
  console.log(`Projects root: ${projectsRoot}`);
  console.log('Press Ctrl+C to stop.\n');

  try {
    const { default: open } = await import('open');
    await open(url);
  } catch { /* non-fatal — user can open manually */ }

  process.once('SIGINT', () => {
    console.log('\nShutting down…');
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

main().catch((err) => {
  console.error('\nFatal error:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
