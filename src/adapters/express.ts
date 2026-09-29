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
import { CHAKRA_TAG_CHECK, getRouteTag } from '../priority/route';
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

export function expressMiddleware(
  core: AdmissionCore,
  table: RouteTable,
  warn: (msg: string) => void = () => {},
): RequestHandler {
  let discovered = false;
  const checked = new WeakSet<RouteRuleInput>();
  // Called by route() once per tag: warns when discovery missed the route, which
  // happens for routers mounted below '/' on Express 5 (they keep no mount path).
  const checkTag = (r: Request, rule: RouteRuleInput): void => {
    if (checked.has(rule)) return;
    checked.add(rule);
    if (table.match({ method: r.method, path: r.baseUrl + r.path, headers: {} })) return;
    const pattern = typeof r.route?.path === 'string' ? r.route.path : '?';
    warn(
      `chakra.route('${rule.priority}') on "${r.method} ${pattern}" was not discovered (router mounted below "/"?). ` +
        `Declare it in the routes option with its full path instead.`,
    );
  };
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
    (req as { [CHAKRA_TAG_CHECK]?: typeof checkTag })[CHAKRA_TAG_CHECK] = checkTag;
    // 'close' fires after 'finish' too, so one listener covers success and abort.
    res.once('close', () => decision.done(res.statusCode, !res.writableFinished));
    next();
  };
}

// ─── Route discovery (Express 4 router internals) ───────────────────────────

interface Layer {
  route?: { path: unknown; methods: Record<string, boolean>; stack: Layer[] };
  handle?: { stack?: Layer[] };
  /** Express 4. */
  regexp?: RegExp & { fast_slash?: boolean };
  /** Express 5: true when mounted at '/'. */
  slash?: boolean;
}

function discoverRoutes(app: unknown, table: RouteTable): void {
  try {
    // Express 4 keeps the router on `_router`, Express 5 on `router`.
    const a = app as { _router?: { stack?: Layer[] }; router?: { stack?: Layer[] } };
    walk((a._router ?? a.router)?.stack, '', table);
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

/**
 * Static mount path of a router layer ('' for '/'), or null when it cannot be
 * recovered (params, or any non-root mount on Express 5, which keeps no path).
 * Tags under such mounts are not applied; route() warns about them once.
 */
function mountPath(layer: Layer): string | null {
  if (layer.slash || layer.regexp?.fast_slash) return '';
  if (!layer.regexp) return null;
  const m = /^\^((?:\\\/[\w.~-]+)+)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
  return m ? m[1].replace(/\\\//g, '/') : null;
}
