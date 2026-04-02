/**
 * Test Executor Registry
 *
 * Selects the appropriate TestExecutor based on the stack manifest's
 * language field.
 */

import type { TestExecutor } from './test-executor.js';
import { NodeExecutor } from './node-executor.js';
import { PythonExecutor } from './python-executor.js';
import { GoExecutor } from './go-executor.js';

const executors: Record<string, () => TestExecutor> = {
  typescript: () => new NodeExecutor(),
  javascript: () => new NodeExecutor(),
  python: () => new PythonExecutor(),
  go: () => new GoExecutor(),
};

/**
 * Get a TestExecutor for the given language.
 * Returns null if no executor exists for the language.
 */
export function getTestExecutor(language: string): TestExecutor | null {
  const factory = executors[language.toLowerCase()];
  return factory ? factory() : null;
}
