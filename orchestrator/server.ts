/**
 * Express + WebSocket server for the CLaDOS orchestrator.
 * Serves the React SPA from ui/dist/ and provides the REST/WS API.
 */

import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import type { GateResponse, WsServerEvent, SessionState } from './types.js';
import type { Conductor } from './conductor.js';
import type { SessionManager } from './session.js';
import type { Logger } from './logger.js';

const UI_DIST = path.join(__dirname, '..', '..', 'ui', 'dist');

export interface ServerContext {
  conductor: Conductor;
  session: SessionManager;
  logger: Logger;
  projectDir: string;
  /** Resolves when POST /project/new is received — signals handleNew() to start the pipeline. */
  setupResolver?: () => void;
}

export function createExpressApp(ctx: ServerContext): ReturnType<typeof createServer> {
  const app = express();
  app.use(express.json());

  // ─── Static SPA ─────────────────────────────────────────────────────────────
  if (fs.existsSync(UI_DIST)) {
    app.use(express.static(UI_DIST));
  }

  // ─── REST endpoints ──────────────────────────────────────────────────────────

  /**
   * POST /gate/respond
   * Body: GateResponse
   */
  app.post('/gate/respond', (req: Request, res: Response) => {
    const body = req.body as GateResponse;
    if (!body.action || !['approve', 'revise', 'abort', 'goto'].includes(body.action)) {
      res.status(400).json({ error: 'Invalid action' });
      return;
    }
    ctx.conductor.handleGateResponse(body);
    res.json({ ok: true });
  });

  /**
   * GET /project/state
   * Returns the current session state for reconnection.
   */
  app.get('/project/state', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const state = await ctx.session.read(ctx.projectDir);
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
      let relPath = req.query['path'] as string;
      if (!relPath) {
        res.status(400).json({ error: 'path query param required' });
        return;
      }

      const claDosDir = path.resolve(path.join(ctx.projectDir, '.clados'));
      const projectRoot = path.resolve(ctx.projectDir);
      let filePath: string;

      if (relPath.startsWith('.clados/') || relPath.startsWith('.clados\\')) {
        // Explicit .clados/ prefix — resolve inside .clados/ with traversal guard
        const stripped = relPath.substring(8);
        const candidate = path.resolve(claDosDir, stripped);
        const rel = path.relative(claDosDir, candidate);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          res.status(403).json({ error: 'Forbidden' });
          return;
        }
        filePath = candidate;
      } else {
        // No prefix: try .clados/ first (sidebar keys are relative to .clados/),
        // then fall back to project root (agent:done artifact paths like src/index.ts).
        const cladosCandidate = path.resolve(claDosDir, relPath);
        const cladosRel = path.relative(claDosDir, cladosCandidate);
        if (!cladosRel.startsWith('..') && !path.isAbsolute(cladosRel) && fs.existsSync(cladosCandidate)) {
          filePath = cladosCandidate;
        } else {
          // Fall back to project root
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
   * POST /project/new
   * Body: { idea, project_type, security_enabled, wrecker_enabled, spend_cap }
   * Accepts Phase 0 setup inputs, updates session config, and starts the pipeline.
   */
  app.post('/project/new', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        idea,
        project_type,
        security_enabled,
        wrecker_enabled,
        spend_cap,
      } = req.body as {
        idea?: string;
        project_type?: string;
        security_enabled?: boolean;
        wrecker_enabled?: boolean;
        spend_cap?: number | null;
      };

      if (!idea || !idea.trim()) {
        res.status(400).json({ error: 'idea is required' });
        return;
      }
      const validTypes = ['backend-only', 'full-stack', 'cli-tool', 'library'];
      if (!project_type || !validTypes.includes(project_type)) {
        res.status(400).json({ error: `project_type must be one of: ${validTypes.join(', ')}` });
        return;
      }

      const current = await ctx.session.read(ctx.projectDir);
      if (current.pipeline_status !== 'idle') {
        res.status(409).json({ error: 'Pipeline already started' });
        return;
      }

      const config: import('./types.js').SessionConfig = {
        project_type: project_type as import('./types.js').ProjectType,
        idea: idea.trim(),
        security_enabled: Boolean(security_enabled),
        wrecker_enabled: Boolean(wrecker_enabled),
        is_high_complexity: false,
        spend_cap: typeof spend_cap === 'number' && spend_cap > 0 ? spend_cap : null,
      };

      await ctx.session.update(ctx.projectDir, { config });
      res.json({ ok: true });

      // Signal the CLI loop to start the pipeline now that setup is complete
      ctx.setupResolver?.();
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /agent/retry
   * Signals the Conductor to retry the agent currently in error state.
   */
  app.post('/agent/retry', (req: Request, res: Response) => {
    const { role } = req.body as { role?: string };
    if (!role) { res.status(400).json({ error: 'role required' }); return; }
    ctx.conductor.handleAgentRetry(role);
    res.json({ ok: true });
  });

  /**
   * POST /agent/skip
   * Signals the Conductor to skip the agent currently in error state (skippable agents only).
   */
  app.post('/agent/skip', (req: Request, res: Response) => {
    const { role } = req.body as { role?: string };
    if (!role) { res.status(400).json({ error: 'role required' }); return; }
    ctx.conductor.handleAgentSkip(role);
    res.json({ ok: true });
  });

  /**
   * POST /budget/update
   * Body: { new_cap: number }
   */
  app.post('/budget/update', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { new_cap } = req.body as { new_cap: number };
      if (typeof new_cap !== 'number' || new_cap <= 0) {
        res.status(400).json({ error: 'new_cap must be a positive number' });
        return;
      }
      const current = await ctx.session.read(ctx.projectDir);
      await ctx.session.update(ctx.projectDir, {
        config: { ...current.config, spend_cap: new_cap },
        pipeline_status: 'agent_running',
      });
      // Resume the Conductor if it is waiting on a budget gate
      ctx.conductor.handleBudgetUpdate();
      res.json({ ok: true, new_cap });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /budget/abort
   * Abandons the pipeline when blocked on a budget gate.
   */
  app.post('/budget/abort', (_req: Request, res: Response) => {
    ctx.conductor.handleBudgetAbort();
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
    ctx.logger.error('server.error', err.message);
    res.status(500).json({ error: err.message });
  });

  // ─── HTTP + WebSocket server ──────────────────────────────────────────────

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

  // Expose broadcast to conductor
  ctx.conductor.setBroadcast(broadcast);

  wss.on('connection', async (ws) => {
    clients.add(ws);
    ctx.logger.debug('ws.connect', 'WebSocket client connected');

    // Send full state snapshot on connect
    try {
      const state: SessionState = await ctx.session.read(ctx.projectDir);
      ws.send(JSON.stringify({ type: 'state:snapshot', state } satisfies WsServerEvent));
      // Re-send any active gates that aren't stored in the snapshot
      ctx.conductor.resendPendingEventsTo(ws);
    } catch { /* state may not exist yet */ }

    ws.on('close', () => {
      clients.delete(ws);
      ctx.logger.debug('ws.disconnect', 'WebSocket client disconnected');
    });

    ws.on('error', (err) => {
      ctx.logger.warn('ws.error', err.message);
      clients.delete(ws);
    });
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
