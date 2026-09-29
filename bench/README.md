# Benchmarks

```bash
npm run bench                                   # build, install bench deps, run all three, write RESULTS.md
BENCH_ONLY=overload npm run bench               # just one part
node --expose-gc --min-semi-space-size=64 bench/micro.js   # after `npm run build` and `npm --prefix bench ci`
node bench/overhead.js
node bench/overload.js
```

Latest numbers: [RESULTS.md](RESULTS.md) (raw data in `results.json`). The
[Benchmark workflow](../.github/workflows/bench.yml) runs the same thing on demand
(Actions → Benchmark → Run workflow) and posts the tables to the job summary.
Bench dependencies are pinned in `bench/package.json` and kept out of the library's own.

## What is measured

**Admission path** (`micro.js`). `chakra().decide()` plus `done()` in a tight loop over
four routes, and the limiter's `acquire()` + `release()` on their own. Median and best of
7 runs, nanoseconds and heap bytes per request. Decisions are kept alive in a ring buffer
so V8 cannot optimise the allocations away, as it could not in a real adapter.

**Middleware overhead** (`overhead.js`). The same one-route app (`GET /hello`, small JSON)
on Express and Fastify, with and without CHAKRA, driven by autocannon (50 connections,
10 s after a 3 s warm-up). Load is far below the limiter's threshold so every request is
admitted and only CHAKRA's per-request cost shows. Variants run interleaved over 3
rounds; the median round is reported.

**Overload** (`overload.js`). A demo shop whose capacity is set by a simulated database:
8 connections × 10 ms per query, FIFO queue when busy, plus 100 µs of CPU per request.
Checkout is `critical` (1 query), browse `normal` (1 query), recommendations `sheddable`
(2 queries, 1 when `req.chakra.degraded`). An open-loop generator sends a fixed
deterministic sequence (10% checkout, 40% browse, 50% recommendations) at 300 req/s,
spikes to 1500 req/s for 20 s, then drops back. Requests slower than 2 s count as
failures. Three servers get the same traffic:

- **none**: the app as is.
- **fixed cap**: a hand-tuned concurrency cap (16 in flight, twice the pool) that answers 503 above it, whatever the route.
- **CHAKRA**: default options plus the three route priorities.

Reported for requests sent during the spike: success rate and p50/p99 latency per
priority, goodput (2xx per second), time from spike start to the first 503 (how fast
protection reacts), and time until critical traffic is healthy (from that point to the end
of the spike, critical requests together have ≥ 99% success and p99 ≤ 250 ms; "never" if
no such point exists).

## Keeping it honest

- Server and load generator are separate processes; with `taskset` available the server is pinned to CPU 0 and the generator to the other cores.
- Open-loop load avoids coordinated omission: a slow server does not slow the client down.
- Every mode sees the same request sequence.
- All knobs are environment variables (`BENCH_DURATION`, `BENCH_ROUNDS`, `BENCH_CONNECTIONS`, `BENCH_SPIKE_RPS`, `BENCH_BASE_RPS`, `BENCH_SPIKE_SECONDS`, `BENCH_POOL`, `BENCH_SERVICE_MS`, `BENCH_CPU_US`, `BENCH_CAP`, `BENCH_SLO_MS`, `BENCH_FRAMEWORK`, `BENCH_MODES`, `BENCH_CHAKRA_OPTIONS`), and RESULTS.md records machine, versions and commit.
- Shared CI runners are noisy: compare runs on the same machine, not across machines.
