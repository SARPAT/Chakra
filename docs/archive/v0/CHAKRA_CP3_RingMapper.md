# PROJECT CHAKRA
## Checkpoint 3 — Ring Mapper
### Status: DISCUSSION COMPLETE → READY TO BUILD
### Position in Build Order: THIRD
### Depends on: CP1 (Shadow Mode), CP2 (RPM Engine), CP2.5 (Activation Modes)

---

## What The Ring Mapper Does — One Sentence

> Maintains CHAKRA's internal model of the application —
> which endpoints belong to which block, and what level
> each block serves at — in a form the Dispatcher can
> read in microseconds on every single request.

---

## 1. THE DATA MODEL — TWO PARTS

The Ring Map is two structures combined.

---

### Part 1 — Block Registry
Static. Defined once by the developer.
Describes what the application looks like — its blocks and endpoints.

```json
{
  "blocks": {
    "payment-block": {
      "name": "Payment & Checkout",
      "endpoints": [
        "POST /api/payment/process",
        "POST /api/checkout/confirm",
        "GET  /api/checkout/summary",
        "POST /api/order/create"
      ],
      "minimum_level": 0,
      "weight_base": 90
    },
    "cart-block": {
      "name": "Cart & Orders",
      "endpoints": [
        "POST /api/cart/add",
        "GET  /api/cart",
        "DELETE /api/cart/item/:id",
        "GET  /api/orders/:id"
      ],
      "minimum_level": 1,
      "weight_base": 60
    },
    "browse-block": {
      "name": "Browse & Search",
      "endpoints": [
        "GET /api/products",
        "GET /api/products/:id",
        "GET /api/search",
        "GET /api/categories"
      ],
      "minimum_level": 2,
      "weight_base": 30
    },
    "recommendations-block": {
      "name": "Recommendations & Ads",
      "endpoints": [
        "GET /api/recommendations",
        "GET /api/ads",
        "GET /api/social-feed",
        "GET /api/reviews/suggested"
      ],
      "minimum_level": 3,
      "weight_base": 10
    }
  }
}
```

**Field definitions:**

`minimum_level` — the highest level number at which this block
can be suspended. A block with minimum_level 0 is NEVER suspended
regardless of how high RPM climbs. Payment block is always 0.

`weight_base` — the starting weight score for any request hitting
this block. The Weight Engine (CP5) uses this as its base,
then adjusts based on request-specific signals.

---

### Part 2 — Level Map
Defines what the application looks like at each level.
Which blocks are active, which are suspended.

```json
{
  "levels": {
    "0": {
      "description": "Full app — all blocks active",
      "active_blocks": [
        "payment-block",
        "cart-block",
        "browse-block",
        "recommendations-block"
      ],
      "suspended_blocks": []
    },
    "1": {
      "description": "Non-essentials suspended",
      "active_blocks": [
        "payment-block",
        "cart-block",
        "browse-block"
      ],
      "suspended_blocks": ["recommendations-block"]
    },
    "2": {
      "description": "Transactional core only",
      "active_blocks": [
        "payment-block",
        "cart-block"
      ],
      "suspended_blocks": ["browse-block", "recommendations-block"]
    },
    "3": {
      "description": "Survival mode — payment only",
      "active_blocks": ["payment-block"],
      "suspended_blocks": [
        "cart-block",
        "browse-block",
        "recommendations-block"
      ]
    }
  }
}
```

Block Registry + Level Map together = complete Ring Map.

---

## 2. HOW DEVELOPER DEFINES THE RING MAP — THREE WAYS

In order of preference:

---

### Way 1 — Code Annotations (Recommended)
Developer decorates routes directly in their existing code.
One line added per route. Nothing else changes.

```javascript
// Node.js / Express
const chakra = require('chakra-middleware');

router.post('/api/payment/process',
  chakra.block('payment-block'),
  processPayment)

router.post('/api/cart/add',
  chakra.block('cart-block'),
  addToCart)

router.get('/api/products',
  chakra.block('browse-block'),
  getProducts)

router.get('/api/recommendations',
  chakra.block('recommendations-block'),
  getRecommendations)
```

