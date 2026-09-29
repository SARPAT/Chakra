'use strict';
// Middleware overhead: raw Express/Fastify versus the same app with CHAKRA mounted, on a
// tiny JSON route. Two scenarios per variant:
//   max   closed-loop autocannon at saturation. CHAKRA runs in dry-run so it does all its
//         per-request work but admits everything; the req/s drop is its full cost.
//   load  paced at LOAD_SHARE of the raw framework's max req/s, CHAKRA enforcing. Shows
//         latency under normal load and that nothing is shed when there is headroom.

const autocannon = require('autocannon');
const { startServer } = require('./lib/spawn');

const DURATION = Number(process.env.BENCH_DURATION || 10);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS || 50);
const ROUNDS = Number(process.env.BENCH_ROUNDS || 3);
const LOAD_SHARE = Number(process.env.BENCH_LOAD_SHARE || 0.5);
const VARIANTS = [
  ['express', 'none'],
  ['express', 'chakra'],
  ['fastify', 'none'],
  ['fastify', 'chakra'],
];

const cannon = (url, duration, overallRate) =>
  new Promise((resolve, reject) =>
    autocannon({ url, connections: CONNECTIONS, duration, overallRate }, (err, r) =>
      err ? reject(err) : resolve(r),
    ),
  );

async function runVariant([framework, protection], rate) {
  const env = protection === 'chakra' && !rate ? { CHAKRA_MODE: 'dry-run' } : {};
  const server = await startServer([framework, protection, 'hello'], env);
  try {
    const url = `http://127.0.0.1:${server.port}/hello`;
    await cannon(url, 3, rate); // warm-up
    const r = await cannon(url, DURATION, rate);
    if (r.errors) throw new Error(`${framework}+${protection}: ${r.errors} errors`);
    return {
      framework,
      protection,
      rps: Math.round(r.requests.average),
      p50: r.latency.p50,
      p99: r.latency.p99,
      shedPct: +((r.non2xx / (r.requests.total || 1)) * 100).toFixed(2),
    };
  } finally {
    await server.stop();
  }
}

// Interleave variants across rounds so drift (thermal, noisy neighbours) hits all of them;
// report the median round per variant.
async function scenario(rateOf) {
  const rounds = VARIANTS.map(() => []);
  for (let i = 0; i < ROUNDS; i++) {
    for (let v = 0; v < VARIANTS.length; v++) {
      rounds[v].push(await runVariant(VARIANTS[v], rateOf(VARIANTS[v][0])));
    }
  }
  const results = rounds.map((rs) => rs.sort((a, b) => a.rps - b.rps)[rs.length >> 1]);
  for (const r of results) {
    const base = results.find((b) => b.framework === r.framework && b.protection === 'none');
    r.rpsDelta = r === base ? '' : `${(((r.rps - base.rps) / base.rps) * 100).toFixed(1)}%`;
  }
  return results;
}

async function main() {
  const max = await scenario(() => undefined);
  const rates = Object.fromEntries(
    max
      .filter((r) => r.protection === 'none')
      .map((r) => [r.framework, Math.round(r.rps * LOAD_SHARE)]),
  );
  const load = await scenario((framework) => rates[framework]);
  return {
    duration: DURATION,
    connections: CONNECTIONS,
    rounds: ROUNDS,
    loadShare: LOAD_SHARE,
    rates,
    max,
    load,
  };
}

if (require.main === module) {
  main().then(
    (out) => {
      console.table(out.max);
      console.table(out.load);
      if (process.env.BENCH_JSON) console.log(JSON.stringify(out));
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
module.exports = { main };
