// Internal contracts of the adaptive limiter. The public surface (Limiter,
// LimiterOptions, AcquireResult, ...) lives in src/types.ts.

/** What a limit algorithm learns from one sample window. */
export interface WindowSummary {
  /** Latency samples in the window ('success' and 'error' releases). */
  readonly sampleCount: number;
  /** Mean latency of those samples, ms (0 when there are none). */
  readonly avgRttMs: number;
  /** Highest in-flight count seen during the window, counting rejected requests as if admitted. */
  readonly maxInFlight: number;
  /** Event-loop delay divided by maxEventLoopDelayMs; above 1 the loop is saturated. */
  readonly lagPressure: number;
}

/** Computes the concurrency limit, one window at a time. No clocks, no timers. */
export interface LimitAlgorithm {
  /** Current limit, an integer >= 1. */
  readonly limit: number;
  /** How congested the last update found the system, 0..1. */
  readonly congestion: number;
  update(window: WindowSummary): number;
}

/** Current event-loop delay, read on every window close. */
export interface LagSource {
  lagMs(): number;
  close(): void;
}

/** Limit bounds shared by the algorithms. */
export interface LimitBounds {
  readonly initialLimit?: number;
  readonly minLimit?: number;
  readonly maxLimit?: number;
}

export function resolveBounds(b: LimitBounds): { initial: number; min: number; max: number } {
  const min = b.minLimit ?? 1;
  const max = Math.max(min, b.maxLimit ?? 1000);
  return { initial: Math.min(max, Math.max(min, b.initialLimit ?? 20)), min, max };
}
