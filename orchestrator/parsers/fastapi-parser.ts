/**
 * FastAPI Route Parser
 *
 * Scans Python source files for FastAPI/Starlette route decorators.
 * Handles @app.get, @router.post, and APIRouter patterns.
 */

import * as fs from 'node:fs';
import type { RouteParser, ParsedRoute } from './route-parser.js';
import { walkSourceFiles } from './route-parser.js';

// Matches: @app.get("/path") or @router.post('/path')
const DECORATOR_RE = /^\s*@\s*(?:\w+)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/i;

export class FastAPIParser implements RouteParser {
  name = 'FastAPI route parser';
  supported_extensions = ['.py'];

  parseFile(filePath: string, content: string): ParsedRoute[] {
    const routes: ParsedRoute[] = [];
    const lines = content.split('\n');

    for (const [i, line] of lines.entries()) {
      const match = DECORATOR_RE.exec(line);
      if (match) {
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
