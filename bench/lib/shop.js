'use strict';
// Demo shop with a fixed capacity: every request makes queries against a simulated
// database pool of POOL connections, SERVICE_MS each, queued FIFO when all are busy,
// plus CPU_US of synchronous work on the event loop. Capacity is about
// POOL * 1000 / SERVICE_MS queries per second.

const POOL = Number(process.env.BENCH_POOL || 8);
const SERVICE_MS = Number(process.env.BENCH_SERVICE_MS || 10);
const CPU_US = Number(process.env.BENCH_CPU_US || 100);
/** Concurrency limit for the fixed-cap baseline: twice the pool, a typical hand-tuned value. */
const CAP = Number(process.env.BENCH_CAP || POOL * 2);

const ROUTES = {
  'POST /checkout': 'critical',
  'GET /browse': 'normal',
  'GET /recommendations': 'sheddable',
};
/** Queries per request. Recommendations are the expensive, least important page. */
const QUERIES = { '/checkout': 1, '/browse': 1, '/recommendations': 2 };

let busy = 0;
const waiting = [];

function query() {
  return new Promise((resolve) => {
    const run = () => {
      busy++;
      setTimeout(() => {
        busy--;
        resolve();
        if (waiting.length) waiting.shift()();
      }, SERVICE_MS);
    };
    if (busy < POOL) run();
    else waiting.push(run);
  });
}

function spin(us) {
  const end = process.hrtime.bigint() + BigInt(us * 1000);
  while (process.hrtime.bigint() < end);
}

async function handlerFor(path, chakra) {
  spin(CPU_US);
  // Degrade before shedding: a degraded request skips the optional second query.
  const n = chakra?.degraded ? 1 : QUERIES[path];
  for (let i = 0; i < n; i++) await query();
  return { ok: true, path, degraded: Boolean(chakra?.degraded) };
}

module.exports = { POOL, SERVICE_MS, CPU_US, CAP, ROUTES, QUERIES, handlerFor };
