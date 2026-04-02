/**
 * TestExecutor interface — language-agnostic test execution.
 */

export interface TestResult {
  passed: boolean;
  total: number;
  failures: number;
  skipped: number;
  /** Raw stdout/stderr from the test process. */
  output: string;
  /** Per-test-file results if parseable. */
  details?: { file: string; passed: boolean; error?: string }[];
}

export interface TestExecutor {
  /** Human-readable name, e.g. "Node.js (npm test)" */
  name: string;
  /** The language this executor supports. */
  language: string;
  /** Set up the test environment (install deps, build, etc.) */
  setup(projectDir: string): Promise<void>;
  /** Run the test suite. Returns structured results. */
  run(projectDir: string): Promise<TestResult>;
  /** Tear down test environment (stop containers, clean temp files). */
  teardown(projectDir: string): Promise<void>;
}
