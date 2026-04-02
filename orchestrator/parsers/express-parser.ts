/**
 * Express Route Parser
 *
 * Scans TypeScript/JavaScript Express source files for route registrations.
 * Handles app.METHOD and router.METHOD patterns with one level of router nesting.
 */

import * as fs from 'node:fs';
import type { RouteParser, ParsedRoute } from './route-parser.js';
import { walkSourceFiles } from './route-parser.js';

// Matches: app.get('/path', ...) or router.post('/path', ...)
const ROUTE_RE = /\b(?:app|router|route)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi;

export class ExpressParser implements RouteParser {
  name = 'Express route parser';
  supported_extensions = ['.ts', '.js', '.mts', '.mjs'];

  parseFile(filePath: string, content: string): ParsedRoute[] {
    const routes: ParsedRoute[] = [];
    const lines = content.split('\n');

    for (const [i, line] of lines.entries()) {
      if (line.includes('// @clados-ignore')) continue;

      let match: RegExpExecArray | null;
      ROUTE_RE.lastIndex = 0;
      while ((match = ROUTE_RE.exec(line)) !== null) {
        routes.push({
          method: match[1]!.toUpperCase() as ParsedRoute['method'],
          path: match[2]!,
          file: filePath,
          line: i + 1,
        });
      }
    }

    return routes;
  }

  async parseDirectory(srcDir: string): Promise<ParsedRoute[]> {
    const files = walkSourceFiles(srcDir, this.supported_extensions);
    const routes: ParsedRoute[] = [];

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf-8');
      routes.push(...this.parseFile(filePath, content));
    }

    return routes;
  }
}
