/**
 * Test Runner — sandboxed test execution subagent.
 *
 * Deterministic setup sequence:
 *   1. npm install
 *   2. docker-compose.test.yml up -d (if present), wait for health checks
 *   3. Load .env.test
 *   4. Start the server via test-context.json startup_command, wait for port
 *   5. Run the test suite (timeout: configurable, default 120s)
 *   6. Teardown: stop server, docker compose down
 *
 * Produces: .clados/02-build/test-runner.json
 */

import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import net from 'net';
import writeFileAtomic from 'write-file-atomic';
import type { TestRunnerResult } from '../../orchestrator/types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const DOCKER_HEALTH_TIMEOUT_MS = 60_000;
const DOCKER_HEALTH_POLL_MS = 2_000;

interface TestContext {
  base_url: string;
  auth?: unknown;
  seed_strategy?: string;
  startup_command: string;
  env_vars: string[];
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function parseEnvFile(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  const result: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = value;
  }
  return result;
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ host, port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on('error', () => resolve(false));
    });
    if (open) return;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`Server did not start on ${host}:${port} within ${timeoutMs}ms`);
}

function extractPortFromUrl(url: string): number {
  try {
    return parseInt(new URL(url).port ?? '3000', 10) || 3000;
  } catch {
    return 3000;
  }
}

