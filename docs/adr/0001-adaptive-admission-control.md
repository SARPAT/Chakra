# ADR 0001: Rebuild CHAKRA as priority-aware adaptive admission control

- **Status:** Accepted (2026-09-28)
- **Supersedes:** the v0.1 design in `docs/archive/v0/` (CP0–CP9)

## Context

v0.1 was an Express middleware that computed a 0–100 "RPM" load score every 5 seconds, activated degradation levels 0–3 when the score crossed a threshold, scored suspended requests with an eight-signal Weight Engine, and learned traffic for 30 days in a SQLite-backed Shadow Mode. Running it under load showed that:

- It took about 25–30 seconds from a spike to any action. Real surges take a service down in 2–5 seconds.
- `chakra.block()` registered every block as "never suspend", so nothing was shed even at Level 3.
- Priority came from client-controlled headers (`X-User-Tier`, `X-Session-Id`), and session depth gave heavy callers (scrapers) more protection.
- Shadow Mode added a native dependency (`better-sqlite3`), a synchronous write per request, and stored behavioural data with unsalted hashes.
- The in-process dashboard listened on all interfaces without auth, and each pod had its own.
- The Container Bridge needed Kubernetes/AWS credentials inside every application pod.

## Decision

CHAKRA becomes a library for **priority-aware adaptive load shedding** in Node.js:

1. **Adaptive concurrency limiter** (`src/limiter/`) replaces the RPM Engine, activation levels, Auto/Manual mode and gradual restore. It is always on, adjusts its limit continuously from latency and event-loop delay, and reacts in milliseconds.
2. **Declared priority** (`src/priority/`) replaces the Weight Engine and Ring Mapper. Routes are tagged `critical | high | normal | sheddable`. A per-request resolver can raise or lower priority using the authenticated user (`ctx.user`), never request headers.
3. **Priority bands**: each band may occupy only a share of the current limit, so lower bands are shed first and `critical` keeps capacity.
4. **Degrade mode**: admitted requests near a band's limit get `req.chakra.degraded = true` so handlers can return a lighter payload.
5. **Dry-run mode** replaces Shadow Mode: run the limiter, admit everything, report what would have been shed.
6. **Metrics out** (`src/observability/`): Prometheus text exposition plus a Grafana dashboard JSON replace the built-in dashboard server.
7. **Per-process state on purpose.** Each process protects its own capacity; no Redis or shared state.
8. **No native dependencies, no listening ports by default, no PII stored.**

### Removed

RPM Engine, Session Cache, Shadow Mode (observer, analyser, suggester, SQLite), Weight Engine, Ring Mapper, Dispatcher, Policy Engine, Activation controller, dashboard server/API/HTML, Container Bridge (Kubernetes, ECS, Prometheus, webhook), SHA-256 hasher, the Docker demo and dev server. Manual control survives as **band overrides** (`setOverrides({ closedBands })`).

## Module ownership and layout

```
src/
├── index.ts               public API: chakra(options) — foundation thread
├── types.ts               shared contracts — foundation thread, change only via ADR amendment
├── config/schema.ts       ChakraOptions + validation — foundation thread
├── core/admission.ts      framework-free decide() — foundation thread
├── core/defaults.ts       no-op limiter/metrics and exact-match resolver used until modules land
├── limiter/               adaptive concurrency limiter — "Adaptive concurrency limiter" thread
├── priority/              route table + route() tagging — "Route priority and degrade mode" thread
├── adapters/express.ts    Express adapter — "Route priority and degrade mode" thread
├── adapters/fastify.ts    Fastify adapter — "Route priority and degrade mode" thread
├── observability/         Prometheus exporter, dry-run report — "Metrics and dry-run" thread
└── utils/logger.ts        console logger
grafana/chakra.json        dashboard — "Metrics and dry-run" thread
```

Threads other than foundation do not edit `src/index.ts`, `src/types.ts`, `src/config/`, `src/core/` or `CLAUDE.md`. If a contract below does not fit, ask for an amendment instead of working around it.

## Contracts

All types live in `src/types.ts`. Summary:

### Core (foundation)

```ts
interface AdmissionCore { decide(ctx: RequestContext): Decision }
type Decision = AdmitDecision | ShedDecision
// AdmitDecision: { outcome: 'admit', info: ChakraRequestInfo, done(statusCode, aborted?) }
// ShedDecision:  { outcome: 'shed',  info: ChakraRequestInfo, response: { status, headers, body } }
```

`decide()` order: mode `off` → admit untouched. Resolve priority: `options.priority(ctx)` → `resolver.match(ctx)?.priority` → `options.defaultPriority` (`normal`). If the band is closed by an override → shed. Otherwise `limiter.acquire(priority, force = dryRun)`. In dry-run, a rejection becomes an admit with `wouldShed: true`. Any internal error → admit. `decide()` never throws.

### Limiter (`src/limiter/`)

Export `createLimiter(options?: LimiterOptions, sink?: ChakraEventSink): Limiter`.

