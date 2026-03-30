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
      const relPath = req.query['path'] as string;
      if (!relPath) {
        res.status(400).json({ error: 'path query param required' });
        return;
      }
      const claDosDir = path.join(ctx.projectDir, '.clados');
      const filePath = path.resolve(claDosDir, relPath);
      // Security: use path.relative to guard against path traversal + Windows case-insensitivity (H-9)
      const relative = path.relative(path.resolve(claDosDir), filePath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
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
