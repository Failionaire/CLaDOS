/**
 * Go Test Executor
 *
 * Runs go test in the project directory.
 */

import { spawn } from 'node:child_process';
import type { TestExecutor, TestResult } from './test-executor.js';

export class GoExecutor implements TestExecutor {
  name = 'Go (go test)';
  language = 'go';

  async setup(projectDir: string): Promise<void> {
    await this.exec('go', ['mod', 'tidy'], projectDir);
  }

  async run(projectDir: string): Promise<TestResult> {
    const { stdout, stderr, code } = await this.exec('go', ['test', '-v', '-count=1', './...'], projectDir);
    const output = stdout + '\n' + stderr;

    // Parse go test output: ok/FAIL lines and --- PASS/FAIL lines
    const passLines = (output.match(/--- PASS/g) ?? []).length;
    const failLines = (output.match(/--- FAIL/g) ?? []).length;
    const skipLines = (output.match(/--- SKIP/g) ?? []).length;
    const total = passLines + failLines + skipLines;

    return { passed: code === 0, total, failures: failLines, skipped: skipLines, output };
  }

  async teardown(_projectDir: string): Promise<void> {
    // No-op
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
