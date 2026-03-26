# PROJECT CHAKRA
## Checkpoint 6 — Middleware Package (The Front Door)
### Status: DISCUSSION COMPLETE → READY TO BUILD
### Position in Build Order: SIXTH
### Depends on: CP1, CP2, CP2.5, CP3, CP4, CP5

---

## What The Middleware Package Is

The Middleware Package is the developer-facing shell that wraps
all of CHAKRA's internal components into a single installable,
configurable package.

It is what the developer:
- Installs with one command
- Wires into their existing app with 2–3 lines of code
- Configures via a single YAML file
- Never needs to understand the internals of to use correctly

Everything — Shadow Mode, RPM Engine, Activation Modes, Ring Mapper,
Dispatcher, Weight Engine — lives inside this package.
The developer never touches any of it directly.

---

## 1. THE INSTALL EXPERIENCE — THE NON-NEGOTIABLE CONSTRAINT

> From install to CHAKRA running in production:
> under 10 minutes for any experienced developer.

If it takes longer, adoption fails.
The onboarding experience IS the product for the first 30 minutes.

```
Step 1:  Install package                       (~30 seconds)
         npm install chakra-middleware
         pip install chakra-middleware
         (Maven: add dependency to pom.xml)

Step 2:  Create chakra.config.yaml             (~2 minutes)
         Minimum: 2 lines. mode: "manual"

Step 3:  Add 2 lines to app entry point        (~1 minute)
         Initialize + mount as middleware

Step 4:  Add block annotations to routes       (~5 minutes)
         One line per route

Step 5:  Start app                             (done)
         CHAKRA sleeping. Shadow Mode learning.
         Dashboard open at localhost:4242.

Total: under 10 minutes.
Developer goes back to their normal work.
CHAKRA learns in the background.
```

---

## 2. FRAMEWORK INTEGRATION

### Node.js — Express
```javascript
const express = require('express');
const { chakra } = require('chakra-middleware');

const app = express();

// Line 1: Initialize
const chakraInstance = chakra('./chakra.config.yaml');

// Line 2: Mount before all routes
app.use(chakraInstance.middleware());

// Existing routes — add one annotation each
app.post('/api/payment/process',
  chakraInstance.block('payment-block'),
  processPayment);

app.get('/api/products',
  chakraInstance.block('browse-block'),
  getProducts);

app.get('/api/recommendations',
  chakraInstance.block('recommendations-block'),
  getRecommendations);
```

---

### Node.js — Fastify
```javascript
const fastify = require('fastify')();
const { chakra } = require('chakra-middleware');

const chakraInstance = chakra('./chakra.config.yaml');

await fastify.register(chakraInstance.fastifyPlugin());

fastify.post('/api/payment/process',
  { preHandler: chakraInstance.block('payment-block') },
  processPayment);
```

---

### Python — FastAPI
```python
from fastapi import FastAPI
from chakra_middleware import Chakra, block

app = FastAPI()
chakra = Chakra('./chakra.config.yaml')
app.add_middleware(chakra.middleware())

@app.post("/api/payment/process")
@block("payment-block")
async def process_payment():
    pass

@app.get("/api/products")
@block("browse-block")
async def get_products():
    pass
```

---

### Python — Flask
```python
from flask import Flask
from chakra_middleware import Chakra

app = Flask(__name__)
chakra = Chakra('./chakra.config.yaml')
chakra.init_app(app)

@app.route('/api/products')
@chakra.block('browse-block')
def get_products():
    pass
```

---

### Python — Django
```python
# settings.py — add one line to MIDDLEWARE list

MIDDLEWARE = [
    'chakra_middleware.ChakraMiddleware',   # add this line
    'django.middleware.security.SecurityMiddleware',
    # ... existing middleware unchanged
]

CHAKRA_CONFIG = './chakra.config.yaml'

# views.py — annotate views
from chakra_middleware import block

@block('browse-block')
def get_products(request):
    pass
```

---

### Java — Spring Boot
```java
// application.properties
// chakra.config=./chakra.config.yaml
// chakra.enabled=true

// Controller
@RestController
public class ProductController {

    @GetMapping("/api/products")
    @ChakraBlock("browse-block")
    public ResponseEntity<?> getProducts() { ... }

    @PostMapping("/api/payment/process")
    @ChakraBlock("payment-block")
    public ResponseEntity<?> processPayment() { ... }
}
```

Pattern is identical across all frameworks:
1. Initialize with config path
2. Mount as middleware (one line)
3. Annotate routes with block assignments (one line each)

---

## 3. STARTUP SEQUENCE — WHAT RUNS AT BOOT

When developer starts their app with CHAKRA installed:

