// Dashboard Server — HTTP + WebSocket server for the CHAKRA dashboard
//
// Starts automatically on port 4242 (configurable).
// REST API at /api/* consumed by dashboard frontend.
// WebSocket at /ws streams live data during active incidents.
// Never throws — all handlers catch internally and return safe responses.

import * as http from 'http';
import * as path from 'path';
import * as express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { RPMState } from '../types';
import type { DashboardAPI } from './api';
import type { WebhookAdapter } from '../integrations/container-bridge/webhook';
import { logger } from '../utils/logger';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DashboardServerConfig {
  api: DashboardAPI;
  port?: number;
  /** Optional basic auth credentials. Omit to disable auth (dev environments). */
  auth?: { username: string; password: string };
  /** Optional webhook adapter — enables POST /api/infrastructure-signal endpoint */
  webhookAdapter?: WebhookAdapter;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 4242;

// ─── DashboardServer ──────────────────────────────────────────────────────────

export class DashboardServer {
  private readonly api: DashboardAPI;
  private readonly port: number;
  private readonly auth?: { username: string; password: string };
  private readonly webhookAdapter?: WebhookAdapter;

  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;

  constructor(config: DashboardServerConfig) {
    this.api = config.api;
    this.port = config.port ?? DEFAULT_PORT;
    this.auth = config.auth;
    this.webhookAdapter = config.webhookAdapter;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.httpServer !== null) return;   // idempotent

    const app = this.buildApp();
    this.httpServer = http.createServer(app);
    this.wss = this.buildWebSocketServer(this.httpServer);

    this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn(`Dashboard port ${this.port} already in use — dashboard disabled.`);
      }
    });

    this.httpServer.listen(this.port, () => {
      logger.info(`Dashboard available at http://localhost:${this.port}`);
    });
  }

  stop(): void {
    if (this.wss !== null) {
      this.wss.close();
      this.wss = null;
    }
    if (this.httpServer !== null) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }

  // ─── Real-time push ─────────────────────────────────────────────────────────

  /**
   * Broadcast a live RPM update to all connected WebSocket clients.
   * Called by ChakraInstance on every RPM tick.
   */
  broadcastRPMUpdate(state: RPMState): void {
    this.api.recordRPMSample(state);
    this.broadcast({ type: 'rpm_update', data: state });
  }

  /**
   * Broadcast an activation state change to all connected WebSocket clients.
   * Called by ChakraInstance after activate/deactivate.
   */
  broadcastActivationChange(): void {
    try {
      const status = this.api.status();
      this.broadcast({ type: 'activation_change', data: status });
    } catch { /* never propagate */ }
  }

  // ─── Express app ────────────────────────────────────────────────────────────

  private buildApp(): express.Express {
    const app = express.default ? express.default() : (express as unknown as () => express.Express)();

    app.use((express.default?.json ?? (express as unknown as { json: () => express.RequestHandler }).json)());

    if (this.auth) {
      app.use(this.basicAuthMiddleware.bind(this));
    }

    this.mountRoutes(app);

    return app;
  }

  private mountRoutes(app: express.Express): void {
    // Dashboard UI — serve the HTML frontend at root
    const htmlPath = path.join(__dirname, 'dashboard.html');
    app.get('/', (_req, res) => res.sendFile(htmlPath));

    // GET endpoints
    app.get('/api/status', this.handleGetStatus.bind(this));
    app.get('/api/rpm', this.handleGetRPM.bind(this));
    app.get('/api/blocks', this.handleGetBlocks.bind(this));
    app.get('/api/policies', this.handleGetPolicies.bind(this));
    app.get('/api/learning', this.handleGetLearning.bind(this));
    app.get('/api/history', this.handleGetHistory.bind(this));
    app.get('/api/report/:id', this.handleGetReport.bind(this));
    app.get('/api/config', this.handleGetConfig.bind(this));

    // POST / PUT / DELETE endpoints
    app.post('/api/activate', this.handleActivate.bind(this));
    app.post('/api/deactivate', this.handleDeactivate.bind(this));
    app.post('/api/policies', this.handleCreatePolicy.bind(this));
    app.put('/api/policies/:name', this.handleUpdatePolicy.bind(this));
    app.delete('/api/policies/:name', this.handleDeletePolicy.bind(this));
    app.post('/api/presets/:name', this.handleActivatePreset.bind(this));
    app.post('/api/settings', this.handleUpdateSettings.bind(this));

    // Container Bridge — always mounted; returns 503 if no webhook adapter configured
    app.post('/api/infrastructure-signal', this.handleInfrastructureSignal.bind(this));
  }

  // ─── Route handlers ─────────────────────────────────────────────────────────

  private handleGetStatus(req: Request, res: Response): void {
    try { res.json(this.api.status()); }
    catch (err) { this.internalError(res, err); }
  }

  private handleGetRPM(req: Request, res: Response): void {
    try { res.json(this.api.rpm()); }
    catch (err) { this.internalError(res, err); }
  }

  private handleGetBlocks(req: Request, res: Response): void {
    try { res.json(this.api.blocks()); }
    catch (err) { this.internalError(res, err); }
  }

  private handleGetPolicies(req: Request, res: Response): void {
    try { res.json(this.api.getPolicies()); }
    catch (err) { this.internalError(res, err); }
  }

  private handleGetLearning(req: Request, res: Response): void {
    try { res.json(this.api.learning()); }
    catch (err) { this.internalError(res, err); }
  }

  private handleGetHistory(req: Request, res: Response): void {
    try { res.json(this.api.history()); }
    catch (err) { this.internalError(res, err); }
  }

  private handleGetReport(req: Request, res: Response): void {
    try {
      const report = this.api.report(req.params.id);
      if (report === null) { res.status(404).json({ error: 'Report not found' }); return; }
      res.json(report);
    } catch (err) { this.internalError(res, err); }
  }

  private handleGetConfig(req: Request, res: Response): void {
    try { res.json(this.api.getConfig()); }
    catch (err) { this.internalError(res, err); }
  }

  private handleActivate(req: Request, res: Response): void {
    try {
      const { level, initiatedBy } = req.body as { level?: number; initiatedBy?: string };
      this.api.activate(level, initiatedBy);
      this.broadcastActivationChange();
      res.json({ ok: true });
    } catch (err) { this.internalError(res, err); }
  }

  private handleDeactivate(req: Request, res: Response): void {
    try {
      const { sequence, initiatedBy } = req.body as {
        sequence?: 'gradual' | 'immediate';
        initiatedBy?: string;
      };
      this.api.deactivate(sequence, initiatedBy);
      this.broadcastActivationChange();
      res.json({ ok: true });
    } catch (err) { this.internalError(res, err); }
  }

  private handleCreatePolicy(req: Request, res: Response): void {
    try {
      this.api.createPolicy(req.body);
      res.status(201).json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  private handleUpdatePolicy(req: Request, res: Response): void {
    try {
      this.api.updatePolicy(req.params.name, req.body);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  private handleDeletePolicy(req: Request, res: Response): void {
    try {
      this.api.deletePolicy(req.params.name);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  private handleActivatePreset(req: Request, res: Response): void {
    try {
      this.api.activatePreset(req.params.name);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  private handleUpdateSettings(req: Request, res: Response): void {
    try {
      this.api.updateSettings(req.body);
      res.json({ ok: true });
    } catch (err) { this.internalError(res, err); }
  }

  private handleInfrastructureSignal(req: Request, res: Response): void {
    if (!this.webhookAdapter) {
      res.status(503).json({ error: 'No webhook adapter configured' });
      return;
    }
    try {
      const accepted = this.webhookAdapter.receiveSignal(req.body);
      if (!accepted) {
        res.status(400).json({ error: 'Invalid signal payload. Required: scaling_in_progress (bool), capacity_limit_reached (bool)' });
        return;
      }
      res.json({ ok: true });
    } catch (err) { this.internalError(res, err); }
  }

  // ─── WebSocket ───────────────────────────────────────────────────────────────

  private buildWebSocketServer(server: http.Server): WebSocketServer {
    const wss = new WebSocketServer({ server, path: '/ws' });

    wss.on('connection', (ws: WebSocket) => {
      // Send current status snapshot immediately on connect
      try {
        ws.send(JSON.stringify({ type: 'snapshot', data: this.api.status() }));
      } catch { /* client may have disconnected */ }
    });

    return wss;
  }

  private broadcast(message: unknown): void {
    if (this.wss === null) return;
    const payload = JSON.stringify(message);
    this.wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(payload); } catch { /* ignore stale clients */ }
      }
    });
  }

  // ─── Auth ────────────────────────────────────────────────────────────────────

  private basicAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="CHAKRA Dashboard"');
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const encoded = authHeader.slice('Basic '.length);
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const [username, ...rest] = decoded.split(':');
    const password = rest.join(':');

    if (this.auth && username === this.auth.username && password === this.auth.password) {
      next();
    } else {
      res.setHeader('WWW-Authenticate', 'Basic realm="CHAKRA Dashboard"');
      res.status(401).json({ error: 'Invalid credentials' });
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private internalError(res: Response, err: unknown): void {
    logger.error(`Dashboard API error: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Internal error' });
  }
}