- `acquire(priority, force?)` → `{ admitted, degraded, token }`. A non-forced rejection must not count as in flight. `token.release('success' | 'error' | 'dropped')` exactly once; latency is measured from `acquire` to `release` inside the limiter.
- Algorithm: Gradient2 by default (AIMD available), bounded by `minLimit`/`maxLimit`. Event-loop p99 delay above `maxEventLoopDelayMs` shrinks the limit.
- Band `b` is admitted while `inFlight < floor(limit × bandShares[b])` (critical always ≥ 1). `degraded` when `inFlight ≥ bandLimit × degradeAt`.
- Uses `perf_hooks.monitorEventLoopDelay`; timers are `unref()`'d.
- Hot-path budget: `acquire` + `release` under 5 µs, no allocation beyond the token.

### Priority and adapters (`src/priority/`, `src/adapters/`)

- `createRouteTable(routes?: Record<string, Priority | RouteRuleInput>): RouteTable`. Keys are `'METHOD /pattern'` (`'*'` as method matches any); patterns support `:param` and a trailing `*`. `match()` returns the most specific rule; `RouteRule.key` is the normalised `'METHOD /pattern'`.
- `route(priority, options?: { fallback?: ShedResponse }): RequestHandler`: a tagged pass-through Express middleware. The Express adapter discovers tagged handlers by walking the app's router stack on the first request and adds their patterns to the table.
- `expressMiddleware(core: AdmissionCore, table: RouteTable): RequestHandler`: builds `RequestContext` (`user: req.user`), writes shed responses, sets `req.chakra` (with the `Express.Request` augmentation), and calls `done(res.statusCode, aborted)` once on `finish` or `close`.
- `fastifyPlugin(core: AdmissionCore, table: RouteTable)`: registers `onRoute` (reads `routeOptions.config.chakra` as a Priority or RouteRuleInput) and `onRequest`/`onResponse` hooks; sets `request.chakra`.

### Observability (`src/observability/`)

The event contract comes from the "Metrics and dry-run" thread and lives in `src/types.ts`: `ChakraEventSink.emit(event)` with `AdmissionEvent`, `ShedCompleteEvent`, `LimiterStateEvent` and `EventLoopLagEvent`.

- **Core** emits one `admission` event per request (`decision: admitted | degraded | shed`, `dryRun`, `reason: limit_exceeded | band_closed`, `limit`, `inFlight`) and a `shed_complete` event for each shed request.
- **Limiter** emits `limiter_state` when its limit or in-flight count changes (or periodically) and `event_loop_lag` from its sampler. It therefore takes the sink: `createLimiter(options?, sink?)`.
- **Exporter**: `createPrometheusExporter(options?: { prefix?: string; maxRoutes?: number }): MetricsExporter`, dependency-free text exposition. Metric names and labels are owned by `src/observability/metric-names.ts` (`chakra_requests_total{decision,band,route,dry_run}`, `chakra_inflight_requests`, `chakra_concurrency_limit`, `chakra_event_loop_lag_seconds`, `chakra_shed_latency_seconds{band}`), and `grafana/chakra-dashboard.json` is built on them.
- `resolveMode()` (reads `CHAKRA_MODE`) must accept `off` as well as `enforce` and `dry-run`; `off` means CHAKRA is a pure pass-through and emits nothing.
- A dry-run report helper summarising dry-run `shed` decisions per route and band.

## Public API (foundation)

```ts
import { chakra } from 'chakra-middleware';

const c = chakra({
  mode: 'enforce',                      // 'enforce' | 'dry-run' | 'off'; env CHAKRA_MODE wins
  routes: { 'POST /checkout': 'critical', 'GET /recommendations': 'sheddable' },
  priority: (ctx) => (ctx.user as { plan?: string })?.plan === 'enterprise' ? 'high' : undefined,
  limiter: { maxLimit: 500 },
  shedResponse: { status: 503, retryAfterSeconds: 2 },
  metrics: { prefix: 'chakra_' },       // or false, or your own ChakraEventSink
});

app.use(c);                             // Express middleware (once the adapter lands)
app.get('/metrics', c.metricsHandler);  // Prometheus scrape endpoint
c.setOverrides({ closedBands: ['sheddable'] }); // manual lever for incidents
c.snapshot();                           // limiter state
c.close();                              // stop timers
```

Invalid options throw a `ChakraConfigError` listing every problem when `chakra()` is called. After construction, nothing CHAKRA does may throw into the host application.

## One-command install

`npm install chakra-middleware` plus two lines of code, safe with zero config: with no routes declared, everything is `normal` and CHAKRA only sheds when the process is saturated. Later: `npx chakra init` (scaffold config from discovered routes) and `npx chakra demo` (sample app + load generator with a terminal view).

## Consequences

- Much less code and no native build step; works on slim images and serverless.
- Decisions become explainable ("band `sheddable` was over 50% of a limit of 40") and fast.
- Loses the "learns your app" story and the bundled UI. Operators use their existing Prometheus/Grafana.
- Multi-pod coordination is not provided; overrides are per process unless applied through configuration.
- The v0.1 test suite is removed with the code it tested. New tests must check behaviour (a sheddable route returns 503 under overload while a critical route succeeds), not only internals.