```python
# Python / FastAPI
from chakra import block

@app.post("/api/payment/process")
@block("payment-block")
async def process_payment():
    pass

@app.get("/api/recommendations")
@block("recommendations-block")
async def get_recommendations():
    pass
```

```java
// Java / Spring Boot
@PostMapping("/api/payment/process")
@ChakraBlock("payment-block")
public ResponseEntity<?> processPayment() { ... }

@GetMapping("/api/recommendations")
@ChakraBlock("recommendations-block")
public ResponseEntity<?> getRecommendations() { ... }
```

Why this is preferred:
- Annotation lives next to the code it describes
- When developer adds a new route, they assign its block at the same time
- No separate file to fall out of sync with the codebase
- Natural to write — feels like documentation that also works

---

### Way 2 — Explicit Config File
For teams who prefer all routing configuration in one place.
Useful for large teams where routing config is owned separately
from feature code.

```yaml
# chakra.ringmap.yaml

blocks:

  payment-block:
    minimum_level: 0
    weight_base: 90
    endpoints:
      - POST /api/payment/*        # wildcard — matches all payment endpoints
      - POST /api/checkout/*
      - POST /api/order/create

  cart-block:
    minimum_level: 1
    weight_base: 60
    endpoints:
      - POST /api/cart/*
      - GET  /api/cart
      - GET  /api/orders/*

  browse-block:
    minimum_level: 2
    weight_base: 30
    endpoints:
      - GET /api/products/*
      - GET /api/search
      - GET /api/categories/*

  recommendations-block:
    minimum_level: 3
    weight_base: 10
    endpoints:
      - GET /api/recommendations
      - GET /api/ads
      - GET /api/social-feed
```

Wildcard patterns supported.
`POST /api/payment/*` matches all POST requests under /api/payment/.
Compiled into prefix-match rules at startup.

---

### Way 3 — Shadow Mode Suggestion (Zero-Config Start)
Developer installs CHAKRA. Adds nothing else.
Shadow Mode observes traffic during learning period.
Pattern Analyser clusters endpoints into natural blocks.
Generates suggested Ring Map automatically.
Developer reviews in dashboard — approves, adjusts, or rejects.

This is the Day 1 experience.
Zero configuration required to get started.
Suggested map is based on real observed traffic patterns —
endpoints called together in the same session are grouped
into the same block automatically.

Developer can refine the suggestion using Ways 1 or 2
after the initial approval.

---

## 3. THE UNMATCHED ENDPOINT PROBLEM

What happens when a request arrives for an endpoint
NOT present in the Ring Map?

Causes:
- New endpoint added to the app but not yet annotated
- Third-party webhook callback
- Internal health check endpoint
- Legacy endpoint not included in initial mapping

Three handling options — developer configures preference:

```yaml
# chakra.config.yaml

ring_mapper:
  unmatched_endpoint_handling: "default-block"
  # Options:
  #   "default-block"     — route to always-active catch-all (default)
  #   "outermost-level"   — treat as lowest priority, suspend under stress
  #   "alert-only"        — pass through but flag in dashboard
```

```
default-block (DEFAULT):
  A catch-all block always active at Level 0.
  Unmatched endpoints are never degraded.
  Safe. Conservative. Nothing unintended is ever suspended.

outermost-level:
  Unmatched = unknown priority = treat as outer ring.
  Suspended when CHAKRA is under high stress.
  Appropriate for apps with very complete Ring Maps.

alert-only:
  Pass all unmatched requests through normally.
  Flag them visibly in the dashboard.
  "4 endpoints receiving traffic are not mapped."
  Pushes developer to keep Ring Map complete.
```

Regardless of handling choice:
ALL unmatched endpoints are always flagged in the dashboard.
Developer always knows their Ring Map has gaps.

---

## 4. THE FAST LOOKUP STRUCTURE

The Ring Map YAML/JSON definition is human-readable.
The Dispatcher cannot parse it on every request.

At startup, the Ring Mapper compiles the human-readable
definition into a flattened in-memory lookup table.
O(1) lookup. Microsecond reads.

