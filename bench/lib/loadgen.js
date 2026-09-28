'use strict';
// Open-loop load generator: sends requests at a scheduled rate whatever the server's
// latency (unlike closed-loop tools, a slow server does not slow the client down, so
// overload shows up as it does in production). Records every request.

const http = require('node:http');

/**
 * @param {object} o
 * @param {number} o.port
 * @param {{ seconds: number, rps: number }[]} o.phases
 * @param {{ method: string, path: string, weight: number }[]} o.mix
 * @param {number} o.timeoutMs  client gives up (counted as a failure) after this long
 */
function run({ port, phases, mix, timeoutMs }) {
  const total = Math.floor(phases.reduce((n, p) => n + p.seconds * p.rps, 0));
  const sentAt = new Float64Array(total);
  const latency = new Float64Array(total);
  const status = new Int16Array(total).fill(-1); // -1 pending, 0 timeout/error
  const route = new Uint8Array(total);
  const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
  const cumulative = mix.reduce((acc, m) => [...acc, (acc.at(-1) ?? 0) + m.weight], []);
  const pick = (r) => cumulative.findIndex((c) => r * cumulative.at(-1) < c);

  // Deterministic route sequence so every protection mode sees the same traffic.
  let seed = 42;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  return new Promise((resolve) => {
    let sent = 0;
    let finished = 0;
    const t0 = performance.now();
    const due = (t) => {
      let n = 0;
      let start = 0;
      for (const p of phases) {
        const s = Math.min(Math.max(t - start, 0), p.seconds * 1000);
        n += (s / 1000) * p.rps;
        start += p.seconds * 1000;
      }
      return Math.min(Math.floor(n), total);
    };
    const record = (i, code) => {
      if (status[i] !== -1) return;
      status[i] = code;
      latency[i] = performance.now() - t0 - sentAt[i];
      if (++finished === total) done();
    };
    const send = (i) => {
      const m = mix[(route[i] = pick(random()))];
      sentAt[i] = performance.now() - t0;
      const req = http.request({ agent, host: '127.0.0.1', port, method: m.method, path: m.path }, (res) => {
        res.resume();
        res.once('end', () => record(i, res.statusCode));
        res.once('error', () => record(i, 0));
      });
      req.setTimeout(timeoutMs, () => (record(i, 0), req.destroy()));
      req.once('error', () => record(i, 0));
      req.end();
    };
    const timer = setInterval(() => {
      const target = due(performance.now() - t0);
      while (sent < target) send(sent++);
      if (sent === total) clearInterval(timer);
    }, 1);
    function done() {
      agent.destroy();
      resolve({ sentAt, latency, status, route, count: total });
    }
  });
}

module.exports = { run };
