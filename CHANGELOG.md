# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-29

A ground-up rebuild. CHAKRA is now priority-aware adaptive load shedding for Node.js. See [ADR 0001](docs/adr/0001-adaptive-admission-control.md) for the design and the reasons for the change.

### Added

- Adaptive concurrency limiter (Gradient2 by default, AIMD optional) driven by request latency and event-loop delay, reacting within milliseconds.
- Four declared priority bands (`critical`, `high`, `normal`, `sheddable`) with per-band shares of the current limit, so lower bands are shed first.
- Route priorities through `routes` in options, `route()` tags in Express and `config.chakra` in Fastify, with `:param` and trailing `*` patterns.
- Per-request `priority(ctx)` resolver using the authenticated user.
- Degrade mode: `req.chakra.degraded` on admitted requests near their band's limit.
- Configurable shed response (`503` with `Retry-After` by default) and per-route fallbacks.
- Dry-run mode (`CHAKRA_MODE=dry-run`) with per-route would-shed reporting, and `off` mode for a pure pass-through.
- Band overrides (`setOverrides`) and `EMERGENCY_PRESETS` for incident response.
- Dependency-free Prometheus exporter, OpenTelemetry-compatible event sink and a Grafana dashboard.
- Express and Fastify adapters.
- `npx chakra init` to scaffold route priorities and `npx chakra demo` to watch CHAKRA under overload.
- Adapter overhead benchmarks.

### Removed

- The v0.1 design: RPM Engine, activation levels, Shadow Mode and its SQLite store, Weight Engine, Ring Mapper, Policy Engine, the built-in dashboard server and the Container Bridge. Their design documents are archived in `docs/archive/v0/`.
- The `better-sqlite3` native dependency. CHAKRA now has no runtime dependencies.
- Priority derived from client-controlled headers such as `X-User-Tier`.

[1.0.0]: https://github.com/SARPAT/Chakra/releases/tag/v1.0.0
