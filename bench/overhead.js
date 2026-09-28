'use strict';
// Middleware overhead under normal load: raw Express/Fastify versus the same app with
// CHAKRA mounted, on a tiny JSON route. Closed-loop autocannon load well below saturation
// of the admission limiter, so every request is admitted and only CHAKRA's cost shows.

const autocannon = require('autocannon');
const { startServer } = require('./lib/spawn');

const DURATION = Number(process.env.BENCH_DURATION || 10);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS || 50);
const ROUNDS = Number(process.env.BENCH_ROUNDS || 3);
const VARIANTS = [
  ['express', 'none'],
  ['express', 'chakra'],
  ['fastify', 'none'],
  ['fastify', 'chakra'],
];

const cannon = (url, duration) =>
  new Promise((resolve, reject) =>
    autocannon({ url, connections: CONNECTIONS, duration, pipelining: 1 }, (err, r) => (err ? reject(err) : resolve(r))));

async function runVariant([framework, protection]) {
  const server = await startServer([framework, protection, 'hello']);
  try {
    const url = `http://127.0.0.1:${server.port}/hello`;
    await cannon(url, 3); // warm-up
    const r = await cannon(url, DURATION);
    if (r.non2xx || r.errors) throw new Error(`${framework}+${protection}: ${r.non2xx} non-2xx, ${r.errors} errors`);
    return { framework, protection, adapter: server.adapter, rps: r.requests.average, p50: r.latency.p50, p99: r.latency.p99 };
  } finally {
    await server.stop();
  }
}

async function main() {
  // Interleave variants across rounds so drift (thermal, noisy neighbours) hits all of them;
  // report the median round per variant.
  const rounds = VARIANTS.map(() => []);
  for (let i = 0; i < ROUNDS; i++) {
    for (let v = 0; v < VARIANTS.length; v++) rounds[v].push(await runVariant(VARIANTS[v]));
  }
  const results = rounds.map((rs) => rs.sort((a, b) => a.rps - b.rps)[rs.length >> 1]);
  for (const r of results) {
    const base = results.find((b) => b.framework === r.framework && b.protection === 'none');
    r.rpsDelta = r === base ? '' : `${(((r.rps - base.rps) / base.rps) * 100).toFixed(1)}%`;
  }
  return { duration: DURATION, connections: CONNECTIONS, rounds: ROUNDS, results };
}

if (require.main === module) {
  main().then((out) => {
    console.table(out.results);
    if (process.env.BENCH_JSON) console.log(JSON.stringify(out));
  }, (err) => {
    console.error(err);
    process.exit(1);
  });
}
module.exports = { main };
