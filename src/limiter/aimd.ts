import { resolveBounds, type LimitAlgorithm, type LimitBounds, type WindowSummary } from './types';

export interface AimdOptions extends LimitBounds {
  /** Multiplier applied on congestion. Default 0.9. */
  readonly backoffRatio?: number;
  /** Latency, as a multiple of the lowest window latency seen, that counts as congestion. Default 2. */
  readonly rttTolerance?: number;
}

/**
 * Additive increase, multiplicative decrease. Simpler and more conservative
 * than the gradient: +1 per busy window, x0.9 when the event loop lags or
 * latency exceeds rttTolerance x the best latency seen.
 */
export class AimdLimit implements LimitAlgorithm {
  limit: number;
  congestion = 0;
  private minRtt = Infinity;
  private readonly min: number;
  private readonly max: number;
  private readonly backoff: number;
  private readonly tolerance: number;

  constructor(o: AimdOptions = {}) {
    const b = resolveBounds(o);
    this.limit = b.initial;
    this.min = b.min;
    this.max = b.max;
    this.backoff = o.backoffRatio ?? 0.9;
    this.tolerance = o.rttTolerance ?? 2;
  }

  update(w: WindowSummary): number {
    const sampled = w.sampleCount > 0 && w.avgRttMs > 0;
    // As in GradientLimit: sub-ms latencies are floored, and latency only
    // counts as congestion while at least half the limit is in use.
    const rtt = Math.max(1, w.avgRttMs);
    const busy = w.maxInFlight * 2 >= this.limit;
    if (sampled) this.minRtt = Math.min(this.minRtt, rtt);
    if (w.lagPressure > 1 || (sampled && busy && rtt > this.tolerance * this.minRtt)) {
      this.congestion = 1;
      return (this.limit = Math.max(this.min, Math.floor(this.limit * this.backoff)));
    }
    if (sampled) this.congestion = 0;
    if (sampled && busy) this.limit = Math.min(this.max, this.limit + 1);
    return this.limit;
  }
}
