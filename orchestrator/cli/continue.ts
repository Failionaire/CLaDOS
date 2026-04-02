/**
 * CLI subcommand: clados continue
 *
 * Usage: clados continue <project-dir> [change description]
 *
 * Re-enters the pipeline for an already-completed project.
 * Runs delta detection to classify the entry phase, then
 * starts the server and opens the UI with a re-invocation gate.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export async function continueCommand(args: string[]): Promise<void> {
  const projectDir = args[0];
  if (!projectDir) {
    console.error('Usage: clados continue <project-dir> [change description...]');
    process.exit(1);
  }

  const resolvedDir = path.resolve(projectDir);
  const statePath = path.join(resolvedDir, '.clados', '00-session-state.json');

  if (!fs.existsSync(statePath)) {
    console.error(`No CLaDOS session found at ${resolvedDir}`);
    console.error('Make sure the path points to a project with a .clados/ directory.');
    process.exit(1);
  }

  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  if (state.pipeline_status !== 'complete') {
    console.error(`Project status is "${state.pipeline_status}" — continue only works on completed projects.`);
    console.error('If the project is in progress, use the normal `clados` command.');
    process.exit(1);
  }

  const changeDescription = args.slice(1).join(' ') || '';

  if (!changeDescription) {
    console.log('\nProject is complete. Describe the changes you want to make:');
    console.log('  clados continue ./myproject "Add rate limiting to the API"');
    console.log('\nOr start the server and describe changes in the UI re-invocation gate.');
  }

  // Set environment variables for the server to pick up
  process.env.CLADOS_REINVOKE_PROJECT = resolvedDir;
  if (changeDescription) {
    process.env.CLADOS_REINVOKE_CHANGE = changeDescription;
  }

  console.log(`\nRe-invoking project: ${resolvedDir}`);
  if (changeDescription) {
    console.log(`Change: ${changeDescription}`);
  }
  console.log('Starting server with re-invocation mode...\n');

  // Import and start the server (same as default CLI path but with reinvoke env vars set)
  const { createExpressApp, findFreePort } = await import('../server.js');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable required.');
    process.exit(1);
  }

  const httpServer = createExpressApp({ apiKey, projectsRoot: path.dirname(resolvedDir) });
  const port = await findFreePort(3100, 3199);
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));

  const url = `http://localhost:${port}`;
  console.log(`CLaDOS running at ${url} (re-invocation mode)`);

  try {
    const { default: open } = await import('open');
    await open(url);
  } catch { /* non-fatal */ }

  process.once('SIGINT', () => {
    console.log('\nShutting down…');
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
