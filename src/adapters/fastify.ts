// Fastify adapter.
//
//   app.register(fastifyPlugin(core, table));
//   app.post('/checkout', { config: { chakra: 'critical' } }, handler);
//
// Register it before your routes: route priorities are read from each route's
// `config.chakra` as it is added. Fastify routes before hooks run, so the
// matched pattern is known per request. The plugin skips encapsulation, so its
// hooks apply to routes in child plugins too. Fastify is only a type import.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AdmissionCore,
  AdmitDecision,
  ChakraRequestInfo,
  Priority,
  RouteRuleInput,
  RouteTable,
} from '../types';
import { addUnlessConfigured, serialiseShed } from './shared';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by CHAKRA on admitted requests. */
    chakra: ChakraRequestInfo | null;
  }
  interface FastifyContextConfig {
    /** Declared priority of this route. */
    chakra?: Priority | RouteRuleInput;
  }
}

export interface FastifyAdapterOptions {
  /**
   * Hook that runs admission. Default 'onRequest' (earliest). Use 'preHandler'
   * when priority depends on `request.user` set by an auth hook.
   */
  hook?: 'onRequest' | 'preHandler';
}

const kDecision = Symbol('chakra.decision');
type Req = FastifyRequest & { [kDecision]: AdmitDecision | null };

export function fastifyPlugin(
  core: AdmissionCore,
  table: RouteTable,
  options: FastifyAdapterOptions = {},
): FastifyPluginCallback {
  const plugin: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
    app.decorateRequest('chakra', null);
    app.decorateRequest(kDecision, null);

    app.addHook('onRoute', (route) => {
      const tag = route.config?.chakra;
      if (tag === undefined) return;
      const rule = typeof tag === 'string' ? { priority: tag } : tag;
      for (const method of ([] as string[]).concat(route.method))
        addUnlessConfigured(table, method, route.url, rule);
    });

    // Routes added before this plugin loaded (e.g. `app.register(c.fastify)` without
    // await) miss onRoute; learn their tag from the matched route on first request.
    const learned = new Set<string>();

    app.addHook(
      options.hook ?? 'onRequest',
      (request: FastifyRequest, reply: FastifyReply, next: () => void) => {
        const tag = request.routeOptions.config?.chakra;
        if (tag !== undefined && request.routeOptions.url !== undefined) {
          const key = request.method + ' ' + request.routeOptions.url;
          if (!learned.has(key)) {
            learned.add(key);
            const rule = typeof tag === 'string' ? { priority: tag } : tag;
            addUnlessConfigured(table, request.method, request.routeOptions.url, rule);
          }
        }
        const url = request.url;
        const q = url.indexOf('?');
        const decision = core.decide({
          method: request.method,
          path: q < 0 ? url : url.slice(0, q),
          route: request.routeOptions.url,
          headers: request.headers,
          user: (request as { user?: unknown }).user,
          raw: request,
        });
        if (decision.outcome === 'shed') {
          const s = serialiseShed(decision.response);
          reply.code(s.status).headers(s.headers).send(s.body);
          return;
        }
        request.chakra = decision.info;
        (request as Req)[kDecision] = decision;
        next();
      },
    );

    app.addHook('onResponse', (request, reply, next) => {
      (request as Req)[kDecision]?.done(reply.statusCode, false);
      next();
    });

    app.addHook('onRequestAbort', (request, next) => {
      (request as Req)[kDecision]?.done(499, true);
      next();
    });

    done();
  };
  const meta = plugin as unknown as Record<symbol, unknown>;
  meta[Symbol.for('skip-override')] = true;
  meta[Symbol.for('fastify.display-name')] = 'chakra';
  return plugin;
}
