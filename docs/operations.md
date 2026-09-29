# Operations and FAQ

## During an incident

**Everything is slow and CHAKRA is shedding.** That is the intended behaviour: capacity is short and CHAKRA is protecting higher bands. Check the dashboard's shed ratio per band. If only `sheddable` and `normal` are shed and `critical` is healthy, you have time to find the cause (slow dependency, bad deploy, surge) and add capacity.

**You need to shed more, right now.** Close bands in each process:

```js
const { EMERGENCY_PRESETS } = require('chakra-middleware');

c.setOverrides(EMERGENCY_PRESETS['shed-sheddable']); // sheddable closed
c.setOverrides(EMERGENCY_PRESETS['shed-normal']);    // normal and sheddable closed
c.setOverrides(EMERGENCY_PRESETS['critical-only']);  // only critical admitted
c.setOverrides(EMERGENCY_PRESETS['restore-all']);    // back to adaptive only
```

Closed bands are shed with reason `band_closed`. Wire these calls to your own authenticated admin endpoint, a feature-flag change listener or a signal handler; CHAKRA deliberately ships no control server.

**CHAKRA itself is suspected.** Set `CHAKRA_MODE=off` and restart. CHAKRA becomes a pass-through with no limiter work and no metrics. `CHAKRA_MODE=dry-run` keeps metrics while admitting everything.

## Reading the dashboard

- **Limit vs in-flight.** In-flight well below the limit means headroom. In-flight pinned at the limit with shedding means the process is saturated.
- **Concurrency limit falling.** Latency or event-loop delay rose. The limiter backs off within one sampling window (25 ms to 1 s).
- **Event-loop lag high, latency normal.** CPU-bound work is blocking the loop. The limiter shrinks on lag above `maxEventLoopDelayMs` even before latency shows it.
- **Shed latency.** Time to answer a shed request. It should be tens of microseconds; a shed request never reaches your handler.

## FAQ

**Does CHAKRA replace rate limiting?**
No. A rate limiter caps what each client may send, which stops abuse. CHAKRA caps what the process can currently handle and decides which requests get that capacity. Use both.

**Does it replace autoscaling?**
No. Autoscaling adds capacity over minutes. CHAKRA protects critical traffic during those minutes, and during problems scaling cannot fix (a slow database, a retry storm, a bad deploy).

**Why per process, not cluster-wide?**
Overload is local: each process has its own event loop and its own queue. A per-process limiter reacts in milliseconds with no network calls, no shared state and no new failure mode. Your load balancer already spreads traffic across processes.

**What does it cost per request?**
A route lookup, a few comparisons and one small allocation for admitted requests. See [bench/RESULTS.md](../bench/RESULTS.md) for measured overhead through Express and Fastify.

**Can priority come from a header or API key?**
Not from anything the client can set freely. Resolve the user in your authentication layer, attach it to `req.user`, and read `ctx.user` in the `priority` function. An API key you have verified and mapped to an account is fine; a raw `X-Tier` header is not.

**What happens if CHAKRA has a bug?**
Options are validated at startup; after that, `decide()`, the adapters, the limiter and metrics sinks catch their own errors. On any internal failure the request is admitted and a warning is logged once.

**Does it store user data?**
No. CHAKRA keeps counters and timings in memory. Metric labels are route patterns, bands and decisions, never paths, user identifiers or bodies. Nothing is written to disk.

**Does it open a port?**
No. You mount `c.metricsHandler` on your own server if you want metrics.

**Streaming responses and WebSockets?**
A request holds its slot until the response finishes or the connection closes. Long-lived streams therefore count as in flight for their whole life; give them their own priority, or exclude them by mounting CHAKRA only on the routers that need it.

**Cluster mode / PM2 / Kubernetes?**
Each worker or pod runs its own limiter and exports its own metrics. Aggregate across instances in Prometheus (`sum by (band)`), as the dashboard does.

**How do I test my handlers' degraded path?**
Call the handler with `req.chakra = { degraded: true, ... }` in a unit test, or run `npx chakra demo`-style load against a staging instance and watch the `degraded` decision count.

**Where is the v0.1 dashboard and Shadow Mode?**
Removed in 0.2.0. See [ADR 0001](adr/0001-adaptive-admission-control.md) for why; the old design documents are archived in [docs/archive/v0](archive/v0).
