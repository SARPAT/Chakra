// Express Adapter — Express.js middleware integration
// Translates Dispatcher outcomes into Express request/response operations.

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Dispatcher } from '../core/dispatcher';
import type RPMEngine from '../background/rpm-engine';
import type { ShadowModeObserver } from '../background/shadow-mode/observer';

// ─── Session ID extraction ────────────────────────────────────────────────────

/**
 * Extract session ID from an Express request.
 * Checks X-Session-ID header first, then cookie named "sessionId".
 */
function extractSessionId(req: Request): string | undefined {
  const header = req.headers['x-session-id'];
  if (typeof header === 'string' && header.length > 0) return header;

  // Try cookie if cookie-parser is installed — access via `req.cookies` (optional)
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  if (cookies?.sessionId) return cookies.sessionId;

  return undefined;
}

// ─── Dispatch middleware ──────────────────────────────────────────────────────

/**
 * Create the Express middleware function that applies CHAKRA dispatch decisions.
 *
 * - SERVE_FULLY  → next()
 * - SERVE_LIMITED → set X-Chakra headers + next()
 * - SUSPEND      → send fallback response directly, backend never sees request
 */
export function createExpressMiddleware(dispatcher: Dispatcher): RequestHandler {
  return function chakraDispatch(req: Request, res: Response, next: NextFunction): void {
    try {
      const sessionId = extractSessionId(req);
      const outcome = dispatcher.dispatch(req.method, req.path, sessionId);

      switch (outcome.type) {
        case 'SERVE_FULLY':
          next();
          return;

        case 'SERVE_LIMITED':
          res.setHeader('X-Chakra-Mode', 'limited');
          res.setHeader('X-Chakra-Hint', outcome.hint);
          next();
          return;

        case 'SUSPEND': {
          const r = outcome.response;
          if (r.headers) {
            for (const [k, v] of Object.entries(r.headers)) {
              res.setHeader(k, v);
            }
          }
          if (typeof r.body === 'string') {
            res.status(r.status).send(r.body);
          } else {
            res.status(r.status).json(r.body);
          }
          return;
        }
      }
    } catch {
      // Never throw from hot path — pass through on unexpected error
      next();
    }
  };
}

// ─── RPM recorder ────────────────────────────────────────────────────────────

/**
 * Create an Express middleware that records each completed request in the RPM Engine.
 * Uses res.on('finish') to capture response time and status code.
 * Must be mounted BEFORE the dispatch middleware so timing starts from request receipt.
 */
export function createRPMRecorder(
  rpmEngine: RPMEngine,
  getBlock: (method: string, path: string) => string,
): RequestHandler {
  return function chakraRPMRecorder(req: Request, res: Response, next: NextFunction): void {
    const startTime = Date.now();

    res.on('finish', () => {
      try {
        rpmEngine.recordRequest({
          endpoint: `${req.method.toUpperCase()} ${req.path}`,
          block: getBlock(req.method, req.path),
          responseTimeMs: Date.now() - startTime,
          statusCode: res.statusCode,
        });
      } catch {
        /* recording failure must never surface to the app */
      }
    });

    next();
  };
}
