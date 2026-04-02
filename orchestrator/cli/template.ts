/**
 * CLI subcommand: clados template
 *
 * Usage:
 *   clados template list                — show all templates
 *   clados template use <name>          — apply template to new project
 *   clados template save <name> [dir]   — save current project as template
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { TemplateDefinition } from '../types.js';

const TEMPLATES_DIR = path.join(os.homedir(), '.clados', 'templates');

const BUILT_IN: TemplateDefinition[] = [
  {
    name: 'typescript-api',
    description: 'TypeScript REST API with Express, Prisma, and PostgreSQL',
    version: 1,
    config: { project_type: 'backend-only', security_enabled: true, wrecker_enabled: false },
    stack_preset: {
      language: 'typescript', runtime: 'node-20', backend_framework: 'express',
      orm: 'prisma', database: 'postgresql', test_runner: 'jest',
      test_integration: 'supertest', package_manager: 'npm',
      ci_platform: 'github-actions', container_base: 'node:20-alpine',
    },
  },
  {
    name: 'typescript-fullstack',
    description: 'TypeScript full-stack with Express backend and React frontend',
    version: 1,
    config: { project_type: 'full-stack', security_enabled: true, wrecker_enabled: false },
    stack_preset: {
      language: 'typescript', runtime: 'node-20', backend_framework: 'express',
      orm: 'prisma', database: 'postgresql', test_runner: 'jest',
      test_integration: 'supertest', package_manager: 'npm',
      ci_platform: 'github-actions', container_base: 'node:20-alpine',
    },
  },
  {
    name: 'python-api',
    description: 'Python REST API with FastAPI, SQLAlchemy, and PostgreSQL',
    version: 1,
    config: { project_type: 'backend-only', security_enabled: true, wrecker_enabled: false },
    stack_preset: {
      language: 'python', runtime: 'python-3.12', backend_framework: 'fastapi',
      orm: 'sqlalchemy', database: 'postgresql', test_runner: 'pytest',
      test_integration: 'httpx', package_manager: 'pip',
      ci_platform: 'github-actions', container_base: 'python:3.12-slim',
    },
  },
  {
    name: 'python-cli',
    description: 'Python CLI tool with Click',
    version: 1,
    config: { project_type: 'cli-tool', security_enabled: false, wrecker_enabled: false },
    stack_preset: {
      language: 'python', runtime: 'python-3.12', backend_framework: 'none',
      orm: 'none', database: 'none', test_runner: 'pytest',
      test_integration: 'none', package_manager: 'pip',
      ci_platform: 'github-actions', container_base: 'python:3.12-slim',
    },
  },
  {
    name: 'go-api',
    description: 'Go REST API with Gin, GORM, and PostgreSQL',
    version: 1,
    config: { project_type: 'backend-only', security_enabled: true, wrecker_enabled: false },
    stack_preset: {
      language: 'go', runtime: 'go-1.22', backend_framework: 'gin',
      orm: 'gorm', database: 'postgresql', test_runner: 'go-test',
      test_integration: 'net/http/httptest', package_manager: 'go-mod',
      ci_platform: 'github-actions', container_base: 'golang:1.22-alpine',
    },
  },
];

function ensureDir(): void {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  }
}

function loadUserTemplates(): TemplateDefinition[] {
  ensureDir();
  const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));
  const templates: TemplateDefinition[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf-8');
      templates.push(JSON.parse(content));
    } catch { /* skip invalid */ }
  }
  return templates;
}

function getAllTemplates(): TemplateDefinition[] {
  return [...BUILT_IN, ...loadUserTemplates()];
}

function listTemplates(): void {
  const templates = getAllTemplates();
  console.log('\nAvailable templates:\n');
  console.log('  Name                    Type          Language      Description');
  console.log('  ────────────────────    ──────────    ──────────    ──────────────────────────');
  for (const t of templates) {
    const name = t.name.padEnd(22);
    const type = (t.config.project_type ?? '—').padEnd(12);
    const lang = (t.stack_preset?.language ?? '—').padEnd(12);
    console.log(`  ${name}  ${type}  ${lang}  ${t.description}`);
  }
  console.log();
}

function useTemplate(name: string): void {
  const templates = getAllTemplates();
  const template = templates.find(t => t.name === name);
  if (!template) {
    console.error(`Template "${name}" not found.`);
    console.error('Run `clados template list` to see available templates.');
    process.exit(1);
  }

  // Output template as JSON for the server/HomeScreen to pick up
  console.log(JSON.stringify(template, null, 2));
  console.log(`\nTemplate "${name}" ready.`);
  console.log('Start CLaDOS with `clados` and the HomeScreen will pre-fill from this template.');

  // Also write to a temp file the server can read
  const tempPath = path.join(os.tmpdir(), 'clados-template.json');
  fs.writeFileSync(tempPath, JSON.stringify(template));
  console.log(`Template written to ${tempPath}`);
}

function saveTemplate(name: string, projectDir: string): void {
  const resolvedDir = path.resolve(projectDir);
  const statePath = path.join(resolvedDir, '.clados', '00-session-state.json');

  if (!fs.existsSync(statePath)) {
    console.error(`No CLaDOS session found at ${resolvedDir}`);
    process.exit(1);
  }

  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

  // Read stack manifest if available
  const stackPath = path.join(resolvedDir, '.clados', '01-stack.json');
  let stackPreset = undefined;
  if (fs.existsSync(stackPath)) {
    try { stackPreset = JSON.parse(fs.readFileSync(stackPath, 'utf-8')); } catch { /* skip */ }
  }

  const template: TemplateDefinition = {
    name,
    description: `Template saved from project at ${resolvedDir}`,
    version: 1,
    config: {
      project_type: state.config?.project_type ?? 'backend-only',
      security_enabled: state.config?.security_enabled ?? false,
      wrecker_enabled: state.config?.wrecker_enabled ?? false,
    },
    stack_preset: stackPreset,
  };

  ensureDir();
  const outPath = path.join(TEMPLATES_DIR, `${name}.json`);
  fs.writeFileSync(outPath, JSON.stringify(template, null, 2) + '\n');
  console.log(`✓ Template "${name}" saved to ${outPath}`);
}

export async function templateCommand(args: string[]): Promise<void> {
  const action = args[0];

  switch (action) {
    case 'list':
      listTemplates();
      break;
    case 'use':
      if (!args[1]) { console.error('Usage: clados template use <name>'); process.exit(1); }
      useTemplate(args[1]);
      break;
    case 'save':
      if (!args[1]) { console.error('Usage: clados template save <name> [project-dir]'); process.exit(1); }
      saveTemplate(args[1], args[2] ?? process.cwd());
      break;
    default:
      console.error('Usage: clados template <list|use|save>');
      console.error('  list              Show all available templates');
      console.error('  use <name>        Apply a template for new projects');
      console.error('  save <name> [dir] Save current project as a template');
      process.exit(1);
  }
}
