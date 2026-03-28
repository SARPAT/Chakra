# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

CHAKRA is a Node.js middleware package that sits in front of any Express/Fastify application and intelligently manages graceful degradation during traffic surges. Instead of letting an app crash or serve everyone poorly under load, CHAKRA routes each incoming HTTP request to the right "version" of the application based on current system stress and request priority.

The core physics analogy: imagine a spinning disc (chakra) with concentric rings around a center core. The faster it spins (higher load), the further outward objects fly. HTTP requests are "thrown" outward based on load — landing on outer rings (reduced functionality) under stress, and staying close to the core (full functionality) when load is normal. Heavy requests (payment, checkout) have mass that resists being thrown outward and always land close to the core.

CHAKRA is NOT a replacement for Kubernetes, AWS, or any scaling infrastructure. It activates only when existing infrastructure scaling cannot keep up — bridging the gap between "K8s is trying to scale" and "new nodes are actually ready." It owns the graceful failing stage.

## Tech Stack

- **Language**: Node.js (TypeScript, strict mode, ES2022 target, CommonJS output)
- **Primary target**: Express.js middleware (Fastify support later)
- **Package manager**: npm
- **Testing**: Vitest (globals enabled, node environment)
- **Config format**: YAML (chakra.config.yaml)

## Commands

```bash
npm run build                                    # TypeScript compile (tsc)
npm test                                         # Run all Vitest tests
npm run test:watch                               # Run Vitest in watch mode
npx vitest run tests/unit/rpm-engine.test.ts     # Run a single test file
npm run lint                                     # ESLint check
npm run dev                                      # Start in watch mode (tsx)
```

## Architecture

**Data flow**: RPM Engine produces load score → Dispatcher reads it + Ring Map + Block States → calls Weight Engine for suspended blocks → Policy Engine for rule overrides → returns SERVE_FULLY / SERVE_LIMITED / SUSPEND.

**Hot path vs background**: The Dispatcher (`src/core/dispatcher.ts`) is the only code that runs on every request. Everything else (RPM Engine, Shadow Mode, Session Cache) runs in background intervals and communicates via immutable snapshots that the Dispatcher reads.

**Shared interfaces** are defined in `src/types.ts` — SessionContext, RouteInfo, DispatchOutcome, RPMState, BlockState. These are shared across all components and must be locked before implementation.

**Checkpoint docs** in `docs/` contain the complete design rationale, edge cases, and implementation decisions for each component. Always read the relevant checkpoint doc before building a component.

## Project Folder Structure

```
chakra-middleware/
├── src/
│   ├── index.ts                    # Entry point, public API
│   ├── types.ts                    # ALL shared interfaces — lock first
│   ├── core/
│   │   ├── dispatcher.ts           # Hot path — build third
│   │   ├── weight-engine.ts        # Request scoring — build fourth
│   │   ├── ring-mapper.ts          # Route lookup — build second
│   │   ├── policy-engine.ts        # Rule evaluator — build after core
│   │   └── activation.ts           # Manual/Auto mode control
│   ├── background/
│   │   ├── rpm-engine.ts           # Load signal — build first
│   │   ├── session-cache.ts        # In-memory session store
│   │   └── shadow-mode/
│   │       ├── observer.ts         # Request observation
│   │       ├── analyser.ts         # Pattern analysis jobs
│   │       └── suggester.ts        # Ring Map + policy suggestions
│   ├── integrations/
│   │   ├── express.ts              # Express adapter
│   │   ├── adapter-interface.ts    # Base interface for all adapters
│   │   └── container-bridge/
│   │       ├── kubernetes.ts
│   │       ├── prometheus.ts
│   │       └── webhook.ts
│   ├── dashboard/
│   │   ├── server.ts               # Express server for dashboard
│   │   └── api.ts                  # REST + WebSocket API
│   ├── config/
│   │   ├── loader.ts               # YAML config reader + validator
│   │   └── defaults.ts             # All default values
│   └── utils/
│       ├── hasher.ts               # SHA-256 hashing for PII
│       └── logger.ts               # Structured logging
├── tests/
│   ├── unit/
│   └── integration/
├── docs/
│   ├── CHAKRA_CP0_Foundation.md
│   ├── CHAKRA_CP1_ShadowMode.md
│   ├── CHAKRA_CP2_RPMEngine.md
│   ├── CHAKRA_CP2.5_ActivationModes.md
│   ├── CHAKRA_CP3_RingMapper.md
│   ├── CHAKRA_CP4_Dispatcher.md
│   ├── CHAKRA_CP5_WeightEngine.md
│   ├── CHAKRA_CP6_Middleware.md
│   ├── CHAKRA_CP7_PolicyEngine.md
│   ├── CHAKRA_CP8_Dashboard.md
│   └── CHAKRA_CP9_ContainerBridge.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── CLAUDE.md
```

