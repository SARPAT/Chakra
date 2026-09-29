import { performance } from 'perf_hooks';
import {
  NOOP_SINK,
  type AcquireResult,
  type ChakraEventSink,
  type Limiter,
  type LimiterOptions,
  type LimiterSnapshot,
  type LimiterToken,
  type Priority,
  type ReleaseOutcome,
} from '../types';
import { AimdLimit } from './aimd';
import { monitorEventLoop } from './event-loop';
import { GradientLimit } from './gradient';
import type { LagSource, LimitAlgorithm } from './types';

/** Test and embedding hooks; production code passes none. */
export interface LimiterInternals {
  /** Replaces the algorithm chosen by `options.algorithm`. */
  readonly algorithm?: LimitAlgorithm;
  /** Monotonic ms clock. Default performance.now(). */
  readonly clock?: () => number;
  /** Lag signal. Default: an event-loop monitor run between start() and stop(). `false` disables it. */
  readonly lag?: LagSource | false;
}

// A window closes on a release once it is MIN_WINDOW_MS old and holds
// MIN_SAMPLES samples, or once it is MAX_WINDOW_MS old.
const MIN_WINDOW_MS = 25;
const MAX_WINDOW_MS = 1000;
const MIN_SAMPLES = 10;

const BANDS: readonly Priority[] = ['critical', 'high', 'normal', 'sheddable'];
const BAND_INDEX: Record<string, number> = { critical: 0, high: 1, normal: 2, sheddable: 3 };
const DEFAULT_SHARES = [1, 0.9, 0.75, 0.5];
const REJECTED: AcquireResult = Object.freeze({ admitted: false, degraded: false, token: null });

/**
 * The acquire result and the token in one object, so admitting a request
 * allocates exactly one thing.
 */
class Token implements AcquireResult, LimiterToken {
  readonly token: LimiterToken = this;
  constructor(
    private done: ((startedAt: number, outcome: ReleaseOutcome) => void) | null,
    readonly admitted: boolean,
    readonly degraded: boolean,
    private readonly startedAt: number,
  ) {}

  release(outcome: ReleaseOutcome = 'success'): void {
    const done = this.done;
    this.done = null;
    done?.(this.startedAt, outcome);
  }
}

/**
 * Adaptive concurrency limiter with priority bands.
 *
 * A request of band b is admitted while inFlight < floor(limit x share[b])
 * (critical always gets at least 1), so lower bands are shed first and leave
 * headroom for higher ones. It is `degraded` when inFlight was already at or
 * past degradeAt of its band's limit. Every release feeds a sample window;
 * each closed window lets the algorithm move the limit. acquire() and
 * release() are O(1), allocate at most the token and never throw.
 */
export class AdaptiveLimiter implements Limiter {
  private limit: number;
  private inFlight = 0;
  private readonly bandLimits = [0, 0, 0, 0];
  private readonly degradeFrom = [0, 0, 0, 0];
  private readonly shares: number[];
  private readonly degradeAt: number;
  private readonly maxLagMs: number;
  private readonly clock: () => number;
  private readonly algorithm: LimitAlgorithm;
  private lag: LagSource | null = null;
  private windowStart: number;
  private samples = 0;
  private rttSum = 0;
  private maxInFlight = 0;

  constructor(
    options: LimiterOptions = {},
    private readonly sink: ChakraEventSink = NOOP_SINK,
    private readonly internals: LimiterInternals = {},
  ) {
    const bounds = {
      initialLimit: options.initialLimit,
      minLimit: options.minLimit,
      maxLimit: options.maxLimit,
    };
    this.algorithm =
      internals.algorithm ??
      (options.algorithm === 'aimd' ? new AimdLimit(bounds) : new GradientLimit(bounds));
    this.shares = BANDS.map((b, i) => options.bandShares?.[b] ?? DEFAULT_SHARES[i]);
    this.degradeAt = options.degradeAt ?? 0.8;
    this.maxLagMs = options.maxEventLoopDelayMs ?? 100;
    this.clock = internals.clock ?? (() => performance.now());
    this.windowStart = this.clock();
    this.limit = this.algorithm.limit;
    this.setLimit(this.limit);
  }