```javascript
// Compiled lookup table — what Dispatcher actually reads

const routeLookup = {
  // Exact matches compiled first
  "POST:/api/payment/process":
    { block: "payment-block", minLevel: 0, weightBase: 90 },

  "POST:/api/checkout/confirm":
    { block: "payment-block", minLevel: 0, weightBase: 90 },

  "POST:/api/cart/add":
    { block: "cart-block", minLevel: 1, weightBase: 60 },

  "GET:/api/products":
    { block: "browse-block", minLevel: 2, weightBase: 30 },

  "GET:/api/recommendations":
    { block: "recommendations-block", minLevel: 3, weightBase: 10 },

  // Wildcard prefix matches compiled as prefix rules
  // "POST:/api/payment/*" → matches anything starting with POST:/api/payment/

  // Catch-all — always last
  "*":
    { block: "default-block", minLevel: 0, weightBase: 50 }
}
```

Lookup sequence on each request:
```
1. Check exact match  (METHOD:PATH)         → found? use it.
2. Check prefix rules (METHOD:PATH/*)       → matched? use it.
3. Check catch-all    (*)                   → always matches.
```

Entire lookup completes in under 1 microsecond.

---

## 5. RING MAP VERSIONING — LIVE UPDATES WITHOUT RESTART

The Ring Map evolves over time.
New endpoints added. Blocks reorganised. Levels adjusted.
CHAKRA must handle updates without stopping.

```
Versioning process:

Each Ring Map has a version number (v1, v2, v3...).
Current active version is what Dispatcher reads.

When developer updates Ring Map:
  Step 1: New version compiled and validated
          (check for syntax errors, missing block references)
  Step 2: Validation passes → new lookup table built in memory
  Step 3: New version marked as "pending"
  Step 4: After 5 seconds (in-flight requests drain):
          New version becomes active
  Step 5: Old version retired

On validation failure:
  Current version stays active
  Error shown in dashboard
  "Ring Map update rejected — payment-block references unknown endpoint"
```

History of all Ring Map versions stored.
Developer can see how the map evolved over time.
Can roll back to any previous version instantly.

```
Dashboard — Ring Map version history:

v4 (current)  — updated 2 hours ago    [ Active ]
v3            — updated 3 days ago     [ Rollback ]
v2            — updated 1 week ago     [ Rollback ]
v1            — initial (Shadow Mode)  [ Rollback ]
```

---

## 6. HOW SHADOW MODE SUGGESTIONS BECOME THE LIVE RING MAP

Full journey from zero-config install to active Ring Map:

```
Day 1 — Developer installs CHAKRA
  Shadow Mode activates. Starts observing.
  No Ring Map exists yet. All requests pass through unmatched.
  Default-block handles everything. No degradation possible yet.

Learning period (hours to days)
  Shadow Mode observes endpoint call patterns.
  Pattern Analyser identifies co-occurrence clusters:
    "These 5 endpoints are always called in the same session →
     they likely belong in the same block."
  Assigns preliminary weight_base scores from URL patterns + methods.
  Assigns preliminary minimum_level from call frequency + write vs read.

Shadow Mode suggestion ready
  Dashboard notification:
    "Ring Map suggestion ready. 47 endpoints → 4 blocks identified.
     Review and approve to activate CHAKRA."

Developer reviews suggestion
  Opens dashboard Ring Map view.
  Sees suggested blocks with their endpoints.
  Can drag endpoints between blocks.
  Can rename blocks.
  Can adjust minimum_level per block.
  Can adjust weight_base per block.

Developer approves
  Suggested Ring Map compiled into lookup table.
  Becomes active Ring Map version 1.
  CHAKRA can now be activated (manually or automatically).

Ongoing refinement
  Developer adds annotations to new routes as they are built.
  Ring Map stays current automatically.
  Shadow Mode flags unmatched endpoints as they appear.
```

---

## 7. WHAT A SUSPENDED BLOCK ACTUALLY RETURNS

When a request hits a suspended block — what does the user get?

This is developer-configurable per block:

```yaml
blocks:
  recommendations-block:
    minimum_level: 3
    weight_base: 10
    when_suspended:
      response_type: "empty"        # return empty array — app handles gracefully
      # OR
      response_type: "cached"       # return last cached response
      cache_max_age_seconds: 300    # use cache up to 5 minutes old
      # OR
      response_type: "static"       # return a static fallback response
      static_response: '{"items":[],"message":"Currently unavailable"}'
      # OR
      response_type: "503"          # return HTTP 503
      # (app should handle this and show appropriate UI)
```

