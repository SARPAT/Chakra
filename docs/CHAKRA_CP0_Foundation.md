# PROJECT CHAKRA
## Checkpoint 0 — Foundation & Vision
### Status: DISCUSSION COMPLETE → READY TO BUILD

---

## What Is This Document?
This is Checkpoint 0 of Project CHAKRA. It captures the complete founding idea, architecture decisions, and build plan as discussed in Phase 0. Every future coding agent or team member should read this first before reading any other checkpoint. This is the origin document.

Checkpoints are named: `CHAKRA_CP{number}_{PhaseName}.md`

---

## 1. THE ORIGIN IDEA

The project was born from a physics analogy — a **rotating disc (Chakra)** with concentric rings around a central core.

The problem it targets:
> "Sudden surge in user requests — like a Friday sale on a shopping app — causes the entire application to either slow down or crash, affecting ALL users equally, including those in the middle of critical actions like payment."

The physics analogy maps like this:

```
Physical Disc          →    Software System
─────────────────────────────────────────────
Rotating Core          →    Application Core
Concentric Rings       →    Functionality Levels (0, 1, 2, 3...)
RPM (spin speed)       →    System Load / Traffic Pressure
Object thrown outward  →    HTTP Request being routed
Landing ring           →    Functionality level request gets served
Object mass/weight     →    Request priority (payment = heavy, browse = light)
Centrifugal force      →    Load pressure pushing requests to outer rings
```

**Key insight from the analogy:**
- Low RPM (low load) → requests land close to core → full functionality
- High RPM (high load) → requests fly outward → reduced functionality
- Heavy requests (payments) → resist outward throw → always land close to core

---

## 2. WHAT CHAKRA IS — ONE SENTENCE

> **A smart middleware/policy layer that sits in front of any application, measures load in real time, and routes each incoming request to the right "version" of the application — full, partial, or minimal — based on current load pressure AND request priority.**

---

## 3. WHAT CHAKRA IS NOT

This is critical for scoping:

