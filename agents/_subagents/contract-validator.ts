/**
 * Contract Validator — deterministic AST-based check.
 *
 * Parses the OpenAPI spec and scans generated Express source for route registrations.
 * Checks:
 *   (a) every endpoint in the spec has a matching route registration
 *   (b) every route registration has a corresponding OpenAPI entry
 *
 * Does NOT verify request/response shapes — that is handled at runtime by
 * express-openapi-validator middleware and exercised by the test suite.
 *
 * Scope: top-level app calls + one level of app.use("/prefix", router) composition.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import ts from 'typescript';
import writeFileAtomic from 'write-file-atomic';
import type { ContractValidatorResult, ContractFinding } from '../../orchestrator/types.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface RouteEntry {
  method: HttpMethod;
  path: string;
  file: string;
  line: number;
}

interface OpenApiEndpoint {
  method: HttpMethod;
  path: string;
}

// ─── OpenAPI parsing ──────────────────────────────────────────────────────────

function parseOpenApiEndpoints(specPath: string): OpenApiEndpoint[] {
  const raw = fs.readFileSync(specPath, 'utf-8');
  const spec = yaml.load(raw) as Record<string, unknown>;
  const paths = (spec['paths'] ?? {}) as Record<string, Record<string, unknown>>;
  const endpoints: OpenApiEndpoint[] = [];

  for (const [routePath, methods] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      if (methods[method]) {
        endpoints.push({ method, path: normalizePath(routePath) });
      }
    }
  }
  return endpoints;
}

/** Convert OpenAPI path params {id} → Express :id for comparison */
function normalizePath(p: string): string {
  return p.replace(/\{([^}]+)\}/g, ':$1').toLowerCase();
}

// ─── TypeScript AST route scanning ───────────────────────────────────────────

function extractRoutesFromFile(
  filePath: string,
  prefix: string,
  findings: ContractFinding[],
  visited = new Set<string>(),
): RouteEntry[] {
  if (visited.has(filePath)) return [];
  visited.add(filePath);

  if (!fs.existsSync(filePath)) return [];

  const source = fs.readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2020, true);
  const routes: RouteEntry[] = [];

  // Track variable name → import file mapping for router composition
  const importMap = new Map<string, string>();
  // Track variable name → prefix from app.use(prefix, var)
  const routerPrefixes = new Map<string, string>();

  // First pass: collect import declarations
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isImportDeclaration(node)) {
      const moduleSpec = (node.moduleSpecifier as ts.StringLiteral).text;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        importMap.set(bindings.name.text, resolveImportPath(filePath, moduleSpec));
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          importMap.set(binding.name.text, resolveImportPath(filePath, moduleSpec));
        }
      }
      // CommonJS require
      if (ts.isVariableStatement(node)) { /* handled below */ }
    }

    // const router = require('./routes/foo')
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.initializer && ts.isCallExpression(decl.initializer)) {
          const call = decl.initializer;
          if (
            ts.isIdentifier(call.expression) &&
            call.expression.text === 'require' &&
            call.arguments.length === 1 &&
            call.arguments[0] !== undefined &&
            ts.isStringLiteral(call.arguments[0])
          ) {
            const name = ts.isIdentifier(decl.name) ? decl.name.text : null;
            if (name) {
              importMap.set(name, resolveImportPath(filePath, (call.arguments[0] as ts.StringLiteral).text));
            }
          }
        }
      }
    }
  });

  // Second pass: scan route registrations and app.use calls
  scanNode(sourceFile);

  function scanNode(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;

      // app.METHOD(path, ...) — top-level
      if (
        ts.isPropertyAccessExpression(expr) &&
        HTTP_METHODS.includes(expr.name.text as HttpMethod) &&
        node.arguments.length >= 1 &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const method = expr.name.text as HttpMethod;
        const routePath = (node.arguments[0] as ts.StringLiteral).text;
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        routes.push({
          method,
          path: normalizePath(prefix + routePath),
          file: filePath,
          line: line + 1,
        });
      }

      // app.use(prefix, router) — one level of composition
      if (
        ts.isPropertyAccessExpression(expr) &&
        expr.name.text === 'use' &&
        node.arguments.length === 2 &&
        node.arguments[0] !== undefined &&
        node.arguments[1] !== undefined &&
        ts.isStringLiteral(node.arguments[0]) &&
        ts.isIdentifier(node.arguments[1])
      ) {
        const usePrefix = (node.arguments[0] as ts.StringLiteral).text;
        const routerName = (node.arguments[1] as ts.Identifier).text;
        const importedPath = importMap.get(routerName);

        if (importedPath) {
          if (visited.has(importedPath)) return;
          const nestedRoutes = extractRoutesFromFile(
            importedPath,
            normalizePath(prefix + usePrefix),
            findings,
            visited,
          );
          routes.push(...nestedRoutes);
        } else {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          findings.push({
            type: 'unresolved_import',
            file: filePath,
            line: line + 1,
            message: `Could not trace router import for "${routerName}" at line ${line + 1} — verify this route is covered by the OpenAPI spec.`,
          });
        }
      }

      // router.METHOD(path, ...) — within a composition file
      if (
        ts.isPropertyAccessExpression(expr) &&
        HTTP_METHODS.includes(expr.name.text as HttpMethod) &&
        ts.isIdentifier(expr.expression) &&
        node.arguments.length >= 1 &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const method = expr.name.text as HttpMethod;
        const routePath = (node.arguments[0] as ts.StringLiteral).text;
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        routes.push({
          method,
          path: normalizePath(prefix + routePath),
          file: filePath,
          line: line + 1,
        });
      }
    }

    ts.forEachChild(node, scanNode);
  }

  return routes;
}

