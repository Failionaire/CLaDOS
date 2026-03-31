/**
 * CLaDOS CLI entry point.
 * Run `node bin/clados.js` — opens the browser to the project picker UI.
 */

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

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
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
