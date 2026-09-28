// Shared contracts for CHAKRA v0.2 — locked by docs/adr/0001-adaptive-admission-control.md.
//
// Every module (core, limiter, priority, adapters, observability) builds against these
// types. Change them only through an ADR amendment: several threads depend on them.

// ─── Priority ─────────────────────────────────────────────────────────────────

/** Declared importance of a request. Lower bands are shed first. */
export type Priority = 'critical' | 'high' | 'normal' | 'sheddable';

/** All priorities, highest first. */
export const PRIORITIES: readonly Priority[] = Object.freeze([
  'critical',
  'high',
  'normal',
  'sheddable',
] as const);

/** Operating mode. `dry-run` admits everything but reports what would have been shed. */
export type Mode = 'enforce' | 'dry-run' | 'off';

// ─── Request context ──────────────────────────────────────────────────────────

/** Framework-neutral view of an incoming request. Built by adapters, read by core. */
export interface RequestContext {
  /** Upper-case HTTP method. */
  readonly method: string;
  /** URL path without the query string. */
  readonly path: string;
  /** Matched route pattern when the framework already knows it, e.g. `/api/products/:id`. */
  readonly route?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /**
   * Authenticated user object set by the application (e.g. `req.user`).
   * Priority must never be derived from client-controlled headers.
   */
  readonly user?: unknown;
  /** The framework's own request object, for custom priority resolvers. */
  readonly raw?: unknown;
}

// ─── Routes and responses ─────────────────────────────────────────────────────

/** Response written when a request is shed. */
export interface ShedResponse {
  /** HTTP status. Default 503. */
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** A string is sent as-is; anything else is sent as JSON. */
  readonly body?: unknown;
  /** Sets the `Retry-After` header. Default 1. */
  readonly retryAfterSeconds?: number;
}

/** A route rule as written by the developer. */
export interface RouteRuleInput {
  readonly priority: Priority;
  /** Custom response for this route when it is shed. */
  readonly fallback?: ShedResponse;
}

/** A compiled route rule returned by a PriorityResolver. */
export interface RouteRule extends RouteRuleInput {
  /**
   * Stable, low-cardinality key for this rule, used as the metrics `route` label.
   * Format: `METHOD /pattern`, e.g. `GET /api/products/:id`.
   */
  readonly key: string;
}

/** Finds the declared rule for a request. Implemented in `src/priority/`. */
export interface PriorityResolver {
  /** Return the matching rule, or undefined. Runs on the hot path: must not throw. */
  match(ctx: RequestContext): RouteRule | undefined;
}

/** A PriorityResolver that routes can be added to after construction (e.g. discovered from the framework router). */
export interface RouteTable extends PriorityResolver {
  /** Add or replace a rule. `pattern` supports `:param` segments and a trailing `*`. */
  add(method: string, pattern: string, rule: RouteRuleInput): void;
  /** Number of rules, for startup logging. */
  readonly size: number;
}

// ─── Limiter ──────────────────────────────────────────────────────────────────

/** Adaptive concurrency limiter with priority bands. Implemented in `src/limiter/`. */
export interface Limiter {
  /**
   * Try to admit one request of the given priority. Runs on the hot path: must not throw.
   *
   * With `force = true` the limiter returns a token even when it would reject, so that
   * dry-run mode keeps in-flight accounting accurate; `admitted` still reports the
   * decision it would have made.
   */
  acquire(priority: Priority, force?: boolean): AcquireResult;
  /** Current state. Cheap enough to call on every request. */
  snapshot(): LimiterSnapshot;
  /** Start background sampling (event-loop delay). Idempotent. */
  start(): void;
  /** Stop timers. Idempotent. */
  stop(): void;
}

export interface AcquireResult {
  /** Whether the request is (or, when forced, would have been) admitted. */
  readonly admitted: boolean;
  /** Admitted, but close enough to the band's limit that handlers should serve a lighter response. */
  readonly degraded: boolean;
  /** Non-null when admitted or forced. Must be released exactly once. */
  readonly token: LimiterToken | null;
}

export type ReleaseOutcome = 'success' | 'error' | 'dropped';

export interface LimiterToken {
  /**
   * Call once when the response finishes. `success` for status < 500, `error` for 5xx or a
   * thrown handler, `dropped` when the client aborted (excluded from latency samples).
   * Later calls are no-ops.
   */
  release(outcome: ReleaseOutcome): void;
}

export interface LimiterSnapshot {
  /** Current adaptive concurrency limit. */
  readonly limit: number;
  readonly inFlight: number;
  /** 0 = idle, 1 = saturated. */
  readonly pressure: number;
  /** Recent p99 event-loop delay in milliseconds. */
  readonly eventLoopDelayMs: number;
  /** Concurrency each band may currently occupy. */
  readonly bandLimits: Readonly<Record<Priority, number>>;
}

