/**
 * Deterministic discrete-event simulation of a server under load, used to
 * show that the adaptive limiter holds latency when demand exceeds capacity.
 *
 * The server model is a pool of `workers` that each serve one request at a
 * time, with a FIFO queue in front (like a Node process whose CPU or DB pool
 * is the bottleneck). Service times jitter around `serviceMs`. Arrivals are a
 * Poisson process whose rate follows `phases`. Time is virtual: the limiter
 * reads the simulation clock, so a 20-second scenario runs in milliseconds.
 */

import type { Limiter, LimiterToken, Priority } from '../../src/types';

export interface Phase {
  /** Phase length, ms of virtual time. */
  durationMs: number;
  /** Mean arrivals per second during the phase. */
  ratePerSec: number;
}

export interface SimOptions {
  workers: number;
  serviceMs: number;
  /** Service time jitter, as a fraction of serviceMs (uniform ±). */
  jitter?: number;
  phases: Phase[];
  /** Share of arrivals per priority; must sum to 1. Default: all normal. */
  mix?: Partial<Record<Priority, number>>;
  seed?: number;
  /** Limiter under test; omit to run the unprotected baseline. */
  limiter?: Limiter;
  /** Lets the limiter read virtual time; set by run() before any event. */
  clockRef?: { now: number };
}

export interface Completed {
  arrivedAt: number;
  latencyMs: number;
  priority: Priority;
}

export interface SimResult {
  completed: Completed[];
  /** Rejected arrivals, with arrival time and priority. */
  shed: { arrivedAt: number; priority: Priority }[];
  /** Limit observed every 100ms of virtual time (only with a limiter). */
  limitTrace: { at: number; limit: number }[];
  endAt: number;
}

/** Small, fast, seedable PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimEvent {
  at: number;
  seq: number;
  kind: 'arrival' | 'done' | 'trace';
  job?: Job;
}

interface Job {
  arrivedAt: number;
  priority: Priority;
  token: LimiterToken | null;
}

/** Binary min-heap on (at, seq) so equal-time events keep insertion order. */
class EventQueue {
  private heap: SimEvent[] = [];
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(e: Omit<SimEvent, 'seq'>): void {
    const h = this.heap;
    h.push({ ...e, seq: this.seq++ });
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }

  pop(): SimEvent | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0];
    const last = h.pop() as SimEvent;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l], h[m])) m = l;
        if (r < h.length && this.less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }

  private less(a: SimEvent, b: SimEvent): boolean {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq);
  }
}

export function runSim(opts: SimOptions): SimResult {
  const rand = prng(opts.seed ?? 42);
  const jitter = opts.jitter ?? 0.2;
  const mix = Object.entries(opts.mix ?? { normal: 1 }) as [Priority, number][];
  const clock = opts.clockRef ?? { now: 0 };
  const limiter = opts.limiter;

  const endAt = opts.phases.reduce((t, p) => t + p.durationMs, 0);
  const rateAt = (t: number): number => {
    let start = 0;
    for (const p of opts.phases) {
      if (t < start + p.durationMs) return p.ratePerSec;
      start += p.durationMs;
    }
    return 0;
  };
  const pickPriority = (): Priority => {
    let x = rand();
    for (const [p, share] of mix) {
      if (x < share) return p;
      x -= share;
    }
    return mix[mix.length - 1][0];
  };
  // Exponential inter-arrival gap for the rate in force at time t.
  const nextArrival = (t: number): number => {
    const rate = rateAt(t);
    if (rate <= 0) return Infinity;
    return t + (-Math.log(1 - rand()) / rate) * 1000;
  };
  const serviceTime = (): number => opts.serviceMs * (1 + jitter * (2 * rand() - 1));

  const events = new EventQueue();
  // FIFO queue as an array plus head index: shift() is O(n) on big queues.
  const waiting: Job[] = [];
  let head = 0;
  let busy = 0;
  const result: SimResult = { completed: [], shed: [], limitTrace: [], endAt };

  const startService = (job: Job, now: number): void => {
    busy++;
    events.push({ at: now + serviceTime(), kind: 'done', job });
  };

  events.push({ at: nextArrival(0), kind: 'arrival' });
  if (limiter) events.push({ at: 0, kind: 'trace' });

  for (let e = events.pop(); e; e = events.pop()) {
    clock.now = e.at;
    const now = e.at;

    if (e.kind === 'trace') {
      result.limitTrace.push({ at: now, limit: limiter?.snapshot().limit ?? 0 });
      if (now + 100 <= endAt) events.push({ at: now + 100, kind: 'trace' });
      continue;
    }

    if (e.kind === 'arrival') {
      if (now >= endAt) continue;
      const priority = pickPriority();
      let token: LimiterToken | null = null;
      if (limiter) {
        const res = limiter.acquire(priority);
        if (!res.admitted) {
          result.shed.push({ arrivedAt: now, priority });
        } else {
          token = res.token;
        }
      }
      if (!limiter || token) {
        const job: Job = { arrivedAt: now, priority, token };
        if (busy < opts.workers) startService(job, now);
        else waiting.push(job);
      }
      const next = nextArrival(now);
      if (next < endAt) events.push({ at: next, kind: 'arrival' });
      continue;
    }

    // done
    const job = e.job as Job;
    busy--;
    job.token?.release('success');
    result.completed.push({
      arrivedAt: job.arrivedAt,
      latencyMs: now - job.arrivedAt,
      priority: job.priority,
    });
    if (head < waiting.length) startService(waiting[head++], now);
  }

  return result;
}

/** p-th percentile (0..100) of a list of numbers; 0 for an empty list. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
