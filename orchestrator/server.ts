/**
 * Express + WebSocket server for the CLaDOS orchestrator.
 * Serves the React SPA from ui/dist/ and provides the REST/WS API.
 *
 * Project-agnostic: no project is loaded at startup. Projects are created or
 * opened via REST endpoints, which populate the module-level `activeProject`.
 */

import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import type { GateResponse, WsServerEvent, SessionState, SessionConfig, ProjectType } from './types.js';
import { Conductor } from './conductor.js';
import { SessionManager } from './session.js';
import { Logger } from './logger.js';

const UI_DIST = path.join(__dirname, '..', '..', 'ui', 'dist');

// ─── Active project singleton ─────────────────────────────────────────────────

interface ActiveProject {
  projectDir: string;
  session: SessionManager;
  conductor: Conductor;
  logger: Logger;
}

let activeProject: ActiveProject | null = null;

// ─── Server context ───────────────────────────────────────────────────────────

export interface ServerContext {
  apiKey: string;
  projectsRoot: string;
}

// ─── Pipeline run loop ────────────────────────────────────────────────────────

async function runPipelineLoop(conductor: Conductor, projectDir: string, logger: Logger): Promise<void> {
  let keepRunning = true;
  while (keepRunning) {
    try {
      await conductor.runPipeline(projectDir);
      keepRunning = false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'PIPELINE_ABANDONED') {
        console.log('\nProject abandoned.');
        keepRunning = false;
      } else if (msg.startsWith('GOTO_PHASE_')) {
        // runPipeline re-reads current_phase from session state — just loop
        continue;
      } else {
        logger.error('cli.pipeline_error', msg, {
          stack: err instanceof Error ? err.stack : undefined,
        });
        console.error('\nPipeline error:', msg);
        keepRunning = false;
      }
    }
  }
}

// ─── Project scanner ──────────────────────────────────────────────────────────

interface ProjectSummary {
  name: string;
  pipeline_status: string;
  created_at: string;
  updated_at: string;
}

