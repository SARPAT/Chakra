// Shadow Mode Observer — Async request observation
//
// The One Absolute Rule: Shadow Mode observes. It never touches a request.
// Never changes a response. Zero side effects on the request path.
//
// Observation happens async (setImmediate) so it adds zero latency.
// Captures per-request metadata for storage and analysis.
// All PII (session tokens, user IDs) is SHA-256 hashed before storage.
// Never stores request/response bodies.

import * as path from 'path';
import Database from 'better-sqlite3';
import type { SessionContext } from '../../types';
import type { SessionCache } from '../session-cache';
import { hashId } from '../../utils/hasher';
import { logger } from '../../utils/logger';

// ─── Observation record ───────────────────────────────────────────────────────

export interface ObservationRecord {
  timestamp: number;
  sessionId: string | null;        // hashed
  userId: string | null;           // hashed, null if anonymous
  method: string;
  endpoint: string;                // normalised (params replaced with :param)
  rawEndpoint: string;             // original path (no body, just URL)
  responseTimeMs: number;
  statusCode: number;
  requestSize: number;
  responseSize: number;
  deviceClass: string;             // 'mobile' | 'desktop' | 'bot' | 'unknown'
  isAuthenticated: boolean;
  sessionDepth: number;            // how many calls this session has made so far
}

// ─── Raw request info (passed in by Express adapter) ─────────────────────────

export interface RequestSnapshot {
  method: string;
  path: string;
  sessionToken?: string;           // raw — will be hashed
  userId?: string;                 // raw — will be hashed
  userAgent?: string;
  contentLength?: number;
  isAuthenticated?: boolean;
}

export interface ResponseSnapshot {
  statusCode: number;
  responseTimeMs: number;
  contentLength?: number;
}

// ─── Configuration ─────────────────────────────────────────────────────────────

export interface ObserverConfig {
  /** Directory where the SQLite DB file is stored. Default: process.cwd() */
  dbDir?: string;
  /** SQLite DB file name. Default: chakra-shadow.db */
  dbFile?: string;
  /** Max raw observations to keep (rolling window). Default: 2_592_000 (~30 days at 1 req/s) */
  maxObservations?: number;
  /** How often (ms) to run the observation purge. Default: 3_600_000 (1 hour) */
  purgeIntervalMs?: number;
  /** Session cache — updated on each observation */
  sessionCache?: SessionCache;
}

const DEFAULT_DB_FILE = 'chakra-shadow.db';
const DEFAULT_MAX_OBSERVATIONS = 2_592_000;
const DEFAULT_PURGE_INTERVAL_MS = 60 * 60 * 1_000;   // 1 hour

// ─── Endpoint normalisation ───────────────────────────────────────────────────

