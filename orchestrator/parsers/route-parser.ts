/**
 * RouteParser interface — framework-agnostic route extraction.
 *
 * Implementations scan source files for HTTP route registrations
 * and return a structured list of ParsedRoute entries.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ParsedRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  file: string;
  line: number;
  handler_name?: string;
}

export interface RouteParser {
  /** Human-readable name for logging, e.g. "Express route parser" */
  name: string;
  /** File extensions this parser can handle, e.g. ['.ts', '.js'] or ['.py'] */
  supported_extensions: string[];
  /** Parse a single source file and return all routes found. */
  parseFile(filePath: string, content: string): ParsedRoute[];
  /** Parse all source files in a directory tree. */
  parseDirectory(srcDir: string): Promise<ParsedRoute[]>;
}

/** Recursively walk a directory and return all files matching the given extensions. */
export function walkSourceFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '__pycache__') continue;
      results.push(...walkSourceFiles(fullPath, extensions));
    } else if (extensions.includes(path.extname(entry.name).toLowerCase())) {
      results.push(fullPath);
    }
  }
  return results;
}
