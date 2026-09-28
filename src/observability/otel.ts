// OpenTelemetry exporter — records CHAKRA events on OTel metric instruments.
// Takes any @opentelemetry/api Meter structurally, so CHAKRA has no OTel dependency.
//
// A spec-compliant OTel -> Prometheus exporter turns dots into underscores,
// drops `{annotation}` units, appends `_seconds` for unit `s` and `_total` to
// counters, yielding the names in metric-names.ts:
//
//   chakra.requests           counter    {request}  -> chakra_requests_total
//   chakra.shed.latency       histogram  s          -> chakra_shed_latency_seconds
//   chakra.inflight_requests  gauge      {request}  -> chakra_inflight_requests
//   chakra.concurrency_limit  gauge      {request}  -> chakra_concurrency_limit
//   chakra.event_loop.lag     gauge      s          -> chakra_event_loop_lag_seconds

import type { ChakraEvent, ChakraEventSink } from '../types';
import { DEFAULT_MAX_ROUTES, METRICS, OVERFLOW_ROUTE } from './metric-names';

type Attrs = Record<string, string | number | boolean>;
type Options = {
  description?: string;
  unit?: string;
  advice?: { explicitBucketBoundaries?: number[] };
};
type Callback = (result: { observe(value: number, attributes?: Attrs): void }) => void;

/** Structural subset of an OTel `Meter`; a real `@opentelemetry/api` Meter is assignable without a cast. */
export interface MeterLike {
  createCounter(name: string, options?: Options): { add(value: number, attributes?: Attrs): void };
  createHistogram(
    name: string,
    options?: Options,
  ): { record(value: number, attributes?: Attrs): void };
  createObservableGauge(
    name: string,
    options?: Options,
  ): { addCallback(cb: Callback): void; removeCallback?(cb: Callback): void };
}

/**
 * Sink recording CHAKRA events on `meter`. Routes beyond `maxRoutes` distinct
 * values report as OVERFLOW_ROUTE. Gauges report the latest value, nothing
 * before the first. `emit()` never throws; `shutdown()` detaches gauge callbacks
 * and stops recording.
 */
export function createOtelSink(
  meter: MeterLike,
  opts: { maxRoutes?: number } = {},
): ChakraEventSink & { shutdown(): void } {
  const maxRoutes = opts.maxRoutes ?? DEFAULT_MAX_ROUTES;
  const routes = new Set<string>();
  // decision -> band -> route -> [dry_run=false, dry_run=true]: no allocation after warm-up.
  const attrCache = new Map<string, Map<string, Map<string, [Attrs?, Attrs?]>>>();
  const bandAttrs = new Map<string, Attrs>();
  const latest: { limit?: number; inFlight?: number; lag?: number } = {};
  const detach: Array<() => void> = [];
  let stopped = false;

  const requests = meter.createCounter('chakra.requests', {
    description: METRICS.requests.help,
    unit: '{request}',
  });
  const shedLatency = meter.createHistogram('chakra.shed.latency', {
    description: METRICS.shedLatency.help,
    unit: 's',
    advice: { explicitBucketBoundaries: [...METRICS.shedLatency.buckets] },
  });
  const gauge = (
    name: string,
    description: string,
    unit: string,
    read: () => number | undefined,
  ) => {
    const g = meter.createObservableGauge(name, { description, unit });
    const cb: Callback = (result) => {
      const value = read();
      if (value !== undefined)
        try {
          result.observe(value);
        } catch {
          /* never throw into the SDK */
        }
    };
    g.addCallback(cb);
    detach.push(() => g.removeCallback?.(cb));
  };
  gauge('chakra.inflight_requests', METRICS.inFlight.help, '{request}', () => latest.inFlight);
  gauge('chakra.concurrency_limit', METRICS.concurrencyLimit.help, '{request}', () => latest.limit);
  gauge('chakra.event_loop.lag', METRICS.eventLoopLag.help, 's', () => latest.lag);

  function admissionAttrs(
    decision: string,
    band: string,
    rawRoute: string,
    dryRun: boolean,
  ): Attrs {
    let route = rawRoute;
    if (!routes.has(route)) {
      if (routes.size < maxRoutes) routes.add(route);
      else route = OVERFLOW_ROUTE;
    }
    let byBand = attrCache.get(decision);
    if (!byBand) attrCache.set(decision, (byBand = new Map()));
    let byRoute = byBand.get(band);
    if (!byRoute) byBand.set(band, (byRoute = new Map()));
    let pair = byRoute.get(route);
    if (!pair) byRoute.set(route, (pair = []));
    const i = dryRun ? 1 : 0;
    return (pair[i] ??= { decision, band, route, dry_run: dryRun });
  }

  function handle(e: ChakraEvent): void {
    switch (e.type) {
      case 'admission':
      case 'limiter_state':
        if (e.limit !== undefined) latest.limit = e.limit;
        if (e.inFlight !== undefined) latest.inFlight = e.inFlight;
        if (e.type === 'admission')
          requests.add(1, admissionAttrs(e.decision, e.band, e.route, e.dryRun));
        break;
      case 'shed_complete': {
        let attrs = bandAttrs.get(e.band);
        if (!attrs) bandAttrs.set(e.band, (attrs = { band: e.band }));
        shedLatency.record(e.durationMs / 1000, attrs);
        break;
      }
      case 'event_loop_lag':
        latest.lag = e.lagMs / 1000;
        break;
    }
  }

  return {
    emit(event) {
      if (stopped) return;
      try {
        handle(event);
      } catch {
        /* sinks must never throw into the request path */
      }
    },
    shutdown() {
      if (stopped) return;
      stopped = true;
      for (const fn of detach)
        try {
          fn();
        } catch {
          /* best effort */
        }
    },
  };
}
