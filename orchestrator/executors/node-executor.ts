/**
 * Node.js Test Executor
 *
 * Runs npm test in the project directory.
 * Parses Jest/Vitest output for structured results.
 */

import { spawn } from 'node:child_process';
import type { TestExecutor, TestResult } from './test-executor.js';

export class NodeExecutor implements TestExecutor {
  name = 'Node.js (npm test)';
  language = 'typescript';

  async setup(projectDir: string): Promise<void> {
    await this.exec('npm', ['ci', '--ignore-scripts'], projectDir);
  }

  async run(projectDir: string): Promise<TestResult> {
    const { stdout, stderr, code } = await this.exec('npm', ['test', '--', '--forceExit'], projectDir);
    const output = stdout + '\n' + stderr;

    // Parse Jest-style summary: Tests: X passed, Y failed, Z total
    const summaryMatch = output.match(/Tests:\s+(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+skipped,\s*)?(\d+)\s+passed,\s+(\d+)\s+total/i);
    if (summaryMatch) {
      const failures = parseInt(summaryMatch[1] ?? '0', 10);
      const skipped = parseInt(summaryMatch[2] ?? '0', 10);
      const total = parseInt(summaryMatch[4] ?? '0', 10);
      return { passed: code === 0, total, failures, skipped, output };
    }

    return { passed: code === 0, total: 0, failures: code === 0 ? 0 : 1, skipped: 0, output };
  }

  async teardown(_projectDir: string): Promise<void> {
    // No-op for Node.js — containers handled separately
  }

  private exec(cmd: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, { cwd, shell: true, stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => { stderr += d; });
      proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    });
  }
}