```
App starts
    ↓
CHAKRA initializes
    ↓
Step 1: Load + validate chakra.config.yaml
        Error? → Log clearly, CHAKRA disables itself,
                  app starts normally without CHAKRA.
                  NEVER crash the app.

Step 2: Compile Ring Map from annotations + config file
        → Build lookup table in memory
        → No annotations yet? Empty Ring Map.
          All requests pass through. Shadow Mode only.

Step 3: Start Shadow Mode Observer (background)
        → Begins collecting observations immediately
        → Async, never blocks app startup

Step 4: Start RPM Engine (background timer, 5s interval)
        → Begins calculating RPM from observed traffic
        → No baselines yet: conservative cold-start defaults (CP2)

Step 5: Start Activation State Monitor
        → Auto Mode: watches RPM against strategy thresholds
        → Manual Mode: waits for dashboard signal only

Step 6: Start Session Context Cache
        → Empty on startup. Fills as Shadow Mode observes.

Step 7: Start Dispatcher
        → CHAKRA sleeping by default on first start
        → Pure pass-through. Zero added latency.

Step 8: Start Dashboard server (port 4242 default)
        → Developer can open immediately
        → Shows Shadow Mode learning in real time

Step 9: Console output (see Section 7)
```

**Critical rule applied at every step:**
If any CHAKRA component fails to start →
CHAKRA disables that component and continues.
If Dispatcher fails → instant permanent pass-through.
App ALWAYS starts. CHAKRA NEVER crashes the app.

---

## 4. THE MINIMAL CONFIG

The smallest possible chakra.config.yaml:

```yaml
mode: "manual"
```

Two words. That is all that is required.

CHAKRA runs in Shadow Mode. Sleeps until developer activates
manually. All requests pass through. No risk whatsoever.
Zero changes to production behaviour.

Developer explores at their own pace from here.

---

## 5. THE FULL CONFIG REFERENCE

```yaml
# chakra.config.yaml — complete reference

# ─────────────────────────────────────────────
# REQUIRED
# ─────────────────────────────────────────────
mode: "auto"                  # "manual" or "auto"

# ─────────────────────────────────────────────
# SHADOW MODE
# ─────────────────────────────────────────────
shadow_mode:
  mode: "auto"                # "auto" (data-driven) or "manual"
  min_learning_days: 7
  force_activate_after_days: 30
  historical_log_import:
    enabled: false
    format: "nginx"           # nginx / apache / cloudwatch / json
    path: "./logs/access.log"

# ─────────────────────────────────────────────
# AUTO MODE — ACTIVATION
# ─────────────────────────────────────────────
activate_when:
  rpm_threshold: 72
  sustained_seconds: 90
  error_rate_above: 2.5
  latency_p95_above_ms: 800
  condition_logic: "rpm_AND_sustained OR error_rate OR latency"

# ─────────────────────────────────────────────
# AUTO MODE — DEACTIVATION
# ─────────────────────────────────────────────
deactivate_when:
  rpm_below: 55
  sustained_seconds: 60
  restore_sequence: "gradual"    # "gradual" or "immediate"
  restore_step_wait_seconds: 30

abort_sleep_if:
  rpm_climbs_above: 65
  action: "pause_restoration"

# ─────────────────────────────────────────────
# WEIGHT ENGINE
# ─────────────────────────────────────────────
weight_engine:
  serve_fully_threshold: 65
  serve_limited_threshold: 40
  user_tier:
    header: "X-User-Tier"
    tiers:
      standard: 0
      premium: 40
      enterprise: 50
  signal_tuning:
    cart_items_high: 25
    moment_of_value_full: 30
    premium_tier: 40

# ─────────────────────────────────────────────
# PROTECTION RULES
# ─────────────────────────────────────────────
always_protect:
  - /api/payment
  - /api/checkout
  - /api/auth

degrade_first:
  - /api/recommendations
  - /api/ads
  - /api/social-feed

user_overrides:
  premier_users:
    header: "X-User-Tier"
    value: "premium"
    treatment: always_level_0
  mid_checkout_sessions:
    detection: "moment_of_value_signature"
    treatment: always_level_0

# ─────────────────────────────────────────────
# RING MAP
# ─────────────────────────────────────────────
ring_mapper:
  source: "annotations"          # "annotations" / "file" / "shadow-mode"
  ring_map_file: "./chakra.ringmap.yaml"   # used if source is "file"
  unmatched_endpoint_handling: "default-block"

# ─────────────────────────────────────────────
# DASHBOARD
# ─────────────────────────────────────────────
dashboard:
  port: 4242
  enabled: true
  auth:
    type: "basic"
    username: "admin"
    password_env: "CHAKRA_DASHBOARD_PASSWORD"

# ─────────────────────────────────────────────
# RPM ENGINE OVERRIDES (optional)
# ─────────────────────────────────────────────
rpm_engine:
  update_interval_seconds: 5
  smoothing_window: 3
  signal_weights:
    request_arrival_rate: 0.30
    response_latency_p95: 0.40
    error_rate_delta: 0.30
```

