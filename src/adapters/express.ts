// Express adapter.
//
//   app.use(expressMiddleware(core, table));
//   app.post('/checkout', route('critical'), handler);
//
// Admission runs before routing, so the route pattern is not known per request.
// Instead, on the first request the app's router stack is walked once and every
// route tagged with route() is added to the table by its pattern.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AdmissionCore, ChakraRequestInfo, RouteRuleInput, RouteTable } from '../types';
import { getRouteTag } from '../priority/route';
import { addUnlessConfigured, serialiseShed } from './shared';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by CHAKRA on admitted requests. */
      chakra?: ChakraRequestInfo;
    }
  }
}

export function expressMiddleware(core: AdmissionCore, table: RouteTable): RequestHandler {
  let discovered = false;
  return function chakra(req: Request, res: Response, next: NextFunction): void {
    if (!discovered) {
      discovered = true;
      discoverRoutes(req.app, table);
    }
    const decision = core.decide({
      method: req.method,
      path: req.path,
      headers: req.headers,
      user: (req as { user?: unknown }).user,
      raw: req,
    });
    if (decision.outcome === 'shed') {
      const s = serialiseShed(decision.response);
      if (!res.headersSent) {
        res.statusCode = s.status;
        for (const k in s.headers) res.setHeader(k, s.headers[k]);
      }
      res.end(s.body);
      return;
    }
    req.chakra = decision.info;
    // 'close' fires after 'finish' too, so one listener covers success and abort.
    res.once('close', () => decision.done(res.statusCode, !res.writableFinished));
    next();
  };
}

// ─── Route discovery (Express 4 router internals) ───────────────────────────

interface Layer {
  route?: { path: unknown; methods: Record<string, boolean>; stack: Layer[] };
  handle?: { stack?: Layer[] };
  regexp?: RegExp & { fast_slash?: boolean };
}

function discoverRoutes(app: unknown, table: RouteTable): void {
  try {
    const router = (app as { _router?: { stack?: Layer[] } })._router;
    walk(router?.stack, '', table);
  } catch {
    // Discovery is best effort: config routes still apply.
  }
}

function walk(stack: Layer[] | undefined, prefix: string, table: RouteTable): void {
  for (const layer of stack ?? []) {
    if (layer.route) {
      let tag: RouteRuleInput | undefined;
      for (const l of layer.route.stack) tag ??= getRouteTag(l.handle);
      if (!tag) continue;
      const methods = layer.route.methods._all
        ? ['*']
        : Object.keys(layer.route.methods).map((m) => m.toUpperCase());
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        if (typeof p === 'string')
          for (const m of methods) addUnlessConfigured(table, m, prefix + p, tag);
      }
    } else if (layer.handle?.stack) {
      const mount = mountPath(layer);
      if (mount !== null) walk(layer.handle.stack, prefix + mount, table);
    }
  }
}

/** Static mount path of a router layer ('' for '/'), or null when it has params. */
function mountPath(layer: Layer): string | null {
  if (!layer.regexp || layer.regexp.fast_slash) return '';
  const m = /^\^((?:\\\/[\w.~-]+)+)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
  return m ? m[1].replace(/\\\//g, '/') : null;
}
