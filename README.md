<div align="center">

<img src="assets/chakra-logo.png" alt="CHAKRA logo" width="140" />

# CHAKRA

**Priority-aware adaptive load shedding for Node.js.**
When your service runs short of capacity, CHAKRA sheds the least important requests first so checkout, payment and login keep working.

[![CI](https://github.com/SARPAT/Chakra/actions/workflows/ci.yml/badge.svg)](https://github.com/SARPAT/Chakra/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/chakra-middleware.svg)](https://www.npmjs.com/package/chakra-middleware)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.18-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-Apache--2.0-D22128)](LICENSE)

[Getting started](docs/getting-started.md) · [Configuration](docs/configuration.md) · [Production rollout](docs/production-rollout.md) · [Operations & FAQ](docs/operations.md) · [Benchmarks](bench/RESULTS.md)

</div>

## Why

When a Node.js service is overloaded, every request gets slower until they all time out. A rate limiter or a blanket `503` makes it fail faster, but it fails your checkout just as often as your recommendation carousel.

CHAKRA makes overload **selective**:

- **Always on, invisible until needed.** An adaptive concurrency limiter (Gradient2, or AIMD) tracks request latency and event-loop delay and adjusts its limit in milliseconds. There is nothing to activate and no threshold to guess.
- **You declare what matters.** Tag routes `critical`, `high`, `normal` or `sheddable`. Each band may use only a share of the current limit, so `sheddable` is refused first and `critical` keeps capacity until the very end.
- **Degrade before shedding.** Requests admitted close to their band's limit arrive with `req.chakra.degraded === true`, so handlers can skip the expensive part and still answer.
- **Safe to roll out.** Dry-run mode admits everything and reports what it would have shed.
- **Metrics out, nothing in.** Prometheus metrics and a ready-made Grafana dashboard. No UI server, no listening ports, no database.
- **Small and dependency-free.** Pure TypeScript, no native modules, no runtime dependencies, no PII stored. Per-request overhead is measured in microseconds ([benchmarks](bench/RESULTS.md)).

## Install

```bash
npm install chakra-middleware
```

Node.js 18.18 or newer. Express 4+ and Fastify 4+ are optional peer dependencies.

## Two-line setup

**Express**

```js
const { chakra } = require('chakra-middleware');

const c = chakra({ routes: { 'POST /checkout': 'critical', 'GET /recommendations': 'sheddable' } });
app.use(c); // before your routes
```

**Fastify**

```js
const { chakra } = require('chakra-middleware');

const c = chakra({ routes: { 'POST /checkout': 'critical', 'GET /recommendations': 'sheddable' } });
app.register(c.fastify); // before your routes
```

With no routes at all, every request is `normal` and CHAKRA only sheds when the process is genuinely saturated. That is a safe default, but declaring priorities is where the value is.

## See it work

```bash
npx chakra demo          # overloads a sample shop API and shows per-route results live
npx chakra demo --off    # the same surge without CHAKRA, for comparison
npx chakra init          # writes chakra.config.js with the routes found in your project
```

## Priorities

| Priority    | Default share of the limit | Use it for                                    |
| ----------- | -------------------------- | --------------------------------------------- |
| `critical`  | 100%                       | checkout, payment, login, health checks       |
| `high`      | 90%                        | core product pages and APIs                   |
| `normal`    | 75%                        | everything you did not tag                    |
| `sheddable` | 50%                        | recommendations, analytics, prefetch, exports |

Priority is resolved per request in this order: your `priority(ctx)` function, then the matching route rule, then `defaultPriority` (`normal`).

```js
const c = chakra({
  routes: {
    'POST /checkout': 'critical',
    'GET /api/products/:id': 'high',
    'GET /recommendations': { priority: 'sheddable', fallback: { status: 200, body: [] } },
    '* /internal/*': 'sheddable',
  },
  // Use the authenticated user, never request headers: clients control headers.
  priority: (ctx) => (ctx.user?.plan === 'enterprise' ? 'high' : undefined),
});
```

In Express you can also tag a route inline, and in Fastify through route config:

```js
const { route } = require('chakra-middleware');
app.post('/checkout', route('critical'), handler);                         // Express
app.post('/checkout', { config: { chakra: 'critical' } }, handler);        // Fastify
```

## Degrade mode

```js
app.get('/products/:id', async (req, res) => {
  const product = await db.product(req.params.id);
  if (req.chakra?.degraded) return res.json(product); // skip reviews and recommendations
  res.json({ ...product, reviews: await reviews(product.id), related: await related(product.id) });
});
```

`req.chakra` holds `{ priority, degraded, wouldShed, pressure, mode }`. Shed requests never reach your handler; they get a `503` with `Retry-After` (configurable globally with `shedResponse` or per route with `fallback`).

## Roll out with dry-run

```bash
CHAKRA_MODE=dry-run node server.js
```

Dry-run runs the real limiter, admits every request, marks would-be sheds with `req.chakra.wouldShed`, exports them as `dry_run="true"` metrics and logs a rate-limited summary. When the numbers look right, remove the variable to enforce. `CHAKRA_MODE=off` turns CHAKRA into a pass-through without a redeploy. See [Production rollout](docs/production-rollout.md).

## Metrics and dashboard

```js
app.get('/metrics', c.metricsHandler); // Express; you choose the path and who can reach it
```

| Metric                                                     | Type      |
| ---------------------------------------------------------- | --------- |
| `chakra_requests_total{decision,band,route,dry_run}`       | counter   |
| `chakra_inflight_requests`                                 | gauge     |
| `chakra_concurrency_limit`                                 | gauge     |
| `chakra_event_loop_lag_seconds`                            | gauge     |
| `chakra_shed_latency_seconds{band}`                        | histogram |

Import [`grafana/chakra-dashboard.json`](grafana/chakra-dashboard.json) into Grafana for shed ratio per band, limit vs in-flight, event-loop lag and top shed routes. `route` labels are route patterns, never raw paths, and are capped in number.

## Incident lever

```js
const { EMERGENCY_PRESETS } = require('chakra-middleware');

c.setOverrides({ closedBands: ['sheddable'] });   // shed a band outright
c.setOverrides(EMERGENCY_PRESETS['critical-only']); // high, normal and sheddable closed
c.setOverrides(EMERGENCY_PRESETS['restore-all']);
```

Expose this behind your own authenticated admin route or feature-flag system; CHAKRA opens no ports.

## Configuration at a glance

```js
chakra({
  mode: 'enforce',                 // 'enforce' | 'dry-run' | 'off'; CHAKRA_MODE env wins
  defaultPriority: 'normal',
  routes: {},                      // { 'METHOD /pattern': priority | { priority, fallback } }
  priority: undefined,             // (ctx) => priority | undefined
  limiter: {
    algorithm: 'gradient2',        // or 'aimd'
    initialLimit: 20, minLimit: 1, maxLimit: 1000,
    maxEventLoopDelayMs: 100,
    bandShares: { critical: 1, high: 0.9, normal: 0.75, sheddable: 0.5 },
    degradeAt: 0.8,
  },
  shedResponse: { status: 503, retryAfterSeconds: 1, body: { error: 'overloaded', message: '...' } },
  metrics: { prefix: 'chakra_', maxRoutes: 200 }, // or false, or your own sink
  logger: console-like | false,
});
```

Invalid options throw a `ChakraConfigError` listing every problem at startup; unknown keys are errors. After construction CHAKRA never throws into your request path: on any internal failure the request is admitted. Full reference: [docs/configuration.md](docs/configuration.md).

## How it compares

|                                    | Rate limiter            | Autoscaling            | CHAKRA                                   |
| ---------------------------------- | ----------------------- | ---------------------- | ---------------------------------------- |
| Reacts to                          | request count per key   | CPU / queue metrics    | latency and event-loop delay, per process |
| Reaction time                      | immediate               | minutes                | milliseconds                             |
| Needs a threshold you pick         | yes                     | yes                    | no, the limit adapts                     |
| Knows checkout matters more        | no                      | no                     | yes                                      |
| Protects against slow dependencies | no                      | often makes it worse   | yes, latency drives the limit            |

Use them together. Rate limiters stop abusive clients, autoscaling adds capacity, and CHAKRA keeps critical traffic healthy while capacity is short: surges, slow dependencies, bad deploys, retry storms, bot floods.

## Design

- [ADR 0001: adaptive admission control](docs/adr/0001-adaptive-admission-control.md) explains the design and why v0.1 was replaced.
- State is per process on purpose. Every process protects its own event loop; there is no Redis and nothing to coordinate.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## License

[Apache-2.0](LICENSE)