async function scanProjects(root: string): Promise<ProjectSummary[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: ProjectSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const stateFile = path.join(root, e.name, '.clados', '00-session-state.json');
    try {
      const raw = await fs.promises.readFile(stateFile, 'utf-8');
      const state = JSON.parse(raw) as SessionState;
      results.push({
        name: state.project_name ?? e.name,
        pipeline_status: state.pipeline_status,
        created_at: state.created_at,
        updated_at: state.updated_at,
      });
    } catch {
      // Not a CLaDOS project directory — skip
    }
  }
  // Most recently updated first
  return results.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function createExpressApp(ctx: ServerContext): ReturnType<typeof createServer> {
  const app = express();
  app.use(express.json());

  // ─── Static SPA ─────────────────────────────────────────────────────────────
  if (fs.existsSync(UI_DIST)) {
    app.use(express.static(UI_DIST));
  }

  // ─── HTTP + WebSocket server (built early so broadcast is available) ──────

  const server = createServer(app);
  const wss = new WebSocketServer({ server });
  const clients = new Set<WebSocket>();

  function broadcast(event: WsServerEvent): void {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  // ─── REST endpoints ──────────────────────────────────────────────────────────

  /**
   * GET /projects/list
   * Scans projectsRoot for directories containing a CLaDOS session state file.
   */
  app.get('/projects/list', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const projects = await scanProjects(ctx.projectsRoot);
      res.json(projects);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /projects/create
   * Body: { name, idea, project_type, security_enabled, wrecker_enabled, spend_cap }
   * Creates a new project directory, initialises session state, and starts the pipeline.
   */
  app.post('/projects/create', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (activeProject) {
        res.status(409).json({ error: 'A project is already active. Restart CLaDOS to open a different project.' });
        return;
      }

      const { name, idea, project_type, security_enabled, wrecker_enabled, spend_cap, autonomy_mode, refiner_enabled } = req.body as {
        name?: string;
        idea?: string;
        project_type?: string;
        security_enabled?: boolean;
        wrecker_enabled?: boolean;
        spend_cap?: number | null;
        autonomy_mode?: 'guided' | 'autonomous';
        refiner_enabled?: boolean;
      };

      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        res.status(400).json({ error: 'name must contain only letters, numbers, hyphens, and underscores' });
        return;
      }
      if (!idea || !idea.trim()) {
        res.status(400).json({ error: 'idea is required' });
        return;
      }
      const validTypes = ['backend-only', 'full-stack', 'cli-tool', 'library'];
      if (!project_type || !validTypes.includes(project_type)) {
        res.status(400).json({ error: `project_type must be one of: ${validTypes.join(', ')}` });
        return;
      }

      const projectDir = path.resolve(ctx.projectsRoot, name);
      if (fs.existsSync(projectDir)) {
        res.status(409).json({ error: `Directory "${name}" already exists. Use "open" to resume it.` });
        return;
      }

      await fs.promises.mkdir(projectDir, { recursive: true });

      const config: SessionConfig = {
        project_type: project_type as ProjectType,
        idea: idea.trim(),
        security_enabled: Boolean(security_enabled),
        wrecker_enabled: Boolean(wrecker_enabled),
        is_high_complexity: false,
        spend_cap: typeof spend_cap === 'number' && spend_cap > 0 ? spend_cap : null,
        autonomy_mode: autonomy_mode ?? 'guided',
        refiner_enabled: Boolean(refiner_enabled),
      };

      const session = new SessionManager();
      let state: SessionState;
      try {
        state = await session.init(projectDir, name, config);
      } catch (err) {
        // Roll back the directory on init failure
        try { await fs.promises.rm(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        throw err;
      }

      const logger = new Logger(projectDir);
      const conductor = new Conductor(ctx.apiKey, session, logger, () => {});
      await conductor.init();
      conductor.setBroadcast(broadcast);

      activeProject = { projectDir, session, conductor, logger };

      // Notify all connected clients that a project is now active
      broadcast({ type: 'state:snapshot', state });

      res.json({ ok: true });

      // Start the pipeline in the background (non-blocking)
      runPipelineLoop(conductor, projectDir, logger).catch((err) => {
        console.error('Pipeline error:', err instanceof Error ? err.message : String(err));
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /projects/open
   * Body: { name }
   * Loads an existing project and resumes the pipeline if it is not yet complete.
   */
  app.post('/projects/open', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (activeProject) {
        res.status(409).json({ error: 'A project is already active. Restart CLaDOS to open a different project.' });
        return;
      }

      const { name } = req.body as { name?: string };
      if (!name || !name.trim()) {
        res.status(400).json({ error: 'name is required' });
        return;
      }

      const projectDir = path.resolve(ctx.projectsRoot, name.trim());
      const stateFile = path.join(projectDir, '.clados', '00-session-state.json');
      if (!fs.existsSync(stateFile)) {
        res.status(404).json({ error: `No CLaDOS project found at "${name}"` });
        return;
      }

      const session = new SessionManager();
      const state = await session.read(projectDir);
      const logger = new Logger(projectDir);
      logger.info('server.open', `Opening project (status: ${state.pipeline_status})`);

      const conductor = new Conductor(ctx.apiKey, session, logger, () => {});
      await conductor.init();
      conductor.setBroadcast(broadcast);

      activeProject = { projectDir, session, conductor, logger };

      // Notify all connected clients that a project is now active
      broadcast({ type: 'state:snapshot', state });

      res.json({ ok: true, state });

      // Resume the pipeline unless it has already finished
      if (state.pipeline_status !== 'complete' && state.pipeline_status !== 'abandoned') {
        runPipelineLoop(conductor, projectDir, logger).catch((err) => {
          console.error('Pipeline error:', err instanceof Error ? err.message : String(err));
        });
      }
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /gate/respond
   * Body: GateResponse
   */
  app.post('/gate/respond', (req: Request, res: Response) => {
    if (!activeProject) { res.status(409).json({ error: 'No active project' }); return; }
    const body = req.body as GateResponse;
    if (!body.action || !['approve', 'revise', 'abort', 'goto'].includes(body.action)) {
      res.status(400).json({ error: 'Invalid action' });
      return;
    }
    activeProject.conductor.handleGateResponse(body);
    res.json({ ok: true });
  });

  /**
   * POST /gate/discovery/respond
   * Body: DiscoveryGateResponse
   */
  app.post('/gate/discovery/respond', (req: Request, res: Response) => {
    if (!activeProject) { res.status(409).json({ error: 'No active project' }); return; }
    const body = req.body as { answers?: Record<string, string>; additional_context?: string };
    if (!body.answers || typeof body.answers !== 'object') {
      res.status(400).json({ error: 'answers object is required' });
      return;
    }
    activeProject.conductor.handleDiscoveryGateResponse(body as import('./types.js').DiscoveryGateResponse);
    res.json({ ok: true });
  });

  /**
   * POST /gate/question/respond
   * Body: QuestionGateResponse
   */
  app.post('/gate/question/respond', (req: Request, res: Response) => {
    if (!activeProject) { res.status(409).json({ error: 'No active project' }); return; }
    const body = req.body as { answers?: Record<string, string> };
    if (!body.answers || typeof body.answers !== 'object') {
      res.status(400).json({ error: 'answers object is required' });
      return;
    }
    activeProject.conductor.handleQuestionGateResponse(body as import('./types.js').QuestionGateResponse);
    res.json({ ok: true });
  });

  /**
   * POST /gate/micro/respond
   * Body: MicroGateResponse
   */
  app.post('/gate/micro/respond', (req: Request, res: Response) => {
    if (!activeProject) { res.status(409).json({ error: 'No active project' }); return; }
    const body = req.body as { action?: string; rejection_reason?: string };
    if (!body.action || !['approve', 'reject'].includes(body.action)) {
      res.status(400).json({ error: 'action must be approve or reject' });
      return;
    }
    activeProject.conductor.handleMicroGateResponse(body as import('./types.js').MicroGateResponse);
    res.json({ ok: true });
  });

  /**
   * GET /project/state
   * Returns the current session state for reconnection.
   */
  app.get('/project/state', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (!activeProject) { res.status(409).json({ error: 'No active project' }); return; }
      const state = await activeProject.session.read(activeProject.projectDir);
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /project/artifact?path=relative/path
   * Returns the raw content of an artifact from .clados/.
   */
  app.get('/project/artifact', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!activeProject) { res.status(409).json({ error: 'No active project' }); return; }

      const relPath = req.query['path'] as string;
      if (!relPath) {
        res.status(400).json({ error: 'path query param required' });
        return;
      }

      const claDosDir = path.resolve(path.join(activeProject.projectDir, '.clados'));
      const projectRoot = path.resolve(activeProject.projectDir);
      let filePath: string;

      if (relPath.startsWith('.clados/') || relPath.startsWith('.clados\\')) {
        const stripped = relPath.substring(8);
        const candidate = path.resolve(claDosDir, stripped);
        const rel = path.relative(claDosDir, candidate);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          res.status(403).json({ error: 'Forbidden' });
          return;
        }
        filePath = candidate;
      } else {
        const cladosCandidate = path.resolve(claDosDir, relPath);
        const cladosRel = path.relative(claDosDir, cladosCandidate);
        if (!cladosRel.startsWith('..') && !path.isAbsolute(cladosRel) && fs.existsSync(cladosCandidate)) {
          filePath = cladosCandidate;
        } else {
          const rootCandidate = path.resolve(projectRoot, relPath);
          const rootRel = path.relative(projectRoot, rootCandidate);
          if (rootRel.startsWith('..') || path.isAbsolute(rootRel)) {
            res.status(403).json({ error: 'Forbidden' });
            return;
          }
          filePath = rootCandidate;
        }
      }

      if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: 'Artifact not found' });
        return;
      }
      const content = await fs.promises.readFile(filePath, 'utf-8');
      res.type('text/plain').send(content);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /artifact/versions?path=artifact-key
   * Lists version history for an artifact from .clados/history/.
   */
  app.get('/artifact/versions', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!activeProject) { res.status(409).json({ error: 'No active project' }); return; }
      const relPath = req.query['path'] as string;
      if (!relPath) { res.status(400).json({ error: 'path query param required' }); return; }

      const state = await activeProject.session.read(activeProject.projectDir);
      const currentVersion = state.artifacts[relPath]?.version ?? 1;
      const ext = path.extname(relPath);
      const base = path.basename(relPath, ext);
      const dir = path.dirname(relPath);
      const historyDir = path.join(activeProject.projectDir, '.clados', 'history', dir);

      const versions: Array<{ version: number; filename: string }> = [];
      if (fs.existsSync(historyDir)) {
        const files = await fs.promises.readdir(historyDir);
        const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_v(\\d+)${ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
        for (const f of files) {
          const m = f.match(pattern);
          if (m) versions.push({ version: parseInt(m[1]!, 10), filename: f });
        }
      }
      // Add the current version
      versions.push({ version: currentVersion, filename: `${base}${ext}` });
      versions.sort((a, b) => b.version - a.version);
      res.json({ versions });
    } catch (err) { next(err); }
  });

  /**
   * POST /artifact/revert
   * Body: { path: string, version: number }
   * Reverts an artifact to a previous version from history.
   */
  app.post('/artifact/revert', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!activeProject) { res.status(409).json({ error: 'No active project' }); return; }
      const { path: relPath, version } = req.body as { path: string; version: number };
      if (!relPath || !version) { res.status(400).json({ error: 'path and version required' }); return; }

      const claDosDir = path.join(activeProject.projectDir, '.clados');
      const ext = path.extname(relPath);
      const base = path.basename(relPath, ext);
      const dir = path.dirname(relPath);
      const archivePath = path.join(claDosDir, 'history', dir, `${base}_v${version}${ext}`);

      if (!fs.existsSync(archivePath)) { res.status(404).json({ error: 'Version not found in history' }); return; }

      // Archive current version first
      await activeProject.session.archiveArtifact(activeProject.projectDir, relPath);
      // Copy archived version to current
      const currentPath = path.join(claDosDir, relPath);
      await fs.promises.copyFile(archivePath, currentPath);
      // Register as new version
      const content = await fs.promises.readFile(currentPath, 'utf-8');
      await activeProject.session.registerArtifact(activeProject.projectDir, relPath, {
        path: relPath,
        token_count: Math.ceil(content.length / 4),
        version: 0, // registerArtifact will increment
      });
      res.json({ ok: true, message: `Reverted ${relPath} to v${version}` });
    } catch (err) { next(err); }
  });

  /**
   * POST /agent/retry
   */
  app.post('/agent/retry', (req: Request, res: Response) => {
    if (!activeProject) { res.status(409).json({ error: 'No active project' }); return; }
    const { role } = req.body as { role?: string };
    if (!role) { res.status(400).json({ error: 'role required' }); return; }
    activeProject.conductor.handleAgentRetry(role);
    res.json({ ok: true });
  });

  /**
   * POST /agent/skip
   */
  app.post('/agent/skip', (req: Request, res: Response) => {
    if (!activeProject) { res.status(409).json({ error: 'No active project' }); return; }
    const { role } = req.body as { role?: string };
    if (!role) { res.status(400).json({ error: 'role required' }); return; }
    activeProject.conductor.handleAgentSkip(role);
    res.json({ ok: true });
  });

  /**
   * POST /budget/update
   * Body: { new_cap: number }
   */
  app.post('/budget/update', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!activeProject) { res.status(409).json({ error: 'No active project' }); return; }
      const { new_cap } = req.body as { new_cap: number };
      if (typeof new_cap !== 'number' || new_cap <= 0) {
        res.status(400).json({ error: 'new_cap must be a positive number' });
        return;
      }
      const current = await activeProject.session.read(activeProject.projectDir);
      await activeProject.session.update(activeProject.projectDir, {
        config: { ...current.config, spend_cap: new_cap },
        pipeline_status: 'agent_running',
      });
      activeProject.conductor.handleBudgetUpdate();
      res.json({ ok: true, new_cap });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /budget/abort
   */
  app.post('/budget/abort', (_req: Request, res: Response) => {
    if (!activeProject) { res.status(409).json({ error: 'No active project' }); return; }
    activeProject.conductor.handleBudgetAbort();
    res.json({ ok: true });
  });

  /**
   * POST /config/toggle-agent
   * Body: { field: string, enabled: boolean }
   * Toggles an optional agent (security_enabled, wrecker_enabled, refiner_enabled).
   */
  app.post('/config/toggle-agent', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!activeProject) { res.status(409).json({ error: 'No active project' }); return; }
      const { field, enabled } = req.body as { field: string; enabled: boolean };
      const allowed = ['security_enabled', 'wrecker_enabled', 'refiner_enabled'];
      if (!allowed.includes(field)) { res.status(400).json({ error: `Invalid field: ${field}` }); return; }
      const current = await activeProject.session.read(activeProject.projectDir);
      await activeProject.session.update(activeProject.projectDir, {
        config: { ...current.config, [field]: enabled },
      });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ─── Interactive mode (V4) ──────────────────────────────────────────────────

  let interactiveSession: InstanceType<typeof import('./interactive.js').InteractiveSession> | null = null;

  app.post('/interactive/message', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!activeProject) { res.status(409).json({ error: 'No active project' }); return; }
      const state = await activeProject.session.read(activeProject.projectDir);
      if (state.pipeline_status !== 'complete') { res.status(400).json({ error: 'Interactive mode requires complete status' }); return; }

      // Lazy-init the interactive session
      if (!interactiveSession) {
        const { InteractiveSession } = await import('./interactive.js');
        interactiveSession = new InteractiveSession({
          apiKey: ctx.apiKey,
          model: 'claude-sonnet-4-6',
          projectDir: activeProject.projectDir,
          state,
          logger: activeProject.conductor.logger,
        });
      }

      const { message } = req.body as { message?: string };
      if (!message) { res.status(400).json({ error: 'message required' }); return; }

      const content = await interactiveSession.sendMessage(message);
      const diff = interactiveSession.pendingDiff;
      res.json({ content, diff });
    } catch (err) { next(err); }
  });

  app.post('/interactive/diff/approve', async (_req: Request, res: Response) => {
    if (!interactiveSession) { res.status(400).json({ error: 'No interactive session' }); return; }
    interactiveSession.approveDiff();
    res.json({ ok: true });
  });

  app.post('/interactive/diff/reject', async (_req: Request, res: Response) => {
    if (!interactiveSession) { res.status(400).json({ error: 'No interactive session' }); return; }
    interactiveSession.rejectDiff();
    res.json({ ok: true });
  });

  // ─── Re-invocation (V4) ─────────────────────────────────────────────────────

  /**
   * GET /templates/list
   * Returns all available project templates (built-in + user).
   */
  app.get('/templates/list', async (_req: Request, res: Response) => {
    try {
      const { templateCommand } = await import('./cli/template.js');
      // Re-use the built-in templates from the module
      const os = await import('os');
      const TEMPLATES_DIR = path.join(os.homedir(), '.clados', 'templates');
      const builtIn = [
        { name: 'typescript-api', description: 'TypeScript REST API with Express, Prisma, and PostgreSQL', config: { project_type: 'backend-only', security_enabled: true, wrecker_enabled: false }, stack_preset: { language: 'typescript', backend_framework: 'express' } },
        { name: 'typescript-fullstack', description: 'TypeScript full-stack with Express + React', config: { project_type: 'full-stack', security_enabled: true, wrecker_enabled: false }, stack_preset: { language: 'typescript', backend_framework: 'express' } },
        { name: 'python-api', description: 'Python REST API with FastAPI and SQLAlchemy', config: { project_type: 'backend-only', security_enabled: true, wrecker_enabled: false }, stack_preset: { language: 'python', backend_framework: 'fastapi' } },
        { name: 'python-cli', description: 'Python CLI tool with Click', config: { project_type: 'cli-tool', security_enabled: false, wrecker_enabled: false }, stack_preset: { language: 'python', backend_framework: 'none' } },
        { name: 'go-api', description: 'Go REST API with Gin and GORM', config: { project_type: 'backend-only', security_enabled: true, wrecker_enabled: false }, stack_preset: { language: 'go', backend_framework: 'gin' } },
      ];
      // Load user templates
      const userTemplates: typeof builtIn = [];
      if (fs.existsSync(TEMPLATES_DIR)) {
        for (const file of fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'))) {
          try {
            userTemplates.push(JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf-8')));
          } catch { /* skip */ }
        }
      }
      void templateCommand; // ensure import isn't tree-shaken
      res.json([...builtIn, ...userTemplates]);
    } catch { res.json([]); }
  });

  /**
   * POST /reinvoke/detect
   * Body: { change_description: string }
   * Runs delta detection and returns the recommended entry phase.
   */
  app.post('/reinvoke/detect', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!activeProject) { res.status(409).json({ error: 'No active project' }); return; }
      const state = await activeProject.session.read(activeProject.projectDir);
      if (state.pipeline_status !== 'complete') { res.status(400).json({ error: 'Re-invocation requires complete status' }); return; }

      const { change_description } = req.body as { change_description?: string };
      if (!change_description) { res.status(400).json({ error: 'change_description required' }); return; }

      const { detectDelta } = await import('./delta-detector.js');
      const result = await detectDelta(
        ctx.apiKey,
        'claude-haiku-4-5-20251001',
        activeProject.projectDir,
        change_description,
        state,
        activeProject.conductor.logger,
      );

      // Determine which artifacts will be regenerated
      const phasePrefixes: Record<number, string> = { 0: '00-', 1: '01-', 2: '02-', 3: '03-', 4: '04-' };
      const affectedArtifacts: string[] = [];
      for (let p = result.entry_phase; p <= 4; p++) {
        const prefix = phasePrefixes[p];
        if (prefix && state.artifacts) {
          for (const key of Object.keys(state.artifacts)) {
            if (key.startsWith(prefix)) affectedArtifacts.push(key);
          }
        }
      }

      res.json({ ...result, affected_artifacts: affectedArtifacts });
    } catch (err) { next(err); }
  });

  /**
   * POST /reinvoke/start
   * Body: { entry_phase: number, change_description: string }
   * Starts the pipeline from the specified phase.
   */
  app.post('/reinvoke/start', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!activeProject) { res.status(409).json({ error: 'No active project' }); return; }
      const state = await activeProject.session.read(activeProject.projectDir);
      if (state.pipeline_status !== 'complete') { res.status(400).json({ error: 'Re-invocation requires complete status' }); return; }

      const { entry_phase, change_description } = req.body as { entry_phase?: number; change_description?: string };
      if (entry_phase == null || !change_description) { res.status(400).json({ error: 'entry_phase and change_description required' }); return; }

      // Record the re-invocation
      const reinvocation = {
        original_completed_at: state.completed_at ?? new Date().toISOString(),
        change_description,
        detected_entry_phase: entry_phase,
        actual_entry_phase: entry_phase,
        timestamp: new Date().toISOString(),
      };

      const reinvocations = [...(state.reinvocations ?? []), reinvocation];
      await activeProject.session.update(activeProject.projectDir, {
        pipeline_status: 'agent_running',
        current_phase: entry_phase,
        reinvocations,
      });

      // Broadcast state change
      const updated = await activeProject.session.read(activeProject.projectDir);
      broadcast({ type: 'state:snapshot', state: updated });

      res.json({ ok: true, message: `Pipeline resuming from phase ${entry_phase}` });
    } catch (err) { next(err); }
  });

  // SPA fallback for client-side routing
  if (fs.existsSync(UI_DIST)) {
    app.get('*', (_req, res) => {
      res.sendFile(path.join(UI_DIST, 'index.html'));
    });
  }

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('server.error', err.message);
    res.status(500).json({ error: err.message });
  });

  // ─── WebSocket connections ────────────────────────────────────────────────

  wss.on('connection', async (ws) => {
    clients.add(ws);

    // Send full state snapshot on connect if a project is active
    if (activeProject) {
      try {
        const state: SessionState = await activeProject.session.read(activeProject.projectDir);
        ws.send(JSON.stringify({ type: 'state:snapshot', state } satisfies WsServerEvent));
        activeProject.conductor.resendPendingEventsTo(ws);
      } catch { /* state may not exist yet */ }
    }

    ws.on('close', () => { clients.delete(ws); });
    ws.on('error', () => { clients.delete(ws); });
  });

  return server;
}

/**
 * Find a free port in the range [start, end].
 */
export async function findFreePort(start = 3100, end = 3199): Promise<number> {
  const net = await import('net');
  for (let port = start; port <= end; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => { server.close(); resolve(true); });
      server.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error(`No free port in range ${start}–${end}`);
}
