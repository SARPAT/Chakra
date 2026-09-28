// Prometheus exporter — dependency-free text exposition (format 0.0.4).
// emit() only bumps numbers in preallocated arrays; label strings are built in render().

import {
  PRIORITY_BANDS,
  type AdmissionDecision,
  type ChakraEvent,
  type MetricsExporter,
  type PriorityBand,
} from '../types';
import { DEFAULT_MAX_ROUTES, METRICS, METRIC_PREFIX, OVERFLOW_ROUTE } from './metric-names';

export interface PrometheusExporterOptions {
  /** Replaces the `chakra_` prefix of every metric name. */
  prefix?: string;
  /** Cap on distinct `route` label values; later routes are counted as `__other__`. */
  maxRoutes?: number;
}

const DECISIONS: readonly AdmissionDecision[] = ['admitted', 'degraded', 'shed'];
const DECISION_INDEX: Record<AdmissionDecision, number> = { admitted: 0, degraded: 1, shed: 2 };
const BAND_INDEX: Record<PriorityBand, number> = { critical: 0, high: 1, normal: 2, sheddable: 3 };
const BANDS = PRIORITY_BANDS.length;
// Per-route counter slots: [dryRun][decision][band].
const SLOTS = 2 * DECISIONS.length * BANDS;
const BUCKETS = METRICS.shedLatency.buckets;

export function createPrometheusExporter(options: PrometheusExporterOptions = {}): MetricsExporter {
  const prefix = options.prefix ?? METRIC_PREFIX;
  const maxRoutes = options.maxRoutes ?? DEFAULT_MAX_ROUTES;
  const name = (metric: { name: string }) => prefix + metric.name.slice(METRIC_PREFIX.length);

  const requests = new Map<string, Float64Array>();
  const shedBuckets = PRIORITY_BANDS.map(() => new Float64Array(BUCKETS.length));
  const shedSum = new Float64Array(BANDS);
  const shedCount = new Float64Array(BANDS);
  let inFlight = 0;
  let limit = 0;
  let lagSeconds = 0;

  function countersFor(route: string): Float64Array {
    let counters = requests.get(route);
    if (counters) return counters;
    const key = requests.size < maxRoutes ? route : OVERFLOW_ROUTE;
    counters = requests.get(key);
    if (!counters) requests.set(key, (counters = new Float64Array(SLOTS)));
    return counters;
  }

  function emit(event: ChakraEvent): void {
    try {
      switch (event.type) {
        case 'admission': {
          const band = BAND_INDEX[event.band];
          const decision = DECISION_INDEX[event.decision];
          if (band === undefined || decision === undefined) return;
          countersFor(event.route)[((event.dryRun ? DECISIONS.length : 0) + decision) * BANDS + band]++;
          if (event.limit !== undefined) limit = event.limit;
          if (event.inFlight !== undefined) inFlight = event.inFlight;
          return;
        }
        case 'shed_complete': {
          const band = BAND_INDEX[event.band];
          if (band === undefined) return;
          const seconds = event.durationMs / 1000;
          let i = 0;
          while (i < BUCKETS.length && seconds > BUCKETS[i]) i++;
          if (i < BUCKETS.length) shedBuckets[band][i]++;
          shedSum[band] += seconds;
          shedCount[band]++;
          return;
        }
        case 'limiter_state':
          limit = event.limit;
          inFlight = event.inFlight;
          return;
        case 'event_loop_lag':
          lagSeconds = event.lagMs / 1000;
          return;
      }
    } catch {
      // Metrics must never break the request path.
    }
  }

  function render(): string {
    const out: string[] = [];
    const header = (metric: { name: string; help: string }, type: string) => {
      out.push(`# HELP ${name(metric)} ${metric.help}`, `# TYPE ${name(metric)} ${type}`);
    };

    header(METRICS.requests, 'counter');
    const requestsName = name(METRICS.requests);
    for (const [route, counters] of requests) {
      const routeLabel = escapeLabel(route);
      for (let slot = 0; slot < SLOTS; slot++) {
        if (counters[slot] === 0) continue;
        const band = PRIORITY_BANDS[slot % BANDS];
        const decision = DECISIONS[Math.floor(slot / BANDS) % DECISIONS.length];
        const dryRun = slot >= SLOTS / 2;
        out.push(`${requestsName}{decision="${decision}",band="${band}",route="${routeLabel}",dry_run="${dryRun}"} ${counters[slot]}`);
      }
    }

    for (const [metric, value] of [
      [METRICS.inFlight, inFlight],
      [METRICS.concurrencyLimit, limit],
      [METRICS.eventLoopLag, lagSeconds],
    ] as const) {
      header(metric, 'gauge');
      out.push(`${name(metric)} ${formatNumber(value)}`);
    }

    header(METRICS.shedLatency, 'histogram');
    const shedName = name(METRICS.shedLatency);
    PRIORITY_BANDS.forEach((band, b) => {
      if (shedCount[b] === 0) return;
      let cumulative = 0;
      BUCKETS.forEach((le, i) => {
        cumulative += shedBuckets[b][i];
        out.push(`${shedName}_bucket{band="${band}",le="${le}"} ${cumulative}`);
      });
      out.push(
        `${shedName}_bucket{band="${band}",le="+Inf"} ${shedCount[b]}`,
        `${shedName}_sum{band="${band}"} ${formatNumber(shedSum[b])}`,
        `${shedName}_count{band="${band}"} ${shedCount[b]}`,
      );
    });

    return out.join('\n') + '\n';
  }

  return { emit, render, contentType: 'text/plain; version=0.0.4; charset=utf-8' };
}

function escapeLabel(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatNumber(value: number): string {
  if (Number.isFinite(value)) return String(value);
  return Number.isNaN(value) ? 'NaN' : value > 0 ? '+Inf' : '-Inf';
}
