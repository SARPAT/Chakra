'use strict';
// Admission-path microbenchmark: nanoseconds and heap bytes per request for
// decide() + done() (the whole per-request core cost) and, when exported,
// limiter acquire() + release(). Allocation figures need the flags `npm run bench` passes:
// node --expose-gc --min-semi-space-size=64 bench/micro.js

const lib = require('..');

const ITER = Number(process.env.BENCH_MICRO_ITER || 2_000_000);
const RUNS = 7;

function measure(name, fn) {
  for (let i = 0; i < ITER / 4; i++) fn(i); // warm up the JIT
  const ns = [];
  for (let r = 0; r < RUNS; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ITER; i++) fn(i);
    ns.push(Number(process.hrtime.bigint() - t0) / ITER);
  }
  ns.sort((a, b) => a - b);
  return {
    name,
    nsPerOp: +ns[RUNS >> 1].toFixed(1),
    nsMin: +ns[0].toFixed(1),
    bytesPerOp: allocated(fn),
  };
}

// Heap bytes per call. Only exact when the young generation holds the whole pass
// (run with --min-semi-space-size=64 or more) so no scavenge runs in between.
function allocated(fn, n = 50_000) {
  global.gc?.();
  const heap0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < n; i++) fn(i);
  return Math.round((process.memoryUsage().heapUsed - heap0) / n);
}

function main() {
  const routes = {
    'POST /checkout': 'critical',
    'GET /browse': 'normal',
    'GET /recommendations': 'sheddable',
  };
  const ctxs = [
    { method: 'POST', path: '/checkout', headers: {} },
    { method: 'GET', path: '/browse', headers: {} },
    { method: 'GET', path: '/recommendations', headers: {} },
    { method: 'GET', path: '/unmatched', headers: {} },
  ];
  const results = [];
  const keep = new Array(1024);
  for (const [label, opts] of [
    ['decide+done (enforce, metrics off)', { metrics: false }],
    ['decide+done (enforce, metrics on)', {}],
    ['decide+done (dry-run)', { mode: 'dry-run' }],
  ]) {
    const c = lib.chakra({ routes, logger: false, ...opts });
    results.push(
      measure(label, (i) => {
        const d = (keep[i & 1023] = c.decide(ctxs[i & 3])); // escapes, as it does in an adapter
        if (d.outcome === 'admit') d.done(200);
      }),
    );
    c.close();
  }
  let createLimiter;
  try {
    ({ createLimiter } = require('../dist/limiter')); // not part of the public API
  } catch {
    // limiter module not built
  }
  if (createLimiter) {
    const l = createLimiter({});
    const bands = ['critical', 'high', 'normal', 'sheddable'];
    results.push(
      measure('limiter acquire+release', (i) =>
        l.acquire(bands[i & 3], true).token?.release('success'),
      ),
    );
    l.stop();
  }
  const probe = lib.chakra({ logger: false });
  const limiter = Number.isFinite(probe.snapshot().limit) ? 'adaptive' : 'admit-all stand-in';
  probe.close();
  return {
    iterations: ITER,
    runs: RUNS,
    limiter,
    gcExposed: typeof global.gc === 'function',
    results,
  };
}

if (require.main === module) {
  const out = main();
  console.table(out.results);
  if (process.env.BENCH_JSON) console.log(JSON.stringify(out));
}
module.exports = { main };
