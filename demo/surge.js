// CHAKRA Demo — Friday Sale Surge Simulator
// Usage: node surge.js
// Requires: demo app running on port 3000

const BASE_URL = process.env.DEMO_URL || 'http://localhost:3000';

// ─── Endpoint definitions with traffic weights ──────────────────────────────

const ENDPOINTS = [
  // Browse endpoints (60% of traffic)
  { method: 'GET', path: '/api/products', weight: 25, category: 'browse' },
  { method: 'GET', path: '/api/products/1', weight: 15, category: 'browse' },
  { method: 'GET', path: '/api/search?q=keyboard', weight: 10, category: 'browse' },
  { method: 'GET', path: '/api/recommendations', weight: 10, category: 'browse' },
  // Cart endpoints (15% of traffic)
  { method: 'POST', path: '/api/cart/add', weight: 8, category: 'cart', body: { productId: 2, qty: 1 } },
  { method: 'GET', path: '/api/cart', weight: 7, category: 'cart' },
  // Payment endpoints (5% of traffic)
  { method: 'POST', path: '/api/checkout', weight: 2, category: 'payment', body: { cartId: 'demo' } },
  { method: 'POST', path: '/api/payment/process', weight: 2, category: 'payment', body: { amount: 129.99, method: 'card' } },
  { method: 'GET', path: '/api/auth/verify', weight: 1, category: 'payment' },
  // Extra browse to reach 60% total
  { method: 'GET', path: '/api/products/3', weight: 10, category: 'browse' },
  { method: 'GET', path: '/api/products/5', weight: 10, category: 'browse' },
];

// ─── Weighted random endpoint picker ────────────────────────────────────────

const totalWeight = ENDPOINTS.reduce((sum, ep) => sum + ep.weight, 0);

function pickEndpoint() {
  let roll = Math.random() * totalWeight;
  for (const ep of ENDPOINTS) {
    roll -= ep.weight;
    if (roll <= 0) return ep;
  }
  return ENDPOINTS[0];
}

// ─── User type headers ──────────────────────────────────────────────────────

function randomHeaders() {
  const roll = Math.random();
  const headers = { 'Content-Type': 'application/json' };
  if (roll < 0.15) {
    headers['X-User-Tier'] = 'premium';
    headers['X-Session-Id'] = `surge-prem-${Math.random().toString(36).slice(2, 8)}`;
  } else if (roll < 0.60) {
    headers['X-User-Tier'] = 'standard';
    headers['X-Session-Id'] = `surge-std-${Math.random().toString(36).slice(2, 8)}`;
  }
  return headers;
}

// ─── Phase stats collector ──────────────────────────────────────────────────

class PhaseStats {
  constructor(name) {
    this.name = name;
    this.requests = 0;
    this.errors = 0;
    this.suspended = 0;
    this.limited = 0;
    this.totalLatency = 0;
  }

  record(statusCode, latencyMs, headers) {
    this.requests++;
    this.totalLatency += latencyMs;
    if (statusCode >= 500) this.errors++;
    if (statusCode === 503) this.suspended++;
    if (headers && (headers['x-chakra-mode'] === 'limited' || headers.get?.('x-chakra-mode') === 'limited')) {
      this.limited++;
    }
  }

  get avgLatency() {
    return this.requests > 0 ? Math.round(this.totalLatency / this.requests) : 0;
  }

  toString() {
    return `${this.name}: ${this.requests} req | ${this.errors} errors | ${this.avgLatency}ms avg latency | ${this.suspended} suspended`;
  }
}

// ─── Fetch-based load generator (no external deps needed) ───────────────────

async function sendRequest(endpoint) {
  const url = `${BASE_URL}${endpoint.path}`;
  const headers = randomHeaders();
  const opts = { method: endpoint.method, headers };
  if (endpoint.body && endpoint.method === 'POST') {
    opts.body = JSON.stringify(endpoint.body);
  }

  const start = Date.now();
  try {
    const res = await fetch(url, opts);
    const latency = Date.now() - start;
    return { statusCode: res.status, latency, headers: res.headers };
  } catch {
    const latency = Date.now() - start;
    return { statusCode: 0, latency, headers: null };
  }
}

