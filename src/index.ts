// CHAKRA — priority-aware adaptive load shedding for Node.js.
// Design: docs/adr/0001-adaptive-admission-control.md
//
//   import { chakra } from 'chakra-middleware';
//   const c = chakra({ routes: { 'POST /checkout': 'critical', 'GET /recommendations': 'sheddable' } });
//   app.get('/metrics', c.metricsHandler);
//
//   app.use(c);                                   // Express
//   app.register(c.fastify);                      // Fastify

import type { ServerResponse } from 'node:http';
import {
  NOOP_SINK,
  type ChakraEventSink,
  type Limiter,
  type LimiterSnapshot,
  type MetricsExporter,
} from './types';
import { resolveOptions, type ChakraOptions, type ResolvedOptions } from './config/schema';
import { createAdmissionCore, type ControllableAdmissionCore } from './core/admission';
import { createRouteTable, EMERGENCY_PRESETS, route, type EmergencyPreset } from './priority';
import { expressMiddleware } from './adapters/express';
import { fastifyPlugin, type FastifyAdapterOptions } from './adapters/fastify';
import { createLimiter } from './limiter';
import { createPrometheusExporter } from './observability/prometheus';
import { createDryRunReporter, type DryRunReport } from './observability/dry-run';
import { createEventBus } from './observability/event-bus';

type ExpressHandler = ReturnType<typeof expressMiddleware>;
type FastifyPlugin = ReturnType<typeof fastifyPlugin>;

/** A CHAKRA instance is itself Express middleware: `app.use(c)`. */
export interface ChakraInstance extends ControllableAdmissionCore, ExpressHandler {
  /** Options after defaults and `CHAKRA_MODE` are applied. */
  readonly options: ResolvedOptions;
  /** Express middleware (the instance itself). */
  readonly express: ExpressHandler;
  /** Fastify plugin: `app.register(c.fastify)`. Admission runs in `onRequest`. */
  readonly fastify: FastifyPlugin;
  /** Fastify plugin with options, e.g. `{ hook: 'preHandler' }` when priority uses `request.user`. */
  fastifyPlugin(options?: FastifyAdapterOptions): FastifyPlugin;
  /** Apply a named emergency preset, e.g. `'shed-normal'`. `'restore-all'` reopens every band. */
  applyPreset(name: EmergencyPreset): void;
  /** Current limiter state. */
  snapshot(): LimiterSnapshot;
  /**
   * Prometheus scrape handler, usable as `app.get('/metrics', c.metricsHandler)` in
   * Express, Fastify or a plain `http` server.
   */
  metricsHandler(req: unknown, res: ServerResponse | FastifyLikeReply): void;
  /** Dry-run mode only: what would have been shed or degraded, per route. */
  dryRunReport(): DryRunReport | undefined;
  /** Stop background timers. Safe to call more than once. */
  close(): void;
}

/**
 * Create a CHAKRA instance. Throws ChakraConfigError for invalid options;
 * nothing after construction throws into the application.
 */
export function chakra(options: ChakraOptions = {}): ChakraInstance {
  const resolved = resolveOptions(options);
  const reporter =
    resolved.mode === 'dry-run' ? createDryRunReporter(dryRunLog(resolved)) : undefined;
  const metrics = createMetricsSink(resolved);
  const sink = reporter ? createEventBus(metrics, reporter) : metrics;
  const limiter: Limiter = createLimiter(resolved.limiter, sink);
  const table = createRouteTable({ ...resolved.routes });
  const core = createAdmissionCore({ options: resolved, limiter, resolver: table, sink });
  const logger = resolved.logger;
  const express = expressMiddleware(core, table, (msg) => logger && logger.warn(msg));

  if (resolved.mode !== 'off') limiter.start();
  if (resolved.logger) {
    resolved.logger.info(
      `mode=${resolved.mode} routes=${Object.keys(resolved.routes).length} default=${resolved.defaultPriority}`,
    );
  }

  let closed = false;
  return Object.assign(express, {
    options: resolved,
    mode: core.mode,
    decide: core.decide,
    setOverrides: core.setOverrides,
    getOverrides: core.getOverrides,
    express,
    fastify: fastifyPlugin(core, table),
    fastifyPlugin: (opts?: FastifyAdapterOptions) => fastifyPlugin(core, table, opts),
    applyPreset: (name: EmergencyPreset) => {
      const preset = EMERGENCY_PRESETS[name];
      if (preset) core.setOverrides(preset);
    },
    snapshot: () => limiter.snapshot(),
    metricsHandler: (_req: unknown, res: ServerResponse | FastifyLikeReply) =>
      serveMetrics(metrics, toServerResponse(res)),
    dryRunReport: () => reporter?.report(),
    close() {
      if (closed) return;
      closed = true;
      limiter.stop();
      reporter?.flush();
    },
  });
}

/** Tag an Express route with a priority: `app.post('/checkout', chakra.route('critical'), handler)`. */
chakra.route = route;
chakra.presets = EMERGENCY_PRESETS;

function createMetricsSink(options: ResolvedOptions): ChakraEventSink {
  if (options.metrics === false) return NOOP_SINK;
  if (isSink(options.metrics)) return options.metrics;
  return createPrometheusExporter(options.metrics);
}

function dryRunLog(options: ResolvedOptions): Parameters<typeof createDryRunReporter>[0] {
  const logger = options.logger;
  return { log: logger ? (line) => logger.info(`dry-run ${line}`) : () => {} };
}

/** The part of a Fastify reply the metrics handler needs. */
export interface FastifyLikeReply {
  raw: ServerResponse;
  hijack(): unknown;
}

function toServerResponse(res: ServerResponse | FastifyLikeReply): ServerResponse {
  if ('raw' in res && typeof res.hijack === 'function') {
    res.hijack();
    return res.raw;
  }
  return res as ServerResponse;
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
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ChakraEventSink).emit === 'function'
  );
}

function isExporter(sink: ChakraEventSink): sink is MetricsExporter {
  return typeof (sink as MetricsExporter).render === 'function';
}

export {
  ChakraConfigError,
  type ChakraOptions,
  type MetricsOptions,
  type ResolvedOptions,
} from './config/schema';
export type { Overrides } from './core/admission';
export { route, EMERGENCY_PRESETS, type EmergencyPreset } from './priority';
export type { FastifyAdapterOptions } from './adapters/fastify';
export type { DryRunReport, DryRunReporter } from './observability/dry-run';
export * from './types';
