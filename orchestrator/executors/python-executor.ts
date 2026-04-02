/**
 * Python Test Executor
 *
 * Runs pytest in the project directory.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestExecutor, TestResult } from './test-executor.js';

export class PythonExecutor implements TestExecutor {
  name = 'Python (pytest)';
  language = 'python';

  async setup(projectDir: string): Promise<void> {
    const reqPath = path.join(projectDir, 'requirements.txt');
    if (fs.existsSync(reqPath)) {
      await this.exec('pip', ['install', '-r', 'requirements.txt'], projectDir);
    }
    const pyprojectPath = path.join(projectDir, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
      await this.exec('pip', ['install', '-e', '.'], projectDir);
    }
  }

  async run(projectDir: string): Promise<TestResult> {
    const { stdout, stderr, code } = await this.exec('python', ['-m', 'pytest', '-v', '--tb=short'], projectDir);
    const output = stdout + '\n' + stderr;

    // Parse pytest summary: X passed, Y failed, Z skipped
    const summaryMatch = output.match(/(\d+)\s+passed(?:,\s+(\d+)\s+failed)?(?:,\s+(\d+)\s+skipped)?/i);
    if (summaryMatch) {
      const passed = parseInt(summaryMatch[1] ?? '0', 10);
      const failures = parseInt(summaryMatch[2] ?? '0', 10);
      const skipped = parseInt(summaryMatch[3] ?? '0', 10);
      return { passed: code === 0, total: passed + failures + skipped, failures, skipped, output };
    }

    return { passed: code === 0, total: 0, failures: code === 0 ? 0 : 1, skipped: 0, output };
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