function spawnProcess(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): ChildProcess {
  return spawn(cmd, args, {
    cwd,
    env: { ...env },  // Only .env.test — isolated from parent process env
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawnProcess(cmd, args, cwd, env);
    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ stdout, stderr, code: -1 });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

// ─── Test result parsing ──────────────────────────────────────────────────────

function parseTapLikeOutput(stdout: string): {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: Array<{ test: string; message: string }>;
} {
  // Attempt to parse standard Jest/Vitest JSON output (--json flag)
  try {
    const json = JSON.parse(stdout) as {
      numTotalTests?: number;
      numPassedTests?: number;
      numFailedTests?: number;
      numPendingTests?: number;
      testResults?: Array<{
        testFilePath: string;
        testResults?: Array<{ fullName: string; failureMessages: string[]; status: string }>;
      }>;
    };
    const failures: Array<{ test: string; message: string }> = [];
    for (const suite of json.testResults ?? []) {
      for (const test of suite.testResults ?? []) {
        if (test.status === 'failed') {
          failures.push({ test: test.fullName, message: test.failureMessages.join('\n') });
        }
      }
    }
    return {
      total: json.numTotalTests ?? 0,
      passed: json.numPassedTests ?? 0,
      failed: json.numFailedTests ?? 0,
      skipped: json.numPendingTests ?? 0,
      failures,
    };
  } catch { /* not JSON */ }

  // Fallback: look for TAP-like summary lines
  const totalMatch = stdout.match(/(\d+) tests? total/i);
  const passedMatch = stdout.match(/(\d+) passed/i);
  const failedMatch = stdout.match(/(\d+) failed/i);
  const skippedMatch = stdout.match(/(\d+) skipped/i);

  return {
    total: parseInt(totalMatch?.[1] ?? '0', 10),
    passed: parseInt(passedMatch?.[1] ?? '0', 10),
    failed: parseInt(failedMatch?.[1] ?? '0', 10),
    skipped: parseInt(skippedMatch?.[1] ?? '0', 10),
    failures: [],
  };
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function runTestRunner(
  projectDir: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  wreckerOnly = false,
): Promise<TestRunnerResult> {
  const claDosDir = path.join(projectDir, '.clados');
  const testContextPath = path.join(claDosDir, '02-build', 'test-context.json');
  const dockerComposePath = path.join(projectDir, 'infra', 'docker-compose.test.yml');
  const envTestPath = path.join(projectDir, '.env.test');

  // Read test context
  const testContext: TestContext = JSON.parse(fs.readFileSync(testContextPath, 'utf-8'));
  const env = parseEnvFile(envTestPath);

  // Host tools (npm, docker) need PATH to find their executables.
  // Only the server under test uses the isolated env (no parent-process vars).
  const hostEnv = { PATH: process.env['PATH'] ?? '', ...env };

  let serverProc: ChildProcess | null = null;
  let dockerStarted = false;

  try {
    // Step 1: npm install
    const installResult = await runCommand('npm', ['install'], projectDir, { ...process.env as Record<string, string>, ...env });
    if (installResult.code !== 0) {
      throw new Error(`npm install failed:\n${installResult.stderr}`);
    }

    // Step 2: Docker compose (if present)
    if (fs.existsSync(dockerComposePath)) {
      const dockerResult = await runCommand(
        'docker',
        ['compose', '-f', dockerComposePath, 'up', '-d'],
        projectDir,
        hostEnv,
        DOCKER_HEALTH_TIMEOUT_MS,
      );
      if (dockerResult.code !== 0) {
        throw new Error(`docker compose up failed:\n${dockerResult.stderr}`);
      }
      dockerStarted = true;

      // Wait for health checks
      const deadline = Date.now() + DOCKER_HEALTH_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const health = await runCommand(
          'docker', ['compose', '-f', dockerComposePath, 'ps', '--format', 'json'],
          projectDir, hostEnv, 10_000,
        );
        if (health.stdout.includes('"healthy"') || health.stdout.includes('(healthy)')) break;
        if (Date.now() + DOCKER_HEALTH_POLL_MS > deadline) {
          throw new Error('Docker health checks timed out');
        }
        await new Promise((res) => setTimeout(res, DOCKER_HEALTH_POLL_MS));
      }
    } else if (testContext.env_vars.includes('DATABASE_URL')) {
      throw new Error('Tests require a database but no docker-compose.test.yml was generated');
    }

    // Step 3: Start server
    const [serverCmd, ...serverArgs] = testContext.startup_command.split(' ');
    // Use hostEnv so the server process can find its binary on PATH
    serverProc = spawnProcess(serverCmd!, serverArgs, projectDir, hostEnv);

    const port = extractPortFromUrl(testContext.base_url);
    await waitForPort('localhost', port, SERVER_STARTUP_TIMEOUT_MS);

    // Step 4: Run tests
    // Determine test directory: full-stack projects use Playwright (tests/e2e),
    // all other types use Supertest (tests/integration).
    let isFullStack = false;
    try {
      const sessionStatePath = path.join(projectDir, '.clados', '00-session-state.json');
      const sessionState = JSON.parse(fs.readFileSync(sessionStatePath, 'utf-8')) as { config?: { project_type?: string } };
      isFullStack = sessionState.config?.project_type === 'full-stack';
    } catch { /* if unreadable, default to integration */ }
    const testPattern = wreckerOnly
      ? 'tests/adversarial'
      : isFullStack ? 'tests/e2e' : 'tests/integration';
    const testArgs = ['test', '--', '--testPathPattern', testPattern, '--json'];
    const start = Date.now();

    const testResult = await runCommand('npm', testArgs, projectDir, hostEnv, timeoutMs);
    const duration = Date.now() - start;

    const parsed = parseTapLikeOutput(testResult.stdout);
    const passed = testResult.code === 0 || parsed.failed === 0;

    const result: TestRunnerResult = {
      passed,
      total: parsed.total,
      passed_count: parsed.passed,
      failed_count: parsed.failed,
      skipped_count: parsed.skipped,
      duration_ms: duration,
      failures: parsed.failures,
    };

    // Write output
    const outputPath = path.join(claDosDir, '02-build', 'test-runner.json');
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

    if (wreckerOnly) {
      // Merge into existing test-runner.json under wrecker_tests key
      let existing: TestRunnerResult = { passed: false, total: 0, passed_count: 0, failed_count: 0, skipped_count: 0, duration_ms: 0, failures: [] };
      if (fs.existsSync(outputPath)) {
        existing = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
      }
      const merged = { ...existing, wrecker_tests: {
        passed: result.passed,
        total: result.total,
        passed_count: result.passed_count,
        failed_count: result.failed_count,
        failures: result.failures,
      }};
      await writeFileAtomic(outputPath, JSON.stringify(merged, null, 2), { encoding: 'utf8' });
      return merged;
    }

    await writeFileAtomic(outputPath, JSON.stringify(result, null, 2), { encoding: 'utf8' });
    return result;

  } finally {
    // Teardown
    if (serverProc) {
      serverProc.kill('SIGTERM');
    }
    if (dockerStarted) {
      await runCommand(
        'docker', ['compose', '-f', dockerComposePath, 'down'],
        projectDir, hostEnv, 30_000,
      ).catch(() => { /* best-effort */ });
    }
  }
}
