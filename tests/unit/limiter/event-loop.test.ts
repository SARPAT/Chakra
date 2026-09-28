import { monitorEventLoop } from '../../../src/limiter/event-loop';

describe('monitorEventLoop', () => {
  afterEach(() => vi.useRealTimers());

  it('reports a late tick at once, then decays by half per quiet tick', () => {
    vi.useFakeTimers();
    let t = 0;
    const samples: number[] = [];
    const lag = monitorEventLoop(
      (ms) => samples.push(ms),
      50,
      () => t,
    );
    t = 50;
    vi.advanceTimersByTime(50);
    expect(lag.lagMs()).toBe(0);
    t = 180; // this tick ran 80ms late
    vi.advanceTimersByTime(50);
    expect(lag.lagMs()).toBe(80);
    t = 230;
    vi.advanceTimersByTime(50);
    expect(lag.lagMs()).toBe(40);
    expect(samples).toEqual([0, 80, 40]);
    lag.close();
    lag.close();
    expect(lag.lagMs()).toBe(0);
  });

  it('keeps sampling when the listener throws', () => {
    vi.useFakeTimers();
    let t = 0;
    const lag = monitorEventLoop(
      () => {
        throw new Error('boom');
      },
      50,
      () => t,
    );
    t = 150;
    vi.advanceTimersByTime(50);
    t = 200;
    vi.advanceTimersByTime(50);
    expect(lag.lagMs()).toBe(50);
    lag.close();
  });

  it('detects a real blocked event loop', async () => {
    let peak = 0;
    const lag = monitorEventLoop((ms) => (peak = Math.max(peak, ms)), 20);
    await new Promise((r) => setTimeout(r, 30));
    const until = Date.now() + 120;
    while (Date.now() < until) {
      // Block the loop.
    }
    await new Promise((r) => setTimeout(r, 60));
    lag.close();
    expect(peak).toBeGreaterThan(50);
  });
});
