// CHAKRA — priority-aware adaptive load shedding for Node.js.
// Design: docs/adr/0001-adaptive-admission-control.md
//
//   import { chakra } from 'chakra-middleware';
//   const c = chakra({ routes: { 'POST /checkout': 'critical', 'GET /recommendations': 'sheddable' } });
//   app.get('/metrics', c.metricsHandler);
//
// The Express/Fastify adapters, adaptive limiter and Prometheus exporter are wired in
// here as their modules land; until then the stand-ins in src/core/defaults.ts are used.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  NOOP_SINK,
  type ChakraEventSink,
  type Limiter,
  type LimiterSnapshot,
  type MetricsExporter,
} from './types';
import { resolveOptions, type ChakraOptions, type ResolvedOptions } from './config/schema';
import { createAdmissionCore, type ControllableAdmissionCore } from './core/admission';
import { admitAllLimiter, exactRouteResolver } from './core/defaults';

export interface ChakraInstance extends ControllableAdmissionCore {
  /** Options after defaults and `CHAKRA_MODE` are applied. */
  readonly options: ResolvedOptions;
  /** Current limiter state. */
  snapshot(): LimiterSnapshot;
  /** Prometheus scrape handler, usable as `app.get('/metrics', c.metricsHandler)`. */
  metricsHandler(req: IncomingMessage, res: ServerResponse): void;
  /** Stop background timers. Safe to call more than once. */
  close(): void;
}

/**
 * Create a CHAKRA instance. Throws ChakraConfigError for invalid options;
 * nothing after construction throws into the application.
 */
export function chakra(options: ChakraOptions = {}): ChakraInstance {
  const resolved = resolveOptions(options);
  const sink = createSink(resolved);
  const limiter: Limiter = admitAllLimiter();
  const resolver = exactRouteResolver(resolved.routes);
  const core = createAdmissionCore({ options: resolved, limiter, resolver, sink });

  if (resolved.mode !== 'off') limiter.start();
  if (resolved.logger) {
    resolved.logger.info(
      `mode=${resolved.mode} routes=${Object.keys(resolved.routes).length} default=${resolved.defaultPriority}`,
    );
  }

  let closed = false;
  return {
    options: resolved,
    get mode() {
      return core.mode;
    },
    decide: core.decide,
    setOverrides: core.setOverrides,
    getOverrides: core.getOverrides,
    snapshot: () => limiter.snapshot(),
    metricsHandler: (_req, res) => serveMetrics(sink, res),
    close() {
      if (closed) return;
      closed = true;
      limiter.stop();
    },
  };
}

function createSink(options: ResolvedOptions): ChakraEventSink {
  if (options.metrics === false) return NOOP_SINK;
  if (isSink(options.metrics)) return options.metrics;
  // Prometheus exporter is wired in when src/observability/ lands.
  return NOOP_SINK;
}

function serveMetrics(sink: ChakraEventSink, res: ServerResponse): void {
  try {
    if (!isExporter(sink)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('CHAKRA metrics are disabled\n');
      return;
    }
    const body = sink.render();
    res.statusCode = 200;
    res.setHeader('Content-Type', sink.contentType);
    res.end(body);
  } catch {
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  }
}

function isSink(value: unknown): value is ChakraEventSink {
  return typeof value === 'object' && value !== null && typeof (value as ChakraEventSink).emit === 'function';
}

function isExporter(sink: ChakraEventSink): sink is MetricsExporter {
  return typeof (sink as MetricsExporter).render === 'function';
}

export { ChakraConfigError, type ChakraOptions, type MetricsOptions, type ResolvedOptions } from './config/schema';
export type { Overrides } from './core/admission';
export * from './types';
