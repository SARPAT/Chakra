import { AimdLimit } from '../../../src/limiter/aimd';
import { GradientLimit } from '../../../src/limiter/gradient';
import type { WindowSummary } from '../../../src/limiter/types';

const win = (w: Partial<WindowSummary> = {}): WindowSummary => ({
  sampleCount: 10,
  avgRttMs: 10,
  maxInFlight: 100,
  lagPressure: 0,
  ...w,
});

/** Feed `n` windows, each busy at the current limit, and return the final limit. */
function run(alg: GradientLimit | AimdLimit, n: number, w: Partial<WindowSummary> = {}): number {
  for (let i = 0; i < n; i++) alg.update(win({ maxInFlight: alg.limit, ...w }));
  return alg.limit;
}

describe('GradientLimit', () => {
  it('starts at the project defaults and clamps initialLimit into bounds', () => {
    expect(new GradientLimit().limit).toBe(20);
    expect(new GradientLimit({ initialLimit: 5000, maxLimit: 50 }).limit).toBe(50);
  });

  it('grows while latency is steady and the limit is in use, up to maxLimit', () => {
    const g = new GradientLimit({ maxLimit: 200 });
    expect(run(g, 50)).toBeGreaterThan(40);
    expect(run(g, 2000)).toBe(200);
    expect(g.congestion).toBe(0);
  });

  it('does not grow when less than half the limit is used', () => {
    const g = new GradientLimit({ initialLimit: 100 });
    run(g, 50, { maxInFlight: 40 });
    expect(g.limit).toBe(100);
  });

  it('tolerates latency up to rttTolerance x baseline', () => {
    const g = new GradientLimit({ initialLimit: 100 });
    run(g, 5);
    const before = g.limit;
    g.update(win({ avgRttMs: 14 }));
    expect(g.limit).toBeGreaterThanOrEqual(before);
  });

  it('cuts the limit within one window when latency doubles, by at most half, never below minLimit', () => {
    const g = new GradientLimit({ initialLimit: 100, minLimit: 5 });
    const before = run(g, 1);
    g.update(win({ avgRttMs: 30 }));
    expect(g.limit).toBe(Math.floor(before / 2));
    expect(g.congestion).toBeCloseTo(1, 2);
    expect(run(g, 50, { avgRttMs: 1000 })).toBe(5);
  });

  it('shrinks by 1/lagPressure when the event loop lags, even with no samples', () => {
    const g = new GradientLimit({ initialLimit: 100 });
    g.update(win({ sampleCount: 0, avgRttMs: 0, lagPressure: 1.25 }));
    expect(g.limit).toBe(80);
  });

  it('ignores empty windows', () => {
    const g = new GradientLimit({ initialLimit: 100 });
    g.update(win({ sampleCount: 0, avgRttMs: 0 }));
    expect(g.limit).toBe(100);
  });

  it('does not let its baseline chase queueing during a long overload', () => {
    const g = new GradientLimit({ initialLimit: 100 });
    run(g, 5);
    // 400 busy windows at 1.4x latency: tolerated, but the baseline must not
    // rise enough that 2x the original latency also becomes tolerated.
    run(g, 400, { avgRttMs: 14 });
    const before = g.limit;
    g.update(win({ avgRttMs: 20, maxInFlight: g.limit }));
    expect(g.limit).toBeLessThan(before);
  });

  it('regrows after an overload once latency returns to baseline', () => {
    const g = new GradientLimit({ initialLimit: 100 });
    run(g, 5);
    run(g, 20, { avgRttMs: 40 });
    const low = g.limit;
    expect(run(g, 200)).toBeGreaterThan(low * 2);
  });

  it('keeps an integer limit >= 1 whatever it is fed', () => {
    const g = new GradientLimit({ minLimit: 1 });
    for (let i = 0; i < 2000; i++) {
      g.update(
        win({
          avgRttMs: 1 + ((i * 7919) % 97),
          maxInFlight: (i * 31) % 60,
          lagPressure: (i % 13) / 6,
        }),
      );
      expect(Number.isInteger(g.limit) && g.limit >= 1 && g.limit <= 1000).toBe(true);
      expect(g.congestion).toBeGreaterThanOrEqual(0);
      expect(g.congestion).toBeLessThanOrEqual(1);
    }
  });
});

describe('AimdLimit', () => {
  it('adds 1 per busy window and backs off x0.9 on lag or latency', () => {
    const a = new AimdLimit({ initialLimit: 100 });
    expect(run(a, 10)).toBe(110);
    a.update(win({ lagPressure: 2 }));
    expect(a.limit).toBe(99);
    expect(a.congestion).toBe(1);
    a.update(win({ avgRttMs: 25 }));
    expect(a.limit).toBe(89);
  });

  it('respects bounds and the app-limited guard', () => {
    const a = new AimdLimit({ initialLimit: 10, minLimit: 8, maxLimit: 12 });
    expect(run(a, 20)).toBe(12);
    expect(run(a, 20, { lagPressure: 5 })).toBe(8);
    const idle = new AimdLimit({ initialLimit: 100 });
    idle.update(win({ maxInFlight: 10 }));
    expect(idle.limit).toBe(100);
  });
});