const PARAM_PATTERNS: [RegExp, string][] = [
  [/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid'],
  [/\/[a-f0-9]{24}(?![0-9a-f])/gi, '/:objectid'], // MongoDB ObjectId — must come before numeric patterns
  [/\/\d{10,}/g, '/:id'],             // long numeric IDs (snowflake etc.)
  [/\/\d+/g, '/:id'],                 // short numeric IDs
];

export function normalizeEndpoint(rawPath: string): string {
  let normalized = rawPath.split('?')[0];  // strip query string
  for (const [pattern, replacement] of PARAM_PATTERNS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized;
}

// ─── Device classification ────────────────────────────────────────────────────

export function classifyDevice(userAgent?: string): string {
  if (!userAgent) return 'unknown';
  const ua = userAgent.toLowerCase();
  if (/bot|crawler|spider|scraper/i.test(ua)) return 'bot';
  if (/mobile|android|iphone|ipad/i.test(ua)) return 'mobile';
  return 'desktop';
}

// ─── ShadowModeObserver ───────────────────────────────────────────────────────

export class ShadowModeObserver {
  private db: Database.Database | null = null;
  private readonly sessionCache?: SessionCache;
  private readonly maxObservations: number;
  private purgeInterval: ReturnType<typeof setInterval> | null = null;
  private disabled = false;

  // In-memory session depth counter (hashed session ID → call count)
  private readonly sessionDepths = new Map<string, number>();

  constructor(config: ObserverConfig = {}) {
    this.sessionCache = config.sessionCache;
    this.maxObservations = config.maxObservations ?? DEFAULT_MAX_OBSERVATIONS;

    try {
      const dir = config.dbDir ?? process.cwd();
      const file = config.dbFile ?? DEFAULT_DB_FILE;
      const dbPath = path.join(dir, file);

      this.db = new Database(dbPath);
      this.initSchema();

      const purgeMs = config.purgeIntervalMs ?? DEFAULT_PURGE_INTERVAL_MS;
      this.purgeInterval = setInterval(() => {
        try { this.purgeOldObservations(); } catch { /* never propagate */ }
      }, purgeMs);

      if (typeof this.purgeInterval.unref === 'function') {
        this.purgeInterval.unref();
      }
    } catch (err) {
      logger.warn(
        `Shadow Mode Observer failed to initialise DB: ` +
        `${err instanceof Error ? err.message : String(err)}. Observer disabled.`,
      );
      this.disabled = true;
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Record an observation asynchronously (via setImmediate).
   * Called from the Express adapter after each response.
   * Zero latency added to the request path.
   */
  observe(req: RequestSnapshot, res: ResponseSnapshot): void {
    if (this.disabled) return;

    setImmediate(() => {
      try {
        this.recordObservation(req, res);
      } catch { /* never propagate */ }
    });
  }

  /** Stop all background intervals. Safe to call multiple times. */
  stop(): void {
    if (this.purgeInterval !== null) {
      clearInterval(this.purgeInterval);
      this.purgeInterval = null;
    }
    if (this.db !== null) {
      try { this.db.close(); } catch { /* ignore */ }
      this.db = null;
    }
  }

  /** Whether the observer is active (DB open and ready). */
  isActive(): boolean {
    return !this.disabled && this.db !== null;
  }

  /**
   * Fetch the most recent N observations for analysis.
   * Returns [] if DB is unavailable.
   */
  getRecentObservations(limit = 1000): ObservationRecord[] {
    if (this.db === null) return [];
    try {
      const rows = this.db.prepare(
        `SELECT * FROM observations ORDER BY timestamp DESC LIMIT ?`,
      ).all(limit) as Record<string, unknown>[];
      return rows.map(r => this.mapRow(r));
    } catch {
      return [];
    }
  }

  /**
   * Total number of observations stored.
   */
  getObservationCount(): number {
    if (this.db === null) return 0;
    try {
      const row = this.db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
      return row.count;
    } catch {
      return 0;
    }
  }

  // ─── Core recording logic ─────────────────────────────────────────────────────

  private recordObservation(req: RequestSnapshot, res: ResponseSnapshot): void {
    if (this.db === null) return;

    const hashedSession = hashId(req.sessionToken);
    const hashedUser = hashId(req.userId);
    const depth = this.updateSessionDepth(hashedSession);

    const record: ObservationRecord = {
      timestamp: Date.now(),
      sessionId: hashedSession,
      userId: hashedUser,
      method: req.method.toUpperCase(),
      endpoint: normalizeEndpoint(req.path),
      rawEndpoint: req.path.split('?')[0],
      responseTimeMs: res.responseTimeMs,
      statusCode: res.statusCode,
      requestSize: req.contentLength ?? 0,
      responseSize: res.contentLength ?? 0,
      deviceClass: classifyDevice(req.userAgent),
      isAuthenticated: req.isAuthenticated ?? false,
      sessionDepth: depth,
    };

    this.db.prepare(`
      INSERT INTO observations (
        timestamp, session_id, user_id, method, endpoint, raw_endpoint,
        response_time_ms, status_code, request_size, response_size,
        device_class, is_authenticated, session_depth
      ) VALUES (
        @timestamp, @sessionId, @userId, @method, @endpoint, @rawEndpoint,
        @responseTimeMs, @statusCode, @requestSize, @responseSize,
        @deviceClass, @isAuthenticated, @sessionDepth
      )
    `).run({ ...record, isAuthenticated: record.isAuthenticated ? 1 : 0 });

    // Update session cache if available
    if (this.sessionCache !== null && this.sessionCache !== undefined && hashedSession !== null) {
      this.updateSessionContext(hashedSession, record);
    }
  }

  private updateSessionDepth(hashedSession: string | null): number {
    if (hashedSession === null) return 1;
    const current = (this.sessionDepths.get(hashedSession) ?? 0) + 1;
    this.sessionDepths.set(hashedSession, current);
    // Cap the in-memory depth counter size
    if (this.sessionDepths.size > 50_000) {
      const firstKey = this.sessionDepths.keys().next().value;
      if (firstKey !== undefined) this.sessionDepths.delete(firstKey);
    }
    return current;
  }

  private updateSessionContext(hashedSession: string, record: ObservationRecord): void {
    const existing = this.sessionCache!.get(hashedSession);
    const now = Date.now();

    const recentEndpoints = existing
      ? [...existing.recentEndpoints.slice(-9), record.endpoint]
      : [record.endpoint];

    const updated: SessionContext = {
      callCount: record.sessionDepth,
      hasCartItems: existing?.hasCartItems ?? false,
      cartItemCount: existing?.cartItemCount ?? 0,
      matchesMomentOfValue: existing?.matchesMomentOfValue ?? false,
      momentOfValueStrength: existing?.momentOfValueStrength ?? 'none',
      recentEndpoints,
      userTier: existing?.userTier ?? null,
      sessionAgeSeconds: existing
        ? Math.round((now - existing.lastSeenTime) / 1000) + (existing.sessionAgeSeconds)
        : 0,
      lastSeenTime: now,
    };

    this.sessionCache!.set(hashedSession, updated);
  }

  // ─── Row mapping (SQLite snake_case → camelCase) ──────────────────────────────

  private mapRow(r: Record<string, unknown>): ObservationRecord {
    return {
      timestamp: r['timestamp'] as number,
      sessionId: r['session_id'] as string | null,
      userId: r['user_id'] as string | null,
      method: r['method'] as string,
      endpoint: r['endpoint'] as string,
      rawEndpoint: r['raw_endpoint'] as string,
      responseTimeMs: r['response_time_ms'] as number,
      statusCode: r['status_code'] as number,
      requestSize: r['request_size'] as number,
      responseSize: r['response_size'] as number,
      deviceClass: r['device_class'] as string,
      isAuthenticated: !!(r['is_authenticated'] as number),
      sessionDepth: r['session_depth'] as number,
    };
  }

  // ─── Schema + maintenance ─────────────────────────────────────────────────────

  private initSchema(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp       INTEGER NOT NULL,
        session_id      TEXT,
        user_id         TEXT,
        method          TEXT NOT NULL,
        endpoint        TEXT NOT NULL,
        raw_endpoint    TEXT NOT NULL,
        response_time_ms INTEGER NOT NULL,
        status_code     INTEGER NOT NULL,
        request_size    INTEGER NOT NULL DEFAULT 0,
        response_size   INTEGER NOT NULL DEFAULT 0,
        device_class    TEXT NOT NULL DEFAULT 'unknown',
        is_authenticated INTEGER NOT NULL DEFAULT 0,
        session_depth   INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_observations_timestamp
        ON observations (timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_observations_endpoint
        ON observations (endpoint);
      CREATE INDEX IF NOT EXISTS idx_observations_session
        ON observations (session_id);
    `);
  }

  private purgeOldObservations(): void {
    if (this.db === null) return;

    const row = this.db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
    const excess = row.count - this.maxObservations;
    if (excess <= 0) return;

    this.db.prepare(`
      DELETE FROM observations WHERE id IN (
        SELECT id FROM observations ORDER BY timestamp ASC LIMIT ?
      )
    `).run(excess);
  }
}
