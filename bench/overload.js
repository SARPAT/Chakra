'use strict';
// Overload behaviour: drive the demo shop past capacity with an open-loop spike and
// compare no protection, a fixed concurrency cap that sheds with 503, and CHAKRA.
// Same deterministic traffic for every mode.

const { startServer } = require('./lib/spawn');
const loadgen = require('./lib/loadgen');
const shop = require('./lib/shop');

const FRAMEWORK = process.env.BENCH_FRAMEWORK || 'express';
const MODES = (process.env.BENCH_MODES || 'none,cap,chakra').split(',');
const BASE_RPS = Number(process.env.BENCH_BASE_RPS || 300);
const SPIKE_RPS = Number(process.env.BENCH_SPIKE_RPS || 1500);
const SPIKE_S = Number(process.env.BENCH_SPIKE_SECONDS || 20);
const TIMEOUT_MS = 2000;
/** Critical requests should finish within this; reaction time is measured against it. */
const SLO_MS = Number(process.env.BENCH_SLO_MS || 250);
const BUCKET_MS = 250;

const PHASES = [
  { name: 'warm-up', seconds: 5, rps: BASE_RPS },
  { name: 'baseline', seconds: 10, rps: BASE_RPS },
  { name: 'spike', seconds: SPIKE_S, rps: SPIKE_RPS },
  { name: 'recovery', seconds: 10, rps: BASE_RPS },
];
const MIX = [
  { method: 'POST', path: '/checkout', weight: 0.1, priority: 'critical' },
  { method: 'GET', path: '/browse', weight: 0.4, priority: 'normal' },
  { method: 'GET', path: '/recommendations', weight: 0.5, priority: 'sheddable' },
];
const SPIKE_START = (PHASES[0].seconds + PHASES[1].seconds) * 1000;
const SPIKE_END = SPIKE_START + SPIKE_S * 1000;

const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN;
const round = (x, d = 1) => (Number.isFinite(x) ? +x.toFixed(d) : null);

/** Success rate and latency of one route over [from, to), by send time. */
function window(rec, r, from, to) {
  const ok = [];
  let n = 0;
  for (let i = 0; i < rec.count; i++) {
    if (rec.route[i] !== r || rec.sentAt[i] < from || rec.sentAt[i] >= to) continue;
    n++;
    if (rec.status[i] >= 200 && rec.status[i] < 300) ok.push(rec.latency[i]);
  }
  ok.sort((a, b) => a - b);
  return {
    n,
    ok: ok.length,
    successRate: n ? ok.length / n : NaN,
    p50: pct(ok, 0.5),
    p99: pct(ok, 0.99),
  };
}

/**
 * Time from spike start until critical traffic is healthy: the first 250 ms step from
 * which the critical requests sent for the rest of the spike, taken together, have
 * >= 99% success and p99 <= SLO_MS. 0 means it never suffered; null means it never did.
 */
function recoveredMs(rec) {
  for (let t = SPIKE_START; t < SPIKE_END; t += BUCKET_MS) {
    const w = window(rec, 0, t, SPIKE_END);
    if (w.successRate >= 0.99 && w.p99 <= SLO_MS) return t - SPIKE_START;
  }
  return null;
}

/** Time from spike start to the first request answered with 503; null if none was. */
function firstShedMs(rec) {
  let first = Infinity;
  for (let i = 0; i < rec.count; i++) {
    if (rec.status[i] === 503 && rec.sentAt[i] >= SPIKE_START)
      first = Math.min(first, rec.sentAt[i]);
  }
  return first === Infinity ? null : round(first - SPIKE_START, 0);
}

async function runMode(mode) {
  const server = await startServer([FRAMEWORK, mode, 'shop']);
  try {
    const rec = await loadgen.run({
      port: server.port,
      phases: PHASES,
      mix: MIX,
      timeoutMs: TIMEOUT_MS,
    });
    const spike = MIX.map((m, r) => ({
      route: `${m.method} ${m.path}`,
      priority: m.priority,
      ...window(rec, r, SPIKE_START, SPIKE_END),
    }));
    const base = window(rec, 0, PHASES[0].seconds * 1000, SPIKE_START);
    const goodput = spike.reduce((n, s) => n + s.ok, 0) / SPIKE_S;
    return {
      mode,
      adapter: server.adapter,
      criticalBaselineP99: round(base.p99),
      criticalSuccess: round(spike[0].successRate * 100),
      criticalP50: round(spike[0].p50),
      criticalP99: round(spike[0].p99),
      normalSuccess: round(spike[1].successRate * 100),
      sheddableSuccess: round(spike[2].successRate * 100),
      goodputRps: round(goodput, 0),
      firstShedMs: firstShedMs(rec),
      recoveredMs: recoveredMs(rec),
      routes: spike.map((s) => ({
        ...s,
        successRate: round(s.successRate * 100),
        p50: round(s.p50),
        p99: round(s.p99),
      })),
    };
  } finally {
    await server.stop();
  }
}

async function main() {
  const results = [];
  for (const mode of MODES) results.push(await runMode(mode));
  return {
    framework: FRAMEWORK,
    capacity: {
      pool: shop.POOL,
      serviceMs: shop.SERVICE_MS,
      cpuUs: shop.CPU_US,
      fixedCap: shop.CAP,
      rps: Math.round(
        (shop.POOL * 1000) /
          shop.SERVICE_MS /
          MIX.reduce((q, m) => q + m.weight * shop.QUERIES[m.path], 0),
      ),
    },
    phases: PHASES,
    mix: MIX,
    sloMs: SLO_MS,
    timeoutMs: TIMEOUT_MS,
    results,
  };
}

if (require.main === module) {
  main().then(
    (out) => {
      console.table(out.results.map(({ routes: _routes, ...r }) => r));
      if (process.env.BENCH_JSON) console.log(JSON.stringify(out));
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
module.exports = { main };