  acquire(priority: Priority, force = false): AcquireResult {
    const band = BAND_INDEX[priority] ?? 2;
    const before = this.inFlight;
    // An idle limiter always admits one probe: bands can be 0 at a low limit, and
    // the limit only moves on release, so without it the limiter could never recover.
    const admitted = before < this.bandLimits[band] || before === 0;
    // Rejected requests count as demand too: a band filling up while latency
    // is fine is exactly when the limit should grow.
    if (before + 1 > this.maxInFlight) this.maxInFlight = before + 1;
    if (!admitted && !force) return REJECTED;
    this.inFlight = before + 1;
    return new Token(
      this.release,
      admitted,
      admitted && before >= this.degradeFrom[band],
      this.clock(),
    );
  }

  snapshot(): LimiterSnapshot {
    const lagMs = this.lagMs();
    const bandLimits = { critical: 0, high: 0, normal: 0, sheddable: 0 };
    BANDS.forEach((b, i) => (bandLimits[b] = this.bandLimits[i]));
    const pressure = Math.max(
      this.inFlight / this.limit,
      lagMs / this.maxLagMs,
      this.algorithm.congestion,
    );
    return {
      limit: this.limit,
      inFlight: this.inFlight,
      pressure: Math.min(1, pressure),
      eventLoopDelayMs: lagMs,
      bandLimits,
    };
  }

  start(): void {
    if (this.lag) return;
    const lag = this.internals.lag;
    this.lag =
      lag === undefined
        ? monitorEventLoop((lagMs) => {
            this.emit({ type: 'event_loop_lag', lagMs });
            this.emit({ type: 'limiter_state', limit: this.limit, inFlight: this.inFlight });
          })
        : lag || null;
  }

  stop(): void {
    if (this.internals.lag === undefined) this.lag?.close();
    this.lag = null;
  }

  private readonly release = (startedAt: number, outcome: ReleaseOutcome): void => {
    const now = this.clock();
    this.inFlight--;
    // A client abort says nothing about latency; a fast 5xx still does.
    if (outcome !== 'dropped') {
      this.samples++;
      this.rttSum += now - startedAt;
    }
    const age = now - this.windowStart;
    if (age >= MAX_WINDOW_MS || (age >= MIN_WINDOW_MS && this.samples >= MIN_SAMPLES))
      this.closeWindow(now);
  };

  private closeWindow(now: number): void {
    const window = {
      sampleCount: this.samples,
      avgRttMs: this.samples > 0 ? this.rttSum / this.samples : 0,
      maxInFlight: this.maxInFlight,
      lagPressure: this.lagMs() / this.maxLagMs,
    };
    this.windowStart = now;
    this.samples = this.rttSum = 0;
    this.maxInFlight = this.inFlight;
    try {
      const next = this.algorithm.update(window);
      if (next !== this.limit && next >= 1) this.setLimit(next);
    } catch {
      // Keep the old limit; admission must go on.
    }
    this.emit({ type: 'limiter_state', limit: this.limit, inFlight: this.inFlight });
  }

  private setLimit(limit: number): void {
    this.limit = limit;
    for (let i = 0; i < 4; i++) {
      const bandLimit = Math.floor(limit * this.shares[i] + 1e-9);
      this.bandLimits[i] = i === 0 ? Math.max(1, bandLimit) : bandLimit;
      this.degradeFrom[i] = Math.ceil(this.bandLimits[i] * this.degradeAt - 1e-9);
    }
  }

  private lagMs(): number {
    try {
      return this.lag?.lagMs() ?? 0;
    } catch {
      return 0;
    }
  }

  private emit(event: Parameters<ChakraEventSink['emit']>[0]): void {
    try {
      this.sink.emit(event);
    } catch {
      // A broken sink never breaks admission.
    }
  }
}

/** Build the adaptive limiter. Safe with no options: the limit starts at 20 and adapts within 1..1000. */
export function createLimiter(options?: LimiterOptions, sink?: ChakraEventSink): Limiter {
  return new AdaptiveLimiter(options, sink);
}