The suspended block response is returned by CHAKRA directly —
the request never reaches the actual application server.
This is important: it reduces load on the backend precisely
when load reduction is needed most.

---

## 8. WHAT NEEDS TO BE BUILT

### Component: Ring Map Compiler
Reads developer's annotations or config file at startup.
Builds the flattened lookup table in memory.
Re-compiles on live updates.
Validates all block references and endpoint patterns.
Handles wildcard pattern compilation.

### Component: Ring Map Store
Holds current active lookup table in memory.
Maintains version history in persistent storage.
Supports rollback to previous versions.
Exposes simple read API to Dispatcher:
  `lookup(method, path)` → `{ block, minLevel, weightBase }`

### Component: Unmatched Endpoint Tracker
Monitors requests that hit the catch-all.
Aggregates by endpoint pattern.
Reports to dashboard:
  "These endpoints are receiving traffic but are not mapped."

### Component: Shadow Mode Ring Map Bridge
Receives suggested block structure from Shadow Mode Pattern Analyser.
Formats it as a Ring Map suggestion.
Presents to developer in dashboard for review.
On approval: feeds into Ring Map Compiler as version 1.

---

## 9. DESIGN DECISIONS MADE

1. **Block Registry + Level Map as two separate structures.**
   Block Registry is static app definition. Level Map is operational
   config. Keeping them separate makes both easier to edit and reason
   about independently.

2. **Three ways to define Ring Map.** Annotations for most developers,
   config file for larger teams, Shadow Mode suggestion for zero-config
   start. Every developer workflow is supported.

3. **Compiled lookup table for Dispatcher.**
   Human-readable definition compiled to O(1) in-memory table at
   startup. Dispatcher never parses YAML on the hot path.

4. **Default-block for unmatched endpoints.**
   Safe, conservative default. Nothing is accidentally degraded.
   Developer is always informed of gaps via dashboard.

5. **Suspended blocks return responses directly from CHAKRA.**
   Request never reaches the backend. This is the actual load
   reduction mechanism — not just routing decisions but actively
   absorbing suspended traffic at the middleware layer.

6. **Developer configures suspended block response per block.**
   Empty array, cached response, static fallback, or 503.
   Different blocks need different fallback behaviours.
   Developer knows their frontend better than CHAKRA does.

7. **Live updates without restart via versioning.**
   Ring Map evolves with the app. Validation prevents bad updates
   from going live. Rollback provides a safety net.

8. **Shadow Mode suggestion as the zero-config entry point.**
   Developer does not need to understand Ring Maps on day one.
   Shadow Mode shows them their app's structure first.
   They learn CHAKRA's model by seeing their own app through it.

---

## 10. NEXT CHECKPOINT

**CP4 — Dispatcher**
Covers: The core routing decision maker. How it reads RPM State,
Ring Map, Weight Engine output, and Policy Engine rules to make
the final routing decision on every request. The hot path.
Performance requirements. The pass-through mode when CHAKRA is sleeping.

---

## CONNECTIONS TO OTHER CHECKPOINTS

```
CP1 (Shadow Mode)       → Generates initial Ring Map suggestion.
                          Flags new unmatched endpoints over time.

CP2 (RPM Engine)        → Per-block RPM feeds into level decisions
                          for each block in the Ring Map.

CP2.5 (Activation)      → strategy config references block names
                          defined in Ring Map (always_protect,
                          degrade_first fields).

CP4 (Dispatcher)        → Primary consumer of Ring Map lookup table.
                          Reads it on every single request.

CP5 (Weight Engine)     → Reads weight_base from Ring Map as
                          starting point for weight calculation.

CP7 (Policy Engine)     → Policy rules reference block names.
                          "suspend recommendations-block" maps to
                          Ring Map block definitions.

CP8 (Dashboard)         → Shows Ring Map visually. Allows editing,
                          version history, unmatched endpoint alerts,
                          Shadow Mode suggestion review.
```

---

*Checkpoint 3 created during Ring Mapper design session.*
*Previous: CHAKRA_CP2.5_ActivationModes.md*
*Next: CHAKRA_CP4_Dispatcher.md*