---

## 6. ERROR HANDLING PHILOSOPHY

CHAKRA must never be the reason a developer's app fails. Ever.

```
RULE 1 — Config error on startup:
  Log clear, specific error message.
  CHAKRA disables itself entirely.
  App starts and runs normally without CHAKRA.
  Never throw an uncaught exception.

  Example output:
  [CHAKRA] ✗ Config error: activate_when.rpm_threshold must be
              between 0 and 100. Found: 150.
  [CHAKRA] CHAKRA disabled. App running without CHAKRA protection.

RULE 2 — Component failure at runtime:
  Log error with component name.
  That component disables itself.
  Other components continue.
  If Dispatcher fails → permanent pass-through.
  App performance unaffected.

RULE 3 — Dashboard failure:
  Log error.
  Dashboard unavailable.
  Core middleware continues unaffected.
  App performance not impacted.

RULE 4 — Config file disappears after startup:
  Use last known good config in memory.
  Log warning once.
  Continue with existing config.

RULE 5 — Ring Map annotation missing for an endpoint:
  Route to default-block (always active).
  Flag in dashboard.
  Never suspend an unmapped endpoint.

SUMMARY:
  CHAKRA degrades itself gracefully before
  ever degrading the developer's app.
```

---

## 7. CONSOLE OUTPUT ON STARTUP

```
[CHAKRA] ──────────────────────────────────────────
[CHAKRA]  Initializing CHAKRA v1.0.0
[CHAKRA] ──────────────────────────────────────────
[CHAKRA] ✓ Config loaded           chakra.config.yaml
[CHAKRA] ✓ Ring Map compiled       47 endpoints → 4 blocks
[CHAKRA] ✓ Shadow Mode started     collecting observations
[CHAKRA] ✓ RPM Engine started      cold start (no baseline yet)
[CHAKRA] ✓ Session Cache ready     capacity: 50,000 sessions
[CHAKRA] ✓ Dispatcher ready        status: SLEEPING
[CHAKRA] ✓ Dashboard running       http://localhost:4242
[CHAKRA] ──────────────────────────────────────────
[CHAKRA]  Mode:    MANUAL
[CHAKRA]  Status:  SLEEPING — full pass-through active
[CHAKRA]  Day 1 of 7 minimum learning period
[CHAKRA] ──────────────────────────────────────────
[CHAKRA]  Open the dashboard to monitor learning progress.
[CHAKRA]  CHAKRA will not activate until you initiate manually.
[CHAKRA] ──────────────────────────────────────────
```

Clear. Friendly. Developer knows exactly what state CHAKRA
is in from the first line of output.

---

## 8. PACKAGE STRUCTURE

```
chakra-middleware/  (npm package)
│
├── index.js                 # Entry point — exports chakra()
│
├── core/                    # Hot path components
│   ├── dispatcher.js        # CP4 — request routing decision
│   ├── weight-engine.js     # CP5 — weight score calculation
│   ├── ring-mapper.js       # CP3 — route lookup table
│   └── activation.js        # CP2.5 — mode + state management
│
├── background/              # Async background components
│   ├── shadow-mode/
│   │   ├── observer.js      # CP1 — request observation
│   │   ├── analyser.js      # CP1 — pattern analysis jobs
│   │   └── suggester.js     # CP1 — Ring Map + policy suggestions
│   ├── rpm-engine.js        # CP2 — load score calculation
│   └── session-cache.js     # Session context store
│
├── integrations/            # Framework adapters
│   ├── express.js
│   ├── fastify.js
│   └── generic.js           # Generic Node.js HTTP adapter
│
├── dashboard/               # CP8 — web UI server
│   ├── server.js
│   ├── api.js               # REST API for dashboard UI
│   └── static/              # Built dashboard frontend files
│
├── config/
│   ├── loader.js            # Config file reader + validator
│   ├── validator.js         # Schema validation with clear errors
│   └── defaults.js          # All default values documented
│
└── utils/
    ├── hasher.js            # Session ID / user ID hashing (privacy)
    ├── logger.js            # Structured logging
    └── metrics.js           # Internal metrics collection

─────────────────────────────────────────────────

chakra-middleware/  (PyPI package — Python)
  Same structure, Python implementation.
  Shared config format (YAML — same schema).
  Shared dashboard (same web UI served from Python).

io.chakra:chakra-middleware  (Maven — Java)
  Same structure, Java/Spring Boot implementation.
  Shared config format.
  Shared dashboard.
```

---

## 9. LANGUAGE RELEASE PRIORITY

