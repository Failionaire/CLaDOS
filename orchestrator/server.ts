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

      const { name, idea, project_type, security_enabled, wrecker_enabled, spend_cap } = req.body as {
        name?: string;
        idea?: string;
        project_type?: string;
        security_enabled?: boolean;
        wrecker_enabled?: boolean;
        spend_cap?: number | null;
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