- ❌ NOT a replacement for Kubernetes
- ❌ NOT a replacement for AWS / ECS / any cloud infra
- ❌ NOT a scaling tool (it doesn't spin up new servers)
- ❌ NOT a load balancer

CHAKRA activates at a very specific stage:

```
Stage 1: Normal traffic        → Infra handles it. CHAKRA watches silently.
Stage 2: Traffic increasing    → K8s / ASG auto-scaling kicks in.
Stage 3: Scaling limit reached → THIS IS WHERE CHAKRA ACTIVATES.
Stage 4: Graceful degradation  → CHAKRA policy takes over.
Stage 5: Traffic normalizes    → CHAKRA steps back. Full app restored.
```

CHAKRA owns **Stage 3 and Stage 4**. Nothing on the market does this intelligently today.

---

## 4. THE CORE ARCHITECTURE — 4 LAYERS

### LAYER 1: RPM Engine (Load Sensor)
**What it is:** Produces a single real-time number (0–100) representing current system load pressure. We call this number "RPM" — directly from the physics analogy.

**What it measures (3 signals combined):**
- Incoming request rate (how fast requests are arriving)
- Current response latency (how long requests are taking)
- Error rate (how many requests are failing)

Why these three? Because CPU alone (what most systems use) is a lagging indicator. By the time CPU spikes, users are already suffering. Combining request rate + latency + error rate gives an earlier, more accurate picture.

**Output:** A single normalized 0–100 RPM score, updated every second.

**Why this first?** Everything else — routing decisions, policy enforcement — depends on this number. Without a reliable load signal, nothing else works.

---

### LAYER 2: Level Mapper — "App Ring Map"
**What it is:** Defines what functionality exists at each level. The developer maps their application's API endpoints into concentric rings once. CHAKRA enforces it automatically.

**The Ring Map concept (from whiteboard):**
```
Level 0 (innermost) → Full application. All endpoints active.
Level 1             → Non-essentials removed (recommendations, ads)
Level 2             → Transactional core only (search, cart, checkout)
Level 3 (outermost) → Survival mode (payment and auth only)
```

**Blocks — The Key Innovation from Whiteboard:**
Each sector of the ring map is a **Block**. A Block is a group of related API endpoints that share the same deployment container/configuration.

```
Different API calls   →  Different Blocks
Different Blocks      →  Different Container Configurations
                         (running on existing K8s / AWS — whatever they use)
```

Example blocks for an e-commerce app:
- Block A: Payment / Checkout API → Critical. Never degraded.
- Block B: Cart / Order API → High priority.
- Block C: Browse / Search API → Medium priority.
- Block D: Recommendations / Ads API → Low priority. First to suspend.

**Approach for mapping (Hybrid — decided in discussion):**

We use a two-part approach:

**Part 1 — Code Annotations** (Developer decorates their routes directly):
```javascript
// Express.js example — one line per route
router.get('/products',     chakra.level(1), getProducts)
router.post('/cart',        chakra.level(2), addToCart)
router.post('/payment',     chakra.level(0), processPayment) // always available
router.get('/recommendations', chakra.level(3), getRecs)    // first to go
```
Lives next to the code. No separate file to maintain. Natural to write.

**Part 2 — Pattern-Based Auto-Weighting** (CHAKRA assigns weights automatically):
```
Rules applied automatically:
  POST > GET                              (writes more important than reads)
  /payment in URL                     →   weight 90+
  /checkout in URL                    →   weight 75+
  /cart in URL                        →   weight 60+
  /auth or /login in URL              →   weight 85+
  /recommendations or /ads in URL     →   weight 10
  GET + no session token              →   weight 15 (anonymous browsing)
  POST + active session + cart exists →   weight +20 bonus (mid-checkout user)
```
Developer can override any of these. 80% of apps won't need to.

---

### LAYER 3: Weight Engine (Request Mass)
**What it is:** Every incoming HTTP request gets a weight score. This weight acts as a modifier — it can pull a request DOWN to a lower level than the current RPM would normally assign it.

**The core formula:**
```
Effective Level = Base Level from RPM — Weight Modifier
```

Example:
```
Current RPM → would route everyone to Level 2
Payment request (weight 95) → pulled down to Level 0 (always gets full service)
Browse request (weight 15) → stays at Level 2 (gets reduced service)
Cart request (weight 60) → pulled to Level 1 (gets most service)
```

**The Premier User insight (from discussion):**
Policy example that makes this concrete:
> "A company wants their premier/paid users to never feel the heat during surge."

```
RULE: IF user.tier == "premier"
      THEN override weight → 100 (always lands at Level 0)
```

This is configured in the Policy System (see below), not hardcoded.

---

### LAYER 4: Dispatcher (The Throw)
**What it is:** The core routing decision-maker. On every single request it:
1. Reads current RPM from Layer 1
2. Reads request weight from Layer 3
3. Consults the Ring Map from Layer 2
4. Routes the request to the correct block/level

This must be extremely fast — it runs on every request. Microsecond-level decision making.

---

## 5. THE POLICY SYSTEM — Developer Control Panel

This is described as the "real jewel" of the project. It gives power directly to the app developer/company. They can edit, add, update policies at any time — even live, without redeployment.

**Example policy set for an e-commerce app:**
```
RULE 1: IF surge_level > 60%
        THEN suspend → Block: recommendations, ads, reviews

RULE 2: IF surge_level > 80%
        THEN restrict → Block: search (serve cached results only)

RULE 3: IF user.tier == "premier"
        THEN always_serve → all blocks (ignore surge level)

RULE 4: IF user.is_mid_checkout == true
        THEN protect → Block: cart, payment (never degrade these)

RULE 5: IF surge_level > 95%
        THEN serve_only → Block: payment, checkout
```

Policy rules are the developer's interface to CHAKRA's intelligence. They define the business logic of degradation. CHAKRA enforces it mechanically.

---

## 6. WHAT WE ARE BUILDING — 5 CONCRETE COMPONENTS

```
Component 1: CHAKRA Agent (Middleware Package)
             What: Sits inside developer's app as an installable package.
                   Intercepts all requests. Reads RPM + policy. Routes to correct block.
             First language: Node.js (largest backend community, fastest adoption)
             Later: Python SDK, Java SDK
             Entry point for all developers.

Component 2: Ring Map Generator (Shadow Mode Observer)
             What: Runs silently alongside the app for 24-48 hours.
                   Watches traffic. Clusters API calls into blocks automatically.
                   Outputs a suggested App Ring Map for developer review.
             Solves: Bootstrapping problem — gives value on Day 1 before
                     developer has configured anything.

Component 3: Policy Engine
             What: Rule evaluator. Runs on every request. Fast.
                   Developer-editable rules. Live updates without restart.
                   Stores and evaluates all policy rules.

Component 4: CHAKRA Dashboard (Web UI)
             What: Visual interface for everything.
                   - See the Ring Map of your app visually
                   - Write and edit policies
                   - See real-time RPM
                   - See which blocks are active/suspended right now
             This is the product's face. Most important for adoption.

Component 5: Block-to-Container Bridge
             What: Communicates with K8s / ECS / AWS — whatever the developer uses.
                   Tells it to allocate more/less resources per block during surge.
                   Uses their existing APIs (Kubernetes API, AWS API).
                   CHAKRA doesn't replace their infra — it instructs it intelligently.
```

---

## 7. ADOPTION PATH — How a Company Starts Using CHAKRA

Designed for near-zero friction. Value must be visible on Day 1.

```
Day 1 — Install
  npm install chakra-middleware
  (or pip install chakra-middleware)
  One package. Works with Express, FastAPI, Spring, etc.

Day 2 — Shadow Mode Activates
  CHAKRA runs silently. Observes all API calls.
  Builds Ring Map automatically by watching traffic patterns.
  Developer sees a dashboard filling up with their app's structure.
  Zero configuration required yet.

Day 3 — Review Ring Map
  Developer opens CHAKRA dashboard.
  Reviews auto-generated block structure.
  Adjusts if needed. Approves the map.

Day 4 — Write First Policy
  Developer writes first rule.
  "If load > 70%, suspend recommendations block."
  CHAKRA is now active.

Day 5+ — CHAKRA is live and growing
  Developer adds policies over time.
  Premier user rules. Checkout protection. Regional rules.
  It grows with the product.
```

---

## 8. HOW IT FITS WITH EXISTING INFRA

```
BEFORE CHAKRA:
  User Request → Load Balancer → Full App (all or nothing)
                                        ↓
                               K8s / AWS handles scaling
                               (but serves full app or fails)

WITH CHAKRA:
  User Request → CHAKRA Policy Layer → decides WHICH block serves this
                      ↓                           ↓
                App Ring Map            Block A: payment container
                (developer defined)     Block B: cart container
                                        Block C: browse container
                                                 ↓
                                        K8s / AWS / whatever — UNCHANGED.
                                        CHAKRA just adds intelligent
                                        policy routing on top.
```

---

## 9. THE COMPETITIVE GAP — WHY THIS DOESN'T EXIST YET

Current solutions and their gaps:

| Solution | What it does | What it misses |
|---|---|---|
| Circuit Breakers | Stops serving when overloaded | On/off only. No spectrum. No priority. |
| K8s HPA | Scales pods on CPU/memory | Reactive. Slow. Doesn't know business priority. |
| Rate Limiting | Blocks excess requests | Blocks everyone equally. Pays users get blocked too. |
| CDN Caching | Serves static content from edge | Only for reads. Doesn't help dynamic/transactional flows. |
| Feature Flags | Toggle features on/off | Manual. Not load-aware. Not automatic. |

**CHAKRA's unique combination:**
- Continuous spectrum of functionality (not just on/off)
- Per-request weighting based on priority
- Automatic load-driven routing
- Developer-defined policy control
- Works on top of any existing infrastructure

No existing tool combines all five. That is the gap CHAKRA fills.

---

## 10. BUILD ORDER (DECIDED)

```
Step 1 → RPM Engine
         Foundation. Everything depends on this signal.

Step 2 → Level Mapper + Annotation System
         Define the rings. Developer-facing config.

Step 3 → Dispatcher (Core Router)
         Connect RPM to levels. Core routing logic.

Step 4 → Weight Engine
         Advanced routing with request priority.

Step 5 → Wrap as Middleware Package
         So any app plugs CHAKRA in without rewriting code.

Step 6 → Shadow Mode + Ring Map Generator
         Automatic app discovery. Day 1 value.

Step 7 → Policy Engine
         Live editable rules. Business logic layer.

Step 8 → CHAKRA Dashboard
         Visual UI. Product face. Adoption driver.

Step 9 → Block-to-Container Bridge
         K8s / AWS integration. Resource allocation.
```

---

## 11. NEXT CHECKPOINT

**CP1 — RPM Engine Design**
Covers: Exact signals measured, formula for 0–100 score, update frequency, implementation plan, tech stack decision for the engine.

---

## GLOSSARY (For future agents reading this)

| Term | Meaning |
|---|---|
| RPM | Single 0–100 load score. Higher = more stressed. Drives all routing decisions. |
| Ring Map / App Ring Map | The developer's map of their app — which endpoints live at which level. |
| Level | A ring of functionality. Level 0 = full app. Higher number = fewer features. |
| Block | A group of related API endpoints that deploy together as a unit. |
| Weight | A per-request priority score. Higher weight = request pulls toward Level 0. |
| Shadow Mode | CHAKRA observing silently without routing anything. Learning phase. |
| Dispatcher | The component that makes the final routing decision on each request. |
| Policy | A developer-written rule that overrides default routing behavior. |

---

*Checkpoint 0 created during founding brainstorm session.*
*Next: CHAKRA_CP1_RPMEngine.md*