function resolveImportPath(fromFile: string, importSpec: string): string {
  if (!importSpec.startsWith('.')) return importSpec;
  const dir = path.dirname(fromFile);
  const candidate = path.resolve(dir, importSpec);
  // Try common extensions
  for (const ext of ['.ts', '.js', '/index.ts', '/index.js']) {
    if (fs.existsSync(candidate + ext)) return candidate + ext;
  }
  return candidate + '.ts';
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function runContractValidator(
  projectDir: string,
  specPath: string,
  entryFile: string,
): Promise<ContractValidatorResult> {
  const findings: ContractFinding[] = [];

  const specEndpoints = parseOpenApiEndpoints(specPath);
  const registeredRoutes = extractRoutesFromFile(entryFile, '', findings);

  // Check (a): every spec endpoint has a route registration
  for (const endpoint of specEndpoints) {
    const match = registeredRoutes.find(
      (r) => r.method === endpoint.method && routePathsMatch(r.path, endpoint.path),
    );
    if (!match) {
      findings.push({
        type: 'missing_route',
        method: endpoint.method,
        path: endpoint.path,
        message: `OpenAPI endpoint ${endpoint.method.toUpperCase()} ${endpoint.path} has no matching route registration.`,
      });
    }
  }

  // Check (b): every route registration has an OpenAPI entry
  for (const route of registeredRoutes) {
    const match = specEndpoints.find(
      (e) => e.method === route.method && routePathsMatch(route.path, e.path),
    );
    if (!match) {
      findings.push({
        type: 'undeclared_route',
        method: route.method,
        path: route.path,
        file: route.file,
        line: route.line,
        message: `Route ${route.method.toUpperCase()} ${route.path} (${path.relative(projectDir, route.file)}:${route.line}) has no corresponding OpenAPI entry.`,
      });
    }
  }

  const result: ContractValidatorResult = {
    passed: findings.every((f) => f.type === 'unresolved_import'),
    findings,
    spec_endpoint_count: specEndpoints.length,
    registered_route_count: registeredRoutes.length,
  };

  const outputPath = path.join(projectDir, '.clados', '02-build', 'contract-validator.json');
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await writeFileAtomic(outputPath, JSON.stringify(result, null, 2), { encoding: 'utf8' });

  return result;
}

/**
 * Match Express path patterns: treat :param segments as wildcards.
 */
function routePathsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const partsA = a.split('/');
  const partsB = b.split('/');
  if (partsA.length !== partsB.length) return false;
  return partsA.every((seg, i) => seg.startsWith(':') || partsB[i]?.startsWith(':') || seg === partsB[i]);
}
