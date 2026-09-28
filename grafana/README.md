# CHAKRA Grafana dashboard

`chakra-dashboard.json` is built on the metrics from `createPrometheusExporter()`
(names in `src/observability/metric-names.ts`).

## Import

Grafana → Dashboards → New → Import → upload `chakra-dashboard.json` → pick your Prometheus
datasource. Filters at the top: job, instance, route, band.

## Rows

- **Overview**: shed ratio (enforce mode only), request rate, limit vs in-flight, instances in dry-run.
- **Admission**: requests by decision; shed, degraded and shed ratio per band.
- **Capacity**: in-flight vs concurrency limit per instance, and limit utilisation.
- **Latency**: event-loop lag, and shed latency p50/p99 per band.
- **Routes**: top 10 routes by shed rate.
- **Dry-run**: what would have been shed or degraded (`dry_run="true"`), per band and route.

## Example alerts

```promql
# Critical traffic is being shed
sum(rate(chakra_requests_total{band="critical",decision="shed",dry_run="false"}[5m]))
  / sum(rate(chakra_requests_total{band="critical",dry_run="false"}[5m])) > 0.01

# Running at the concurrency limit for a sustained period
avg_over_time((chakra_inflight_requests / chakra_concurrency_limit)[10m:]) > 0.95
```
