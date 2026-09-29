import { AdaptiveLimiter, createLimiter } from '../../../src/limiter';
import type { LimitAlgorithm, WindowSummary } from '../../../src/limiter';
import type { ChakraEvent, LimiterOptions, LimiterToken, Priority } from '../../../src/types';

/** Algorithm whose next limit the test sets; records every window it sees. */
class StubAlgorithm implements LimitAlgorithm {
  windows: WindowSummary[] = [];
  next: number;
  congestion = 0;
  constructor(public limit = 100) {
    this.next = limit;
  }
  update(w: WindowSummary): number {
    this.windows.push(w);
    return (this.limit = this.next);
  }
}

function setup(options: LimiterOptions = {}, limit = 100) {
  const clock = { t: 0 };
  const lag = { ms: 0 };
  const events: ChakraEvent[] = [];
  const algorithm = new StubAlgorithm(limit);
  const limiter = new AdaptiveLimiter(
    options,
    { emit: (e) => events.push(e) },
    {
      algorithm,
      clock: () => clock.t,
      lag: { lagMs: () => lag.ms, close: vi.fn() },
    },
  );
  limiter.start();
  return { limiter, algorithm, clock, lag, events };
}

/** Acquire until the band is refused; returns how many were admitted. */
function fill(limiter: AdaptiveLimiter, p: Priority, held: LimiterToken[] = []): number {
  let n = 0;
  for (let r = limiter.acquire(p); r.admitted; r = limiter.acquire(p), n++) held.push(r.token!);
  return n;
}

describe('AdaptiveLimiter admission', () => {
  it('gives each band its share of the limit, keeping headroom for higher bands', () => {
    const { limiter } = setup();
    const held: LimiterToken[] = [];
    expect(fill(limiter, 'sheddable', held)).toBe(50);
    expect(fill(limiter, 'normal', held)).toBe(25);
    expect(fill(limiter, 'high', held)).toBe(15);
    expect(fill(limiter, 'critical', held)).toBe(10);
    expect(limiter.snapshot()).toMatchObject({
      limit: 100,
      inFlight: 100,
      pressure: 1,
      bandLimits: { critical: 100, high: 90, normal: 75, sheddable: 50 },
    });
  });

  it('leaves every band at least one slot, and honours custom shares', () => {
    expect(setup({}, 1).limiter.snapshot().bandLimits).toEqual({
      critical: 1,
      high: 1,
      normal: 1,
      sheddable: 1,
    });
    const { limiter } = setup({ bandShares: { sheddable: 0.2 } }, 10);
    expect(limiter.snapshot().bandLimits.sheddable).toBe(2);
  });

  it('marks admissions past degradeAt of the band as degraded', () => {
    // normal gets floor(10 x 0.75) = 7 slots; degraded from 3.5 in flight on.
    const { limiter } = setup({ degradeAt: 0.5 }, 10);
    const results = Array.from({ length: 8 }, () => limiter.acquire('normal'));
    expect(results.map((r) => r.degraded)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(results[7].admitted).toBe(false);
  });

  it('does not count a rejection in flight, but a forced (dry-run) one does', () => {
    const { limiter } = setup({}, 1);
    limiter.acquire('critical');
    const rejected = limiter.acquire('critical');
    expect(rejected).toEqual({ admitted: false, degraded: false, token: null });
    const forced = limiter.acquire('critical', true);
    expect(forced.admitted).toBe(false);
    expect(forced.token).not.toBeNull();
    expect(limiter.snapshot().inFlight).toBe(2);
    forced.token!.release('success');
    forced.token!.release('success');
    expect(limiter.snapshot().inFlight).toBe(1);
  });
});

describe('AdaptiveLimiter windows', () => {
  it('closes a window after 25ms and 10 samples, with mean latency and peak demand', () => {
    const { limiter, algorithm, clock, events } = setup();
    const tokens = Array.from({ length: 12 }, () => limiter.acquire('normal').token!);
    clock.t = 30;
    tokens.slice(0, 9).forEach((t) => t.release('success'));
    expect(algorithm.windows).toHaveLength(0);
    tokens[9].release('dropped'); // a client abort is not a sample
    expect(algorithm.windows).toHaveLength(0);
    algorithm.next = 60;
    tokens[10].release('error'); // a 5xx is
    expect(algorithm.windows).toEqual([
      { sampleCount: 10, avgRttMs: 30, maxInFlight: 12, lagPressure: 0 },
    ]);
    expect(limiter.snapshot().limit).toBe(60);
    expect(events).toContainEqual({ type: 'limiter_state', limit: 60, inFlight: 1 });
  });

  it('counts rejected requests as demand', () => {
    const { limiter, algorithm, clock } = setup({}, 4);
    const token = limiter.acquire('sheddable').token!;
    limiter.acquire('sheddable');
    limiter.acquire('sheddable');
    clock.t = 1000;
    token.release();
    expect(algorithm.windows[0].maxInFlight).toBe(3);
  });

  it('closes a slow window after a second and reports lag pressure', () => {
    const { limiter, algorithm, clock, lag } = setup({ maxEventLoopDelayMs: 100 });
    const token = limiter.acquire('normal').token!;
    lag.ms = 150;
    clock.t = 1000;
    token.release();
    expect(algorithm.windows[0]).toMatchObject({ sampleCount: 1, lagPressure: 1.5 });
    expect(limiter.snapshot()).toMatchObject({ eventLoopDelayMs: 150, pressure: 1 });
  });

  it('survives a throwing algorithm and a throwing sink', () => {
    const algorithm = new StubAlgorithm(10);
    algorithm.update = () => {
      throw new Error('boom');
    };
    let t = 0;
    const limiter = new AdaptiveLimiter(
      {},
      {
        emit: () => {
          throw new Error('sink');
        },
      },
      {
        algorithm,
        clock: () => t,
        lag: false,
      },
    );
    const token = limiter.acquire('normal').token!;
    t = 2000;
    expect(() => token.release()).not.toThrow();
    expect(limiter.snapshot().limit).toBe(10);
  });
});

describe('createLimiter', () => {
  it('works with zero config and runs its own event-loop sampler between start and stop', () => {
    vi.useFakeTimers();
    const events: ChakraEvent[] = [];
    const limiter = createLimiter(undefined, { emit: (e) => events.push(e) });
    expect(limiter.snapshot()).toMatchObject({ limit: 20, inFlight: 0, pressure: 0 });
    limiter.start();
    limiter.start();
    vi.advanceTimersByTime(100);
    expect(events.filter((e) => e.type === 'event_loop_lag')).toHaveLength(2);
    limiter.stop();
    vi.advanceTimersByTime(100);
    expect(events.filter((e) => e.type === 'event_loop_lag')).toHaveLength(2);
    vi.useRealTimers();
  });

  it('selects AIMD and honours bounds', () => {
    expect(createLimiter({ algorithm: 'aimd', initialLimit: 7 }).snapshot().limit).toBe(7);
  });
});