## The Five Core Components (Build In This Order)

### 1. RPM Engine (`src/background/rpm-engine.ts`)
Produces a single 0–100 score representing current system load. Called "RPM" from the physics analogy. Combines three signals: Request Arrival Rate (30%), Response Latency P95 (40%), Error Rate Delta (30%). Updates every 5 seconds with smoothing across 3 readings. Also produces per-block RPM. All baselines come from Shadow Mode. Uses conservative defaults during cold start.

### 2. Shadow Mode Observer (`src/background/shadow-mode/`)
The silent student. Runs from the moment CHAKRA is installed. Observes all requests asynchronously — never touches the request path. Captures: endpoint, method, response time, status code, hashed session ID, hashed user ID, session depth, cart state signals. Stores observations in a rolling 30-day SQLite store. Runs analysis jobs hourly/daily to produce: suggested Ring Map, suggested RPM thresholds, Moment of Value signatures, policy suggestions. Learns in 4 layers: App Structure (hours), Traffic Patterns (days), User Behaviour (weeks), Failure Signatures (requires a stress event). Never auto-activates anything — suggests only.

### 3. Ring Mapper (`src/core/ring-mapper.ts`)
Maintains the app's endpoint-to-block mapping. Developer annotates routes with `chakra.block('block-name')`. Ring Mapper compiles these annotations into a flat O(1) lookup table at startup: `METHOD:PATH → { block, minLevel, weightBase }`. Also holds the Level Map (which blocks are active/suspended at each level 0–3). Handles unmatched endpoints via default-block (never degrades unmapped routes). Supports live updates and version history. Shadow Mode suggestions feed into this as the initial Ring Map.

### 4. Dispatcher (`src/core/dispatcher.ts`)
The hot path. Runs on every single request. Budget: under 2ms total. When CHAKRA is sleeping: single boolean check, pure pass-through, under 0.1ms added latency. When active: looks up request in Ring Map → checks block state → if suspended, runs Weight Engine → runs Policy Engine → returns one of three outcomes: SERVE_FULLY (pass to backend), SERVE_LIMITED (pass with X-Chakra-* headers), or SUSPEND (return fallback directly, backend never sees it). Never writes any state — read-only hot path. Uses immutable snapshot pattern for concurrency safety.

### 5. Weight Engine (`src/core/weight-engine.ts`)
Called by Dispatcher when a request hits a suspended block. Calculates a 0–100 weight score using 8 additive signals: Block Base Weight, HTTP Method (+15 for writes), Authentication (+10), Session Depth (+0 to +20), Cart Items (+0 to +30), Moment of Value Signature (+0 to +30), User Tier (+0 to +50), Developer Override. Score determines outcome: ≥65 → SERVE_FULLY, 40–64 → SERVE_LIMITED, <40 → SUSPEND. Pure function — same inputs always give same output. Reads session context from in-memory cache written by Shadow Mode.

## Additional Components (Build After Core)

### Policy Engine (`src/core/policy-engine.ts`)
Developer-written rules evaluated in Step 6 of Dispatcher. Format: IF [conditions] THEN [action] with priority number. Conditions: user_tier, session_depth, cart_items, moment_of_value, block, rpm_above, time_between, etc. Actions: serve_fully, serve_limited (with hint), suspend, redirect, rate_limit. Pre-compiled at startup into sorted predicate array. Evaluates in <0.5ms for up to 50 rules. Live-editable without restart via atomic pointer swap. Shadow Mode generates policy suggestions. Emergency presets are one-click rule sets for war room use.

### Middleware Package (`src/index.ts`)
The developer-facing shell. Single entry point: `const chakra = require('chakra-middleware')`. Developer adds two lines to their app: initialize + mount as middleware. Block annotations: `chakra.block('payment-block')` per route. Starts all background components at boot. If any component fails: CHAKRA disables that component silently, app continues. CHAKRA must NEVER crash the developer's app. Console output on startup shows clear status. Dashboard starts automatically on port 4242.