```
Phase 1 — Node.js (Express + Fastify)
  Largest backend community.
  Fastest adoption validation.
  Used to validate all design decisions with real users.
  Ship first.

Phase 2 — Python (FastAPI + Flask + Django)
  Second largest community.
  Strong startup and ML-adjacent backend usage.
  Ship after Node.js is stable.

Phase 3 — Java (Spring Boot)
  Enterprise market.
  Larger companies. Higher stakes. Higher trust requirements.
  Ship after Python, with enterprise-grade testing.
```

Same config schema across all three.
Developer moving between stacks needs to relearn nothing.

---

## 10. THE CHAKRA OBJECT — PUBLIC API

What the developer interacts with directly:

```javascript
// Full public API surface

const chakraInstance = chakra('./chakra.config.yaml');

// Framework integration
chakraInstance.middleware()          // returns middleware function
chakraInstance.fastifyPlugin()       // returns Fastify plugin
chakraInstance.block('block-name')   // returns route annotation middleware

// Manual mode controls (used by dashboard, can also be called in code)
chakraInstance.activate()            // wake CHAKRA up
chakraInstance.deactivate()          // initiate sleep sequence
chakraInstance.status()              // returns current status object

// Config (live updates)
chakraInstance.updateConfig(patch)   // update config without restart
chakraInstance.reloadConfig()        // reload config file from disk

// Observability
chakraInstance.getMetrics()          // current metrics snapshot
chakraInstance.getRPM()              // current RPM score
chakraInstance.getBlockStates()      // current state of all blocks

// Lifecycle
chakraInstance.shutdown()            // graceful shutdown
```

Small, clean API surface.
Developer only touches what they need.
Advanced features accessible but not required.

---

## 11. DESIGN DECISIONS MADE

1. **Under 10 minutes from install to running — hard requirement.**
   Every design decision in the package is evaluated against this.
   If it adds complexity to the install experience, it needs
   a very strong reason to exist.

2. **Minimum config is two words.**
   `mode: "manual"` is all that is required.
   Everything else has sensible defaults.
   Developer is never forced to understand internals to get started.

3. **CHAKRA never crashes the app. Ever.**
   Config errors → CHAKRA disables itself.
   Runtime errors → affected component disables itself.
   App always runs. This is the fundamental safety contract.

4. **Same config schema across all language packages.**
   Developer moving between Node.js and Python rewrites nothing.
   `chakra.config.yaml` is identical regardless of language.

5. **Node.js ships first.**
   Largest community. Fastest validation cycle.
   Python and Java follow once core design is validated.

6. **Dashboard ships as part of the package.**
   Not a separate installation. Not a cloud service.
   Runs locally on port 4242 alongside the developer's app.
   Zero extra setup. Immediately available on first start.

7. **Public API is minimal and stable.**
   Small API surface = fewer breaking changes.
   Advanced features accessible but hidden from basic usage.
   Developer can grow their use of CHAKRA gradually.

8. **Annotations feel like documentation.**
   `chakra.block('payment-block')` reads as a statement about
   what the route is — not as configuration boilerplate.
   The best framework integrations always feel like
   documentation that happens to also be functional.

---

## 12. NEXT CHECKPOINT

**CP7 — Policy Engine**
Covers: The rule evaluation system that runs in Step 6 of the
Dispatcher. How developer-written policy rules are stored,
evaluated, and matched against incoming requests.
How Shadow Mode policy suggestions become active rules.
Live rule editing without restart.

---

## CONNECTIONS TO OTHER CHECKPOINTS

```
CP1 (Shadow Mode)      → Runs inside background/ package directory.
                         Suggestions surfaced via Dashboard.

CP2 (RPM Engine)       → Runs inside background/ package directory.
                         Accessible via chakraInstance.getRPM().

CP2.5 (Activation)     → activation.js in core/ directory.
                         Manual controls exposed via public API.

CP3 (Ring Mapper)      → ring-mapper.js in core/ directory.
                         Compiled at startup from annotations + config.

CP4 (Dispatcher)       → dispatcher.js in core/ directory.
                         Mounted via chakraInstance.middleware().

CP5 (Weight Engine)    → weight-engine.js in core/ directory.
                         Called internally by Dispatcher.

CP7 (Policy Engine)    → policy-engine.js in core/ directory (not yet built).
                         Called internally by Dispatcher in Step 6.

CP8 (Dashboard)        → dashboard/ directory.
                         Starts automatically on port 4242 at boot.

CP9 (Container Bridge) → optional integration/ adapters.
                         Not required for core functionality.
```

---

*Checkpoint 6 created during Middleware Package design session.*
*Previous: CHAKRA_CP5_WeightEngine.md*
*Next: CHAKRA_CP7_PolicyEngine.md*
