import { resolveBounds, type LimitAlgorithm, type LimitBounds, type WindowSummary } from './types';

export interface GradientOptions extends LimitBounds {
  /** Short/long latency ratio tolerated before shrinking. Default 1.5. */
  readonly rttTolerance?: number;
  /** Length, in windows, of the long-term latency average. Default 600. */
  readonly longWindow?: number;
  /** Share of the growth step applied per window. Default 0.2. */
  readonly smoothing?: number;
}

/**
 * Gradient limit in the style of Netflix concurrency-limits' Gradient2.
 *
 * Compares each window's latency (short RTT) with a long-term average (long
 * RTT). While short <= tolerance x long the system isn't queueing, so the
 * limit grows by ~sqrt(limit). Past that, or when the event loop is lagging,
 * the limit is multiplied by the gradient (0.5..1) at once: decreases are
 * never smoothed, so a saturated process backs off within one window.
 */
export class GradientLimit implements LimitAlgorithm {
  limit: number;
  congestion = 0;
  private estimate: number;
  private longRtt = 0;
  private readonly min: number;
  private readonly max: number;
  private readonly tolerance: number;
  private readonly alpha: number;
  private readonly smoothing: number;

  constructor(o: GradientOptions = {}) {
    const b = resolveBounds(o);
    this.limit = this.estimate = b.initial;
    this.min = b.min;
    this.max = b.max;
    this.tolerance = o.rttTolerance ?? 1.5;
    this.alpha = 2 / ((o.longWindow ?? 600) + 1);
    this.smoothing = o.smoothing ?? 0.2;
  }

  update(w: WindowSummary): number {
    // Latency only moves the limit while at least half of it is in use: below
    // that, requests aren't queueing behind the limit, so a slower window is
    // noise (GC, timer jitter), and shrinking on it ratchets the limit down.
    const busy = w.maxInFlight >= this.limit / 2;
    let gradient = 1;
    if (w.sampleCount > 0 && w.avgRttMs > 0) {
      // Sub-millisecond latencies are too noisy to compare; floor them at 1ms.
      const shortRtt = Math.max(1, w.avgRttMs);
      const longRtt = this.trackLongRtt(shortRtt, busy);
      if (busy) gradient = Math.max(0.5, Math.min(1, (this.tolerance * longRtt) / shortRtt));
    } else if (w.lagPressure <= 1) {
      return this.limit;
    }
    if (w.lagPressure > 1) gradient = Math.min(gradient, Math.max(0.5, 1 / w.lagPressure));
    this.congestion = (1 - gradient) * 2;

    if (gradient < 1) {
      this.estimate = Math.max(this.min, this.estimate * gradient);
    } else if (busy) {
      this.estimate = Math.min(
        this.max,
        this.estimate + this.smoothing * Math.max(1, Math.sqrt(this.estimate)),
      );
    }
    // The epsilon keeps float error (90 * 0.7 = 62.999...) from costing a slot.
    return (this.limit = Math.floor(this.estimate + 1e-9));
  }

  private trackLongRtt(shortRtt: number, busy: boolean): number {
    if (this.longRtt === 0) return (this.longRtt = shortRtt);
    // A rise seen while busy is mostly queueing we allowed ourselves, so it
    // is folded in 10x slower; otherwise the baseline would chase the queue
    // and latency would ratchet up for as long as an overload lasts.
    const alpha = busy && shortRtt > this.longRtt ? this.alpha / 10 : this.alpha;
    this.longRtt += alpha * (shortRtt - this.longRtt);
    // After an overload ends, pull a stale high baseline back quickly so a
    // fresh latency rise is noticed (Gradient2's drift fix).
    if (this.longRtt > 2 * shortRtt) this.longRtt *= 0.95;
    return this.longRtt;
  }
}
