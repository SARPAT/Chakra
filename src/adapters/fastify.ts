// Fastify adapter.
//
//   app.register(fastifyPlugin(core, table));
//   app.post('/checkout', { config: { chakra: 'critical' } }, handler);
//
// Register it before your routes: route priorities are read from each route's
// `config.chakra` as it is added. Fastify routes before hooks run, so the
// matched pattern is known per request. The plugin skips encapsulation, so its
// hooks apply to routes in child plugins too. Fastify is only a type import.

import type { ServerResponse } from 'node:http';
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
type Res = ServerResponse & { [kDecision]?: AdmitDecision };

/** Shared 'close' listener: no closure per request. 'close' also fires after a normal finish. */
function onClose(this: Res): void {
  this[kDecision]!.done(this.statusCode, !this.writableEnded);
}

interface RouteConfig {
  url?: string;
  method?: string | string[];
  chakra?: Priority | RouteRuleInput;
}

// `request.routeOptions` builds a new object with getters on every access, which
// costs a few µs per request. The route's config object (with its url and method)
// sits on Fastify's own route context, so read it directly, found once by the
// symbol's description, and fall back to the public getter if it is ever missing.
let kContext: symbol | null | undefined;
function routeConfig(request: FastifyRequest): RouteConfig | undefined {
  if (kContext === undefined) {
    kContext =
      Object.getOwnPropertySymbols(request).find((s) => s.description === 'fastify.context') ??
      null;
  }
  const context =
    kContext && (request as unknown as Record<symbol, { config?: RouteConfig }>)[kContext];
  return context ? context.config : (request.routeOptions.config as RouteConfig | undefined);
}

export function fastifyPlugin(
  core: AdmissionCore,
  table: RouteTable,
  options: FastifyAdapterOptions = {},
): FastifyPluginCallback {
  const plugin: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
    app.decorateRequest('chakra', null);

    const learn = (methods: string | string[], url: string, tag: Priority | RouteRuleInput) => {
      const rule = typeof tag === 'string' ? { priority: tag } : tag;
      for (const method of ([] as string[]).concat(methods))
        addUnlessConfigured(table, method, url, rule);
    };
    app.addHook('onRoute', (route) => {
      if (route.config?.chakra !== undefined) learn(route.method, route.url, route.config.chakra);
    });

    // With mode 'off' CHAKRA is a pure pass-through: add no per-request hooks at all.
    if ((core as { mode?: string }).mode === 'off') return done();

    // Routes added before this plugin loaded (e.g. `app.register(c.fastify)` without
    // await) miss onRoute; learn their tag from the matched route, once per route.
    const learned = new WeakSet<object>();

    app.addHook(
      options.hook ?? 'onRequest',
      (request: FastifyRequest, reply: FastifyReply, next: () => void) => {
        const config = routeConfig(request);
        if (config?.chakra !== undefined && config.url !== undefined && !learned.has(config)) {
          learned.add(config);
          try {
            learn(config.method ?? request.method, config.url, config.chakra);
          } catch {
            // An invalid tag must not fail the request; the route keeps its default.
          }
        }
        const url = request.url;
        const q = url.indexOf('?');
        const decision = core.decide({
          method: request.method,
          path: q < 0 ? url : url.slice(0, q),
          route: config?.url,
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
        const res = reply.raw as Res;
        res[kDecision] = decision;
        res.once('close', onClose);
        next();
      },
    );

    done();
  };
  const meta = plugin as unknown as Record<symbol, unknown>;
  meta[Symbol.for('skip-override')] = true;
  meta[Symbol.for('fastify.display-name')] = 'chakra';
  return plugin;
}
