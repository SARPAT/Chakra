// Metric names and label sets shared by every exporter and the Grafana
// dashboard. Change a name here and in grafana/chakra-dashboard.json together.

export const METRIC_PREFIX = 'chakra_';

export const METRICS = {
  /** Counter. Labels: decision, band, route, dry_run. */
  requests: {
    name: 'chakra_requests_total',
    help: 'Requests seen by CHAKRA, by admission decision, priority band and route.',
    labels: ['decision', 'band', 'route', 'dry_run'] as const,
  },
  /** Gauge. No labels. */
  inFlight: {
    name: 'chakra_inflight_requests',
    help: 'Requests currently admitted and not yet completed.',
    labels: [] as const,
  },
  /** Gauge. No labels. */
  concurrencyLimit: {
    name: 'chakra_concurrency_limit',
    help: 'Current adaptive concurrency limit.',
    labels: [] as const,
  },
  /** Gauge, seconds. No labels. */
  eventLoopLag: {
    name: 'chakra_event_loop_lag_seconds',
    help: 'Recent event-loop delay in seconds.',
    labels: [] as const,
  },
  /** Histogram, seconds. Labels: band. */
  shedLatency: {
    name: 'chakra_shed_latency_seconds',
    help: 'Time from request arrival to the shed response being sent.',
    labels: ['band'] as const,
    buckets: [0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1],
  },
} as const;

/** Label value used once the distinct-route cap is reached. */
export const OVERFLOW_ROUTE = '__other__';

/** Default cap on distinct route label values, to bound cardinality. */
export const DEFAULT_MAX_ROUTES = 200;
