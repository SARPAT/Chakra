/**
 * Load test: the adaptive limiter keeps latency bounded when demand is 2.5x
 * what the server can handle, sheds lower priorities first, and lets go once
 * the surge ends. Runs on virtual time (see overload-sim.ts), so it is fast
 * and deterministic.
 */

import { AdaptiveLimiter } from '../../src/limiter';
import type { Priority } from '../../src/types';
import { percentile, runSim, type SimOptions, type SimResult } from './overload-sim';

// 20 workers x 10ms per request = 2000 req/s of capacity.
const WORKERS = 20;
const SERVICE_MS = 10;
const CAPACITY_RPS = (WORKERS * 1000) / SERVICE_MS;

const WARMUP_MS = 3_000;
const SURGE_MS = 10_000;
const RECOVERY_MS = 5_000;
const SURGE_START = WARMUP_MS;
const SURGE_END = WARMUP_MS + SURGE_MS;

const scenario = (extra: Partial<SimOptions> = {}): SimOptions => ({
  workers: WORKERS,
  serviceMs: SERVICE_MS,
  phases: [
    { durationMs: WARMUP_MS, ratePerSec: CAPACITY_RPS / 2 },
    { durationMs: SURGE_MS, ratePerSec: CAPACITY_RPS * 2.5 },
    { durationMs: RECOVERY_MS, ratePerSec: CAPACITY_RPS / 2 },
  ],
  mix: { critical: 0.1, high: 0.2, normal: 0.4, sheddable: 0.3 },
  seed: 7,
  ...extra,
});

function withLimiter(): SimResult {
  const clockRef = { now: 0 };
  // Project defaults; only time is virtual and the event-loop signal is off.
  const limiter = new AdaptiveLimiter({}, undefined, { clock: () => clockRef.now, lag: false });
  try {
    return runSim(scenario({ limiter, clockRef }));
  } finally {
    limiter.stop();
  }
}

const between = (from: number, to: number) => (r: { arrivedAt: number }) =>
  r.arrivedAt >= from && r.arrivedAt < to;

describe('adaptive limiter under a 2.5x overload', () => {
  const baseline = runSim(scenario());
  const limited = withLimiter();

  // Skip the first second of the surge: that is the limiter converging.
  const steady = between(SURGE_START + 1_000, SURGE_END);

  it('without a limiter, latency grows without bound (the failure being prevented)', () => {
    const lat = baseline.completed.filter(steady).map((c) => c.latencyMs);
    expect(percentile(lat, 99)).toBeGreaterThan(1_000);
  });

  it('holds p99 latency of admitted requests near the service time', () => {
    const lat = limited.completed.filter(steady).map((c) => c.latencyMs);
    expect(lat.length).toBeGreaterThan(0);
    expect(percentile(lat, 50)).toBeLessThan(SERVICE_MS * 2);
    expect(percentile(lat, 99)).toBeLessThan(SERVICE_MS * 4);
  });

  it('reacts within the first few hundred milliseconds of the surge', () => {
    const lat = limited.completed
      .filter(between(SURGE_START + 250, SURGE_START + 1_000))
      .map((c) => c.latencyMs);
    expect(percentile(lat, 99)).toBeLessThan(SERVICE_MS * 6);
  });

  it('keeps the server busy: goodput stays close to capacity', () => {
    const done = limited.completed.filter(steady).length;
    const seconds = (SURGE_END - SURGE_START - 1_000) / 1000;
    expect(done / seconds).toBeGreaterThan(CAPACITY_RPS * 0.9);
  });

  it('sheds lower priorities first and protects critical traffic', () => {
    const shedRate = (p: Priority): number => {
      const shed = limited.shed.filter(steady).filter((s) => s.priority === p).length;
      const ok = limited.completed.filter(steady).filter((c) => c.priority === p).length;
      return shed / (shed + ok);
    };
    expect(shedRate('critical')).toBeLessThan(0.01);
    expect(shedRate('high')).toBeLessThan(shedRate('normal'));
    expect(shedRate('normal')).toBeLessThan(shedRate('sheddable'));
    expect(shedRate('sheddable')).toBeGreaterThan(0.9);
  });

  it('recovers once the surge ends: latency back to baseline, only rare sheddable sheds', () => {
    const after = between(SURGE_END + 1_000, SURGE_END + RECOVERY_MS);
    const shed = limited.shed.filter(after);
    expect(shed.every((s) => s.priority === 'sheddable')).toBe(true);
    expect(shed.length).toBeLessThan(10);
    const lat = limited.completed.filter(after).map((c) => c.latencyMs);
    expect(percentile(lat, 99)).toBeLessThan(SERVICE_MS * 2);
  });

  it('under normal load sheds only sheddable traffic, and only while the limit warms up from its default', () => {
    const shed = limited.shed.filter(between(0, SURGE_START));
    expect(shed.every((s) => s.priority === 'sheddable')).toBe(true);
    expect(shed.filter(between(1_000, SURGE_START)).length).toBe(0);
    expect(shed.length).toBeLessThan(CAPACITY_RPS * 0.05);
  });
});
