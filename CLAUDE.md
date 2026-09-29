# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

CHAKRA is **priority-aware adaptive load shedding for Node.js**. It is a small library that sits in front of an Express or Fastify app and, when the process runs short of capacity, sheds the least important requests first so the important ones (checkout, payment, login) keep working.

- **Always on, invisible until needed.** An adaptive concurrency limiter adjusts continuously from request latency and event-loop delay. There is no "activate" step.
- **Declared priority.** Developers tag routes `critical`, `high`, `normal` or `sheddable`. A per-request resolver can use the authenticated user (`req.user`). Priority never comes from client-controlled headers.
- **Degrade before shedding.** Admitted requests near their band's limit get `req.chakra.degraded = true` so handlers can return a lighter response.
- **Dry-run** (`CHAKRA_MODE=dry-run`) admits everything and reports what would have been shed.
- **Metrics out.** Prometheus metrics and a Grafana dashboard; no built-in UI, no listening ports by default.
- **Per-process, no native deps, no PII stored.**

CHAKRA does not replace autoscaling. It protects critical traffic whenever capacity is short: surges, slow dependencies, bad deploys, retry storms, bot floods.

The design decision and its rationale: `docs/adr/0001-adaptive-admission-control.md`. The v0.1 design (RPM Engine, Shadow Mode, Weight Engine, dashboard, Container Bridge) is archived in `docs/archive/v0/` and must not be reintroduced without a new ADR.

## Tech Stack

- **Language**: TypeScript (strict, ES2022 target, CommonJS output), Node.js ≥ 18
- **Frameworks**: Express (first), Fastify
- **Package manager**: npm
- **Testing**: Vitest (globals enabled, node environment)
- **Runtime dependencies**: none native. Keep the dependency list minimal.

## Commands

```bash
npm run build                                    # TypeScript compile (tsc)
npm test                                         # Run all Vitest tests
npm run test:watch                               # Vitest watch mode
npx vitest run tests/unit/admission.test.ts      # Run a single test file
npm run lint                                     # ESLint
```

## Architecture

**Request flow:** adapter builds a `RequestContext` → `core.decide(ctx)` resolves priority (`options.priority(ctx)` → route rule → `defaultPriority`) → checks band overrides → `limiter.acquire(priority)` → returns **admit** (with `req.chakra` info and a `done()` callback) or **shed** (a ready-to-write response). Dry-run converts every shed into an admit with `wouldShed: true`. Events go to a `ChakraEventSink` (Prometheus exporter by default).

**Hot path vs background:** `decide()`, `acquire()` and `release()` run on every request and must stay allocation-light and fast (target: < 5 µs for the limiter, well under 50 µs end to end). Only the limiter's event-loop sampler runs in the background, on `unref()`'d timers.

**Shared contracts** live in `src/types.ts`: `Priority`, `RequestContext`, `RouteRule`, `PriorityResolver`, `RouteTable`, `Limiter`, `AcquireResult`, `LimiterToken`, `LimiterSnapshot`, `Decision`, `ChakraRequestInfo`, `AdmissionCore`, `ChakraEvent`, `ChakraEventSink`, `MetricsExporter`. Change them only through an ADR amendment.

## Folder Structure

```
src/
├── index.ts               public API: chakra(options)
├── types.ts               shared contracts (ADR 0001)
├── config/schema.ts       ChakraOptions, validation, CHAKRA_MODE
├── core/admission.ts      framework-free decide(), band overrides
├── limiter/               adaptive concurrency limiter (Gradient2 / AIMD, priority bands, event-loop sampler)
├── priority/              route table, route() tagging, emergency presets
├── adapters/express.ts    Express adapter
├── adapters/fastify.ts    Fastify adapter
├── observability/         Prometheus exporter, metric names, dry-run report
└── utils/logger.ts        console logger, log-once helper
grafana/                   Grafana dashboard JSON
tests/unit/                unit tests per module
tests/integration/         black-box tests against real Express/Fastify apps
docs/adr/                  architecture decision records
docs/archive/v0/           superseded v0.1 design docs
```

## Public API

```ts
import { chakra } from 'chakra-middleware';

const c = chakra({
  routes: { 'POST /checkout': 'critical', 'GET /recommendations': 'sheddable' },
  priority: (ctx) => ((ctx.user as { plan?: string })?.plan === 'enterprise' ? 'high' : undefined),
});
app.use(c);                               // Express
app.get('/metrics', c.metricsHandler);    // Prometheus scrape endpoint
c.setOverrides({ closedBands: ['sheddable'] }); // manual lever during incidents
```

Options are validated when `chakra()` is called; invalid options throw `ChakraConfigError` listing every problem. Unknown keys are errors.

## Critical Rules for All Agents

1. **CHAKRA never crashes the host app.** After construction, nothing may throw into the request path. `decide()`, adapters, the limiter and sinks catch their own errors; on internal failure the request is admitted.
2. **Priority is declared, never inferred from client input.** Do not read tiers, sessions or user identity from request headers.
3. **No PII.** Never store or log user identifiers, request bodies or raw paths. Metric `route` labels are route patterns (`RouteRule.key`) or `<unmatched>`, capped in number.
4. **No native dependencies and no listening ports by default.** Anything that opens a port or adds a dependency needs an ADR.
5. **Tests check behaviour, not only internals.** Every feature needs a test that exercises it through the public API or a real framework app (for example: under overload a `sheddable` route returns 503 while a `critical` route succeeds).
6. **Lean and fast.** Production grade means the fewest lines that do the job and measured hot-path cost. Stay pure TypeScript with no native dependencies (the one-command install depends on it). Keep per-request work to microseconds with zero allocations where practical, and prove it: any hot-path change comes with a benchmark result, and regressions fail CI. Delete code rather than add options.
7. **Module ownership.** `src/index.ts`, `src/types.ts`, `src/config/`, `src/core/` and this file belong to the foundation work; other modules consume their contracts. Propose contract changes as ADR amendments.
8. **Subagents: one module per task.** Give each subagent this file, ADR 0001 and the module's contract, and say which files it must not touch.

## Global Instructions
- EVERY NEW LINE OF CODE WRITTEN,UPDATED,OR REMOVED MUST BE FOLLOWED BY COMMIT (without explicitely mentioning by user).

### Git

- Always use the repository’s local Git identity (`user.name` and `user.email`) for commits.
- Never run `git config` to set or modify identity (local or global).
- If local identity is not configured, do not commit and notify the user.

### Git Commits

- Never add `Co-authored-by: Claude` or any similar AI attribution.
- Commit messages must appear as fully authored by me.
- Maintain a professional, developer-oriented tone in all commit messages.

### Pull Requests

- PR titles and descriptions must be written as if authored by me.
- Do not mention “Generated by Claude” or “AI-assisted” in any PR content.

### Commit Strategy

- **Commit after every individual code change** — a single new function, a single new type, a single new method, a single bug fix, a single test block. Do not batch multiple additions into one commit.
- **One logical unit per commit.** If adding a class with 3 methods, commit after each method is added. If writing tests, commit after each describe block. If fixing a bug and adding a test for it, that is two separate commits.
- **Commit immediately** — do not write 20 lines then commit. Write a small piece, commit, write the next piece, commit.
- Each commit message must describe exactly what was added or changed — not "add file" but "add calculateWeight() signal for HTTP method scoring".
- Never batch unrelated changes. A type definition change and a function implementation change are two separate commits even if they are in the same file.
- Avoid empty or redundant commits with no meaningful changes.