### Activation Modes (`src/core/activation.ts`)
Two modes: MANUAL (ops team clicks Activate in dashboard) and AUTO (CHAKRA watches RPM and activates based on developer-configured strategy). Strategy config: rpm_threshold, sustained_seconds, error_rate triggers, deactivation conditions, restore_sequence (gradual or immediate). Sleep process is gradual by default — restore one level at a time, wait 30s between steps. Full audit log of every activation/deactivation with timestamp, reason, RPM at the time. CHAKRA never auto-activates policies — always needs human approval.

### Dashboard (`src/dashboard/`)
Web UI served on port 4242. Five screens: Overview (live RPM chart, block states, activate/sleep button), Ring Map (visual ring diagram, block details), Policies (active rules, Shadow Mode suggestions, policy editor, emergency presets), Learning (Shadow Mode progress per layer, ready-for-review suggestions), History (activation log, auto-generated incident reports). Real-time via WebSocket during active incidents. Settings screen for all config. Incident report auto-generated on every deactivation.

### Container Bridge (`src/integrations/`)
Optional. Reads infrastructure signals to make Auto Mode more precise. Four adapters: Kubernetes (reads K8s API — HPA status, pod states), ECS (AWS DescribeServices), Prometheus (generic — reads any Prometheus endpoint), Webhook (POST endpoint for custom infra). Fallback chain: configured adapter → webhook signal → RPM-only. All adapters answer three questions: scaling in progress? estimated seconds? at capacity limit? CHAKRA never manages infra — only reads it.

## Key Data Interfaces (Lock These First — `src/types.ts`)

These are shared between components. Define and lock before building any component:

```typescript
// Session context — Shadow Mode writes, Dispatcher reads
interface SessionContext {
  callCount: number;
  hasCartItems: boolean;
  cartItemCount: number;
  matchesMomentOfValue: boolean;
  momentOfValueStrength: 'none' | 'partial' | 'full';
  recentEndpoints: string[];
  userTier: string | null;
  sessionAgeSeconds: number;
  lastSeenTime: number;
}

// Ring Map lookup result — Ring Mapper produces, Dispatcher reads
interface RouteInfo {
  block: string;
  minLevel: number;      // 0 = never suspend, 3 = first to go
  weightBase: number;    // 0-100, developer-set importance
}

// Dispatcher outcome
type DispatchOutcome =
  | { type: 'SERVE_FULLY' }
  | { type: 'SERVE_LIMITED'; hint: string }
  | { type: 'SUSPEND'; response: SuspendedResponse };

// RPM state — RPM Engine writes, Dispatcher reads
interface RPMState {
  global: number;           // 0-100
  perBlock: Record<string, number>;
  updatedAt: number;
  phase: 1 | 2 | 3;        // cold start phase (1=conservative, 2=partial, 3=calibrated)
}

// Block state — determines current active level per block
interface BlockState {
  block: string;
  currentLevel: number;
  isActive: boolean;
  isSuspended: boolean;
}
```

## Critical Rules for All Agents

1. **CHAKRA never crashes the developer's app.** If any component fails at startup or runtime, disable that component silently and continue. Never throw uncaught exceptions from middleware.

2. **Dispatcher is read-only.** The hot path never writes state. All writes happen in background processes via atomic pointer swaps.

3. **Privacy is non-negotiable.** All user IDs and session tokens are SHA-256 hashed before storage. Never store request/response bodies. Behaviour patterns only, never PII.

4. **Build in sequence.** RPM Engine → Ring Mapper → Dispatcher → Weight Engine → Policy Engine → Middleware wrapper → Activation → Dashboard → Container Bridge. Each component depends on the previous ones' interfaces being stable.

5. **Lock interfaces before implementing.** Create `src/types.ts` first. The data structures above must be finalised before building any component. Multiple components share them.

6. **Full checkpoint specs live in `docs/`.** Before building any component, read its corresponding checkpoint file in `docs/`. It contains the complete design rationale, edge cases, and implementation decisions already made.

7. **Subagents: one component per task.** When delegating to subagents, give each subagent exactly one component to build. Feed it this file plus its specific checkpoint doc. Tell it explicitly what interfaces already exist and what files it should NOT touch.
## GLobal Instructions
-   EVERY NEW LINE OF CODE WRITTEN,UPDATED,OR REMOVED MUST BE FOLLOWED BY COMMIT (without explicitely mentioning by user).

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

