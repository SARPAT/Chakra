/**
 * Regression: under healthy load with sub-millisecond, noisy latencies (a
 * fast Fastify route on one core at half its capacity), the limit must not
 * ratchet down, and no band may be locked out for good.
 */

import { AdaptiveLimiter } from '../../src/limiter';
import { GradientLimit } from '../../src/limiter/gradient';
import { prng } from './overload-sim';

describe('adaptive limiter under healthy load', () => {
  it('holds its limit and sheds nothing when latencies are sub-ms and noisy', () => {
    const rand = prng(11);
    let t = 0;
    const limiter = new AdaptiveLimiter({}, undefined, { clock: () => t, lag: false });
    let shed = 0;
    // 20k req/s for 6s of virtual time, handled one at a time. Latency is
    // usually ~20µs, with 1 window in 5 hit by a GC-like 0.2..1ms spike.
    for (let i = 0; i < 120_000; i++) {
      t += 0.05;
      const r = limiter.acquire('normal');
      if (!r.admitted) {
        shed++;
        continue;
      }
      const spike = Math.floor(t / 25) % 5 === 0;
      t += spike ? 0.2 + rand() * 0.8 : 0.01 + rand() * 0.02;
      r.token!.release('success');
    }
    expect(shed).toBe(0);
    expect(limiter.snapshot().limit).toBeGreaterThanOrEqual(20);
  });

  it('never closes a band for good: at limit 1 every band is served when idle', () => {
    let t = 0;
    const limiter = new AdaptiveLimiter({}, undefined, {
      algorithm: new GradientLimit({ initialLimit: 1 }),
      clock: () => t,
      lag: false,
    });
    for (const p of ['critical', 'high', 'normal', 'sheddable'] as const) {
      const r = limiter.acquire(p);
      expect(r.admitted).toBe(true);
      t += 1;
      r.token!.release('success');
    }
  });

  it('regrows from limit 1 once traffic flows again', () => {
    let t = 0;
    const limiter = new AdaptiveLimiter({}, undefined, {
      algorithm: new GradientLimit({ initialLimit: 1 }),
      clock: () => t,
      lag: false,
    });
    // Two overlapping requests at a time, steady 1ms latency, for 5s.
    for (let i = 0; i < 5_000; i++) {
      const a = limiter.acquire('normal');
      const b = limiter.acquire('normal');
      t += 1;
      a.token?.release('success');
      b.token?.release('success');
    }
    expect(limiter.snapshot().limit).toBeGreaterThanOrEqual(4);
  });
});
