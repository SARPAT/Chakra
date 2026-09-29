# Configuration reference

```js
const { chakra } = require('chakra-middleware');
const c = chakra(options);
```

Options are validated when `chakra()` is called. Invalid values and unknown keys throw a `ChakraConfigError` whose `problems` array lists every issue at once, so a bad config fails at startup, not under load. After construction CHAKRA never throws into the request path.

## Top-level options

| Option            | Type                                                | Default           | Notes                                                                 |
| ----------------- | --------------------------------------------------- | ----------------- | --------------------------------------------------------------------- |
| `mode`            | `'enforce' \| 'dry-run' \| 'off'`                   | `'enforce'`       | `CHAKRA_MODE` overrides it. See [Modes](#modes).                      |
| `defaultPriority` | `Priority`                                          | `'normal'`        | For requests no rule or resolver assigns.                             |
| `routes`          | `Record<string, Priority \| { priority, fallback? }>` | `{}`            | See [Routes](#routes).                                                |
| `priority`        | `(ctx) => Priority \| undefined`                    | none              | Checked before route rules. See [Resolver](#priority-resolver).       |
| `limiter`         | object                                              | see below         | See [Limiter](#limiter).                                              |
| `shedResponse`    | `ShedResponse`                                      | 503, see below    | Response written for shed requests.                                   |
| `metrics`         | `false \| { prefix?, maxRoutes? } \| ChakraEventSink` | Prometheus on   | See [Metrics](#metrics).                                              |
| `logger`          | `{ info, warn, error } \| false`                    | console, `[CHAKRA]` prefix | `false` silences CHAKRA.                                     |

`Priority` is one of `'critical' | 'high' | 'normal' | 'sheddable'`.

## Modes

| Mode      | Behaviour                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------- |
| `enforce` | Sheds requests when their band is over its share of the limit.                                  |
| `dry-run` | Runs the same decisions but admits everything. Would-be sheds get `req.chakra.wouldShed = true`, are counted with `dry_run="true"` and summarised in rate-limited log lines. |
| `off`     | Pure pass-through: no limiter work, no metrics.                                                 |

The `CHAKRA_MODE` environment variable (case-insensitive) always wins over the `mode` option, so operators can switch modes without a code change. An invalid `CHAKRA_MODE` is a startup error.

## Routes

```js
routes: {
  'POST /checkout': 'critical',
  'GET /api/products/:id': 'high',
  'GET /recommendations': { priority: 'sheddable', fallback: { status: 200, body: [] } },
  '* /internal/*': 'sheddable',
}
```

- Keys are `'METHOD /pattern'`. Methods: `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, or `*` for any.
- Patterns support static segments, `:param` segments and a trailing `*`.
- When several rules match, the most specific wins (more static segments, no wildcard).
- `fallback` replaces `shedResponse` for this route only; unspecified fields inherit from `shedResponse`.
- Inline tags (`route('critical')` in Express, `config: { chakra: 'critical' }` in Fastify) are added to the same table. A rule in `routes` for the same method and pattern takes precedence.
- The matched rule's key (e.g. `GET /api/products/:id`) is the metrics `route` label. Unmatched requests are labelled `<unmatched>`, never with their raw path.

## Priority resolver

```js
priority: (ctx) => {
  if (ctx.user?.role === 'admin') return 'critical';
  if (ctx.user?.plan === 'free' && ctx.method === 'GET') return 'sheddable';
  return undefined; // fall through to routes, then defaultPriority
}
```

`ctx` is a `RequestContext`: `{ method, path, route?, headers, user?, raw? }`. `user` is `req.user` as set by your auth layer; `raw` is the framework request. The resolver runs on every request, so keep it to a few property reads.

Do not read priority, tiers or identity from headers. Anyone can send `X-User-Tier: enterprise`.

If the resolver throws or returns an unknown value, CHAKRA logs a warning once and falls through to route rules.

## Limiter

| Option                | Default                                                  | Meaning                                                                          |
| --------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `algorithm`           | `'gradient2'`                                            | `gradient2` compares recent latency with a long-term baseline. `aimd` is a simpler, more conservative additive-increase / multiplicative-decrease. |
| `initialLimit`        | `20`                                                     | Concurrency limit at startup. It adapts within seconds.                          |
| `minLimit`            | `1`                                                      | Floor for the adaptive limit.                                                    |
| `maxLimit`            | `1000`                                                   | Ceiling for the adaptive limit.                                                  |
| `maxEventLoopDelayMs` | `100`                                                    | Above this p99 event-loop delay the limit shrinks regardless of latency.         |
| `bandShares`          | `{ critical: 1, high: 0.9, normal: 0.75, sheddable: 0.5 }` | Share of the current limit each band may occupy. Values in (0, 1].             |
| `degradeAt`           | `0.8`                                                    | Fraction of a band's share above which admitted requests are marked `degraded`.  |

A request of band `b` is admitted while `inFlight < floor(limit × bandShares[b])`; `critical` can always use at least one slot. With a limit of 40, `sheddable` stops at 20 in flight, `normal` at 30, `high` at 36 and `critical` at 40.

`initialLimit` must lie between `minLimit` and `maxLimit`.

## Shed response

```js
shedResponse: {
  status: 503,                  // any HTTP status 200-599
  retryAfterSeconds: 1,         // sets Retry-After; 0 or more
  headers: { 'cache-control': 'no-store' },
  body: { error: 'overloaded', message: 'The service is busy. Please retry shortly.' },
}
```

A string body is sent as-is; anything else is sent as JSON. The defaults are shown above. A route's `fallback` merges over this.

## Metrics

- Default: a built-in Prometheus exporter. Serve it with `app.get('/metrics', c.metricsHandler)`.
- `{ prefix, maxRoutes }`: change the metric name prefix (default `chakra_`) or the cap on distinct `route` label values (default 200; extra routes are grouped as `__other__`).
- `false`: no metrics. `c.metricsHandler` answers 404.
- Any object with `emit(event)`: your own `ChakraEventSink` (for example to forward events to StatsD). CHAKRA catches and logs errors it throws.

## Fastify

`app.register(c.fastify)` runs admission in the `onRequest` hook, the earliest point, so a shed request costs almost nothing. If your priority resolver needs `request.user` set by an authentication hook, run CHAKRA after it in `preHandler` instead (see the exported `fastifyPlugin` options in the type definitions).

## Instance API

| Member                     | Description                                                                |
| -------------------------- | -------------------------------------------------------------------------- |
| `c` (Express)              | The instance is Express middleware: `app.use(c)`.                          |
| `c.fastify`                | Fastify plugin: `app.register(c.fastify)`.                                 |
| `c.metricsHandler(req, res)` | Prometheus scrape handler on Node's `IncomingMessage` / `ServerResponse`. |
| `c.setOverrides({ closedBands })` | Close bands immediately, e.g. `['sheddable']`. `[]` reopens all.    |
| `c.getOverrides()`         | Current overrides.                                                         |
| `c.snapshot()`             | `{ limit, inFlight, pressure, eventLoopDelayMs, bandLimits }`.             |
| `c.dryRunReport()`         | In dry-run mode: totals and per-route counts of would-be sheds.            |
| `c.mode`, `c.options`      | Effective mode and resolved options.                                       |
| `c.close()`                | Stops background timers. Idempotent.                                       |

`EMERGENCY_PRESETS` provides named overrides: `restore-all`, `shed-sheddable`, `shed-normal`, `critical-only`. No preset closes `critical`.