async function generateLoad(rps, durationMs, stats, onTick) {
  const intervalMs = 1000 / rps;
  const endTime = Date.now() + durationMs;
  let tickTimer = null;

  if (onTick) {
    tickTimer = setInterval(onTick, 5000);
  }

  const pending = [];
  while (Date.now() < endTime) {
    const ep = pickEndpoint();
    const promise = sendRequest(ep).then((result) => {
      stats.record(result.statusCode, result.latency, result.headers);
    });
    pending.push(promise);

    // Throttle to approximate target RPS
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  if (tickTimer) clearInterval(tickTimer);
  await Promise.allSettled(pending);
}

async function generateRampLoad(startRps, endRps, durationMs, stats, onTick) {
  const stepDurationMs = 1000;
  const totalSteps = Math.floor(durationMs / stepDurationMs);
  let tickTimer = null;

  if (onTick) {
    tickTimer = setInterval(onTick, 5000);
  }

  const pending = [];
  for (let step = 0; step < totalSteps; step++) {
    const progress = step / totalSteps;
    const currentRps = Math.floor(startRps + (endRps - startRps) * progress);
    const requestsThisSecond = Math.max(1, currentRps);
    const intervalMs = 1000 / requestsThisSecond;

    const stepEnd = Date.now() + stepDurationMs;
    while (Date.now() < stepEnd) {
      const ep = pickEndpoint();
      const promise = sendRequest(ep).then((result) => {
        stats.record(result.statusCode, result.latency, result.headers);
      });
      pending.push(promise);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  if (tickTimer) clearInterval(tickTimer);
  await Promise.allSettled(pending);
}

// ─── Try autocannon, fall back to fetch ─────────────────────────────────────

let useAutocannon = false;
let autocannon;
try {
  autocannon = require('autocannon');
  useAutocannon = true;
} catch {
  console.log('ℹ  autocannon not found — using built-in fetch-based load generator\n');
}

// ─── Autocannon-based phase runner ──────────────────────────────────────────

function runAutocannonPhase(rps, duration, stats) {
  return new Promise((resolve) => {
    const instance = autocannon({
      url: BASE_URL,
      connections: Math.min(rps, 200),
      pipelining: 1,
      duration,
      overallRate: rps,
      requests: ENDPOINTS.map((ep) => ({
        method: ep.method,
        path: ep.path,
        headers: randomHeaders(),
        ...(ep.body ? { body: JSON.stringify(ep.body) } : {}),
      })),
    });

    instance.on('response', (client, statusCode, _resBytes, responseTime) => {
      stats.record(statusCode, responseTime, null);
    });

    instance.on('done', () => resolve());
  });
}

// ─── Main surge simulation ──────────────────────────────────────────────────

async function run() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║       CHAKRA DEMO — Friday Sale Surge        ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  // ── Phase 1: Normal traffic ───────────────────────────────────────────────
  const phase1 = new PhaseStats('Phase 1 (Normal)');
  console.log('▸ Phase 1: Normal traffic (100 req/sec) — 30 seconds');
  console.log('  Expected: CHAKRA sleeping, all endpoints serving\n');

  if (useAutocannon) {
    await runAutocannonPhase(100, 30, phase1);
  } else {
    await generateLoad(100, 30000, phase1);
  }
  console.log(`  ✓ Phase 1 complete: ${phase1.requests} requests, ${phase1.errors} errors\n`);

  // ── Phase 2: Sale surge ───────────────────────────────────────────────────
  const phase2 = new PhaseStats('Phase 2 (Surge) ');
  console.log('▸ Phase 2: SALE STARTED — traffic surging!');
  console.log('  Ramping from 100 → 800 req/sec over 15 seconds');
  console.log('  Holding at 800 req/sec for 45 seconds');
  console.log('  Expected: CHAKRA activates, recommendations suspended\n');

  const liveStatsTick = () => {
    const elapsed = phase2.requests > 0 ? Math.round(phase2.totalLatency / phase2.requests) : 0;
    console.log(
      `  [LIVE] ${phase2.requests} req | ${phase2.errors} err | ${elapsed}ms avg | ${phase2.suspended} suspended`,
    );
  };

  if (useAutocannon) {
    // Ramp phase (15s at avg ~450 rps)
    await runAutocannonPhase(450, 15, phase2);
    // Hold phase (45s at 800 rps)
    const holdPhase = new PhaseStats('_hold');
    const tickInterval = setInterval(liveStatsTick, 5000);
    await runAutocannonPhase(800, 45, holdPhase);
    clearInterval(tickInterval);
    // Merge hold into phase2
    phase2.requests += holdPhase.requests;
    phase2.errors += holdPhase.errors;
    phase2.suspended += holdPhase.suspended;
    phase2.limited += holdPhase.limited;
    phase2.totalLatency += holdPhase.totalLatency;
  } else {
    // Ramp up
    await generateRampLoad(100, 800, 15000, phase2, liveStatsTick);
    // Hold at 800
    await generateLoad(800, 45000, phase2, liveStatsTick);
  }
  console.log(`\n  ✓ Phase 2 complete: ${phase2.requests} requests, ${phase2.suspended} suspended\n`);

  // ── Phase 3: Traffic normalises ───────────────────────────────────────────
  const phase3 = new PhaseStats('Phase 3 (Restore)');
  console.log('▸ Phase 3: Traffic normalising');
  console.log('  Ramping down from 800 → 150 req/sec over 15 seconds');
  console.log('  Holding at 150 req/sec for 15 seconds');
  console.log('  Expected: CHAKRA gradual restore\n');

  if (useAutocannon) {
    await runAutocannonPhase(400, 15, phase3);
    await runAutocannonPhase(150, 15, phase3);
  } else {
    await generateRampLoad(800, 150, 15000, phase3);
    await generateLoad(150, 15000, phase3);
  }
  console.log(`  ✓ Phase 3 complete: ${phase3.requests} requests\n`);

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalSuspended = phase1.suspended + phase2.suspended + phase3.suspended;
  const totalLimited = phase1.limited + phase2.limited + phase3.limited;
  const totalRequests = phase1.requests + phase2.requests + phase3.requests;

  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║                        SURGE SUMMARY                            ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log(`║  ${phase1.toString().padEnd(63)}║`);
  console.log(`║  ${phase2.toString().padEnd(63)}║`);
  console.log(`║  ${phase3.toString().padEnd(63)}║`);
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log(`║  Total requests:              ${String(totalRequests).padEnd(33)}║`);
  console.log(`║  Requests suspended by CHAKRA: ${String(totalSuspended).padEnd(32)}║`);
  console.log(`║  Requests limited by CHAKRA:   ${String(totalLimited).padEnd(32)}║`);
  console.log(`║  Requests protected (served):  ${String(totalRequests - totalSuspended).padEnd(32)}║`);
  console.log('╚══════════════════════════════════════════════════════════════════╝');
}

run().catch((err) => {
  console.error('Surge script failed:', err);
  process.exit(1);
});