export interface LimiterOptions {
  /** Default `gradient2`. */
  readonly algorithm?: 'gradient2' | 'aimd';
  /** Default 20. */
  readonly initialLimit?: number;
  /** Default 1. */
  readonly minLimit?: number;
  /** Default 1000. */
  readonly maxLimit?: number;
  /** Above this p99 event-loop delay the limit shrinks regardless of latency. Default 100. */
  readonly maxEventLoopDelayMs?: number;
  /** Share of the limit each band may occupy. Defaults: critical 1, high 0.9, normal 0.75, sheddable 0.5. */
  readonly bandShares?: Partial<Record<Priority, number>>;
  /** Fraction of a band's share above which admitted requests are marked degraded. Default 0.8. */
  readonly degradeAt?: number;
}

// ─── Decisions ────────────────────────────────────────────────────────────────

/** What handlers see as `req.chakra`. */
export interface ChakraRequestInfo {
  readonly priority: Priority;
  /** Serve a lighter response if you can. */
  readonly degraded: boolean;
  /** Dry-run only: this request would have been shed in enforce mode. */
  readonly wouldShed: boolean;
  /** Limiter pressure at decision time, 0..1. */
  readonly pressure: number;
  readonly mode: Mode;
}

export interface AdmitDecision {
  readonly outcome: 'admit';
  readonly info: ChakraRequestInfo;
  /**
   * Adapters call this exactly once when the response finishes or the connection closes.
   * Later calls are no-ops.
   */
  done(statusCode: number, aborted?: boolean): void;
}

export interface ShedDecision {
  readonly outcome: 'shed';
  readonly info: ChakraRequestInfo;
  /** Fully resolved response to write. The handler must not run. */
  readonly response: ResolvedShedResponse;
}

export type Decision = AdmitDecision | ShedDecision;

export interface ResolvedShedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** Framework-free decision point. Adapters call `decide()` once per request. */
export interface AdmissionCore {
  decide(ctx: RequestContext): Decision;
}

// ─── Observability events ─────────────────────────────────────────────────────
// Adopted from the "Metrics and dry-run" thread's contract
// (/mnt/project-files/observability/events.ts). Core and limiter only call
// `sink.emit(event)`; exporters decide what to do with it. Emitting must be cheap
// and must never throw into the request path.

/** Alias used by the observability modules. */
export type PriorityBand = Priority;

export const PRIORITY_BANDS: readonly PriorityBand[] = PRIORITIES;

/** Operating modes that act on decisions (`off` bypasses CHAKRA entirely). */
export type ChakraMode = Exclude<Mode, 'off'>;

/** What the core decided to do with a request. */
export type AdmissionDecision = 'admitted' | 'degraded' | 'shed';

/** Route label used when no route rule matched, to keep metric cardinality bounded. */
export const UNMATCHED_ROUTE = '<unmatched>';

/**
 * Emitted once per request, at the moment the core decides.
 * In dry-run mode the real decision is reported with `dryRun: true`, but the request is let through.
 */
export interface AdmissionEvent {
  type: 'admission';
  decision: AdmissionDecision;
  band: PriorityBand;
  /** `RouteRule.key` (e.g. `GET /users/:id`) or UNMATCHED_ROUTE. Never a concrete path. */
  route: string;
  dryRun: boolean;
  /** Short machine-readable cause, e.g. `limit_exceeded`, `band_closed`. */
  reason?: string;
  /** Concurrency limit at decision time. */
  limit?: number;
  /** In-flight requests at decision time. */
  inFlight?: number;
  /** `performance.now()` or `Date.now()`. Defaults to now. */
  at?: number;
}

/** Emitted when a shed request has been answered. `durationMs` is arrival to shed response. */
export interface ShedCompleteEvent {
  type: 'shed_complete';
  band: PriorityBand;
  route: string;
  durationMs: number;
}

/** Emitted by the limiter when its limit or in-flight count changes, or at least periodically. */
export interface LimiterStateEvent {
  type: 'limiter_state';
  limit: number;
  inFlight: number;
}

/** Emitted periodically by the limiter's event-loop sampler. */
export interface EventLoopLagEvent {
  type: 'event_loop_lag';
  /** Recent event-loop delay, e.g. p99 over the sampling window. */
  lagMs: number;
}

export type ChakraEvent =
  | AdmissionEvent
  | ShedCompleteEvent
  | LimiterStateEvent
  | EventLoopLagEvent;

/** Anything that consumes CHAKRA events. Implemented in `src/observability/`. */
export interface ChakraEventSink {
  emit(event: ChakraEvent): void;
}

/** A sink that can render Prometheus text exposition for a scrape endpoint. */
export interface MetricsExporter extends ChakraEventSink {
  readonly contentType: string;
  render(): string;
}

/** A sink that discards everything. Default when observability is off. */
export const NOOP_SINK: ChakraEventSink = Object.freeze({ emit: () => {} });

// ─── Logging ──────────────────────────────────────────────────────────────────

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}
