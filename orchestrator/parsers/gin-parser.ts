/**
 * Gin Route Parser
 *
 * Scans Go source files for Gin (and Chi-style) route registrations.
 * Handles router.GET, router.Group, r.POST patterns.
 */

import * as fs from 'node:fs';
import type { RouteParser, ParsedRoute } from './route-parser.js';
import { walkSourceFiles } from './route-parser.js';

// Matches: r.GET("/path", ...) or router.POST("/path", ...)
const ROUTE_RE = /\b\w+\.(GET|POST|PUT|PATCH|DELETE)\s*\(\s*"([^"]+)"/gi;

export class GinParser implements RouteParser {
  name = 'Gin route parser';
  supported_extensions = ['.go'];

  parseFile(filePath: string, content: string): ParsedRoute[] {
    const routes: ParsedRoute[] = [];
    const lines = content.split('\n');

    for (const [i, line] of lines.entries()) {
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
