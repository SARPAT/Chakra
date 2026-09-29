# Production rollout

Roll CHAKRA out the way you would any traffic-control change: observe first, enforce second, alert on what matters.

## Stage 1: dry-run

Deploy with priorities declared and the mode set to dry-run:

```bash
CHAKRA_MODE=dry-run
```

In dry-run CHAKRA runs the real limiter and makes real decisions, but admits every request. For each request it would have shed:

- `req.chakra.wouldShed` is `true` (handlers can log or tag it),
- `chakra_requests_total{decision="shed",dry_run="true"}` is incremented,
- a rate-limited JSON summary line is logged (at most 10 lines per 10 seconds),
- `c.dryRunReport()` returns totals and the routes that would have been shed most.

Run it through at least one real traffic peak, ideally a load test too. Then check:

1. **Would-be sheds happen only under real pressure.** In normal traffic `decision="shed"` should be zero or close to it. If it is not, the limit is too tight: raise `limiter.minLimit` or `limiter.initialLimit`, or check whether the process really is saturated (event-loop lag, slow dependencies).
2. **The right routes would be shed.** The per-route breakdown should be dominated by `sheddable` and `normal`. A `critical` or `high` route near the top means a missing or wrong priority.
3. **`<unmatched>` is small.** A large `<unmatched>` share means routes you care about are falling back to `defaultPriority`.

Useful queries:

```promql
# Would-be shed ratio per band
sum by (band) (rate(chakra_requests_total{decision="shed",dry_run="true"}[5m]))
  / sum by (band) (rate(chakra_requests_total{dry_run="true"}[5m]))

# Routes that would be shed most
topk(10, sum by (route, band) (rate(chakra_requests_total{decision="shed",dry_run="true"}[1h])))
```

## Stage 2: enforce

Remove `CHAKRA_MODE` (or set it to `enforce`) and deploy. Roll out to one instance or one region first and compare its error rate and p99 latency with the rest of the fleet during a peak.

If anything looks wrong, set `CHAKRA_MODE=off` and restart: CHAKRA becomes a pure pass-through without a code change.

## Alerts

Start with these three. They are also in the Grafana dashboard.

```promql
# Critical traffic is being shed: page someone
sum(rate(chakra_requests_total{band="critical",decision="shed",dry_run="false"}[5m]))
  / sum(rate(chakra_requests_total{band="critical",dry_run="false"}[5m])) > 0.01

# Sustained shedding of any band: capacity is short, scale or investigate
sum(rate(chakra_requests_total{decision="shed",dry_run="false"}[10m]))
  / sum(rate(chakra_requests_total{dry_run="false"}[10m])) > 0.05

# Running at the concurrency limit for a long time
avg_over_time((chakra_inflight_requests / chakra_concurrency_limit)[10m:]) > 0.95
```

Shedding `sheddable` traffic briefly during a spike is CHAKRA doing its job and is usually not worth a page. Shedding `critical` is.

Feed `chakra_concurrency_limit` utilisation or the shed ratio into your autoscaler as an extra signal if it supports custom metrics: it reacts to real saturation rather than CPU alone.

## Tuning

The defaults work for most HTTP APIs. Change one thing at a time and watch the dashboard.

| Symptom                                                    | Try                                                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Sheds at normal traffic, latency looks fine                | Raise `limiter.minLimit` to the concurrency you know is safe.                       |
| Latency climbs a lot before any shedding starts            | Lower `limiter.maxLimit`, or lower `maxEventLoopDelayMs` (e.g. 50).                 |
| Limit oscillates on a very spiky or low-traffic service    | Switch `limiter.algorithm` to `'aimd'`.                                             |
| `sheddable` is refused too early / too late                | Adjust `bandShares.sheddable` (default 0.5).                                        |
| Handlers rarely see `degraded` before sheds begin          | Lower `degradeAt` (e.g. 0.6) so degradation starts earlier.                         |
| CPU-heavy handlers block the loop                          | Keep `maxEventLoopDelayMs` low; the event-loop signal catches this before latency does. |

## Deployment notes

- **Per process.** Each Node.js process (and each cluster worker) runs its own limiter. That is intended: every process protects its own event loop. Overrides set with `setOverrides()` also apply per process; push them through configuration or a feature-flag service to change the whole fleet.
- **Health checks.** Mark liveness and readiness routes `critical` so an overloaded instance is not killed for being busy.
- **Load balancers and retries.** Shed responses are `503` with `Retry-After`. Make sure your load balancer does not treat a burst of 503s as instance failure, and that clients back off rather than retrying immediately.
- **Metrics endpoint.** `c.metricsHandler` is mounted on your own server, at a path you choose. Restrict who can reach it as you would any internal endpoint.
- **Shutdown.** Call `c.close()` on shutdown to stop background timers (they are `unref()`'d, so they never keep the process alive on their own).
