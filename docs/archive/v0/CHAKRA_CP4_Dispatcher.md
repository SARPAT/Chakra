# PROJECT CHAKRA
## Checkpoint 4 — Dispatcher (The Hot Path)
### Status: DISCUSSION COMPLETE → READY TO BUILD
### Position in Build Order: FOURTH
### Depends on: CP1, CP2, CP2.5, CP3

---

## What The Dispatcher Does — One Sentence

> On every single HTTP request, in under 2 milliseconds,
> decide whether this request passes through fully,
> passes through with degradation hints, or is intercepted
> and served a fallback response directly by CHAKRA.

This is the most performance-critical component in CHAKRA.
Everything else is background work. The Dispatcher is live,
on every request, always.

---

## 1. THE FUNDAMENTAL RULE — PASS-THROUGH WHEN SLEEPING

Before anything else — this rule is non-negotiable:

> When CHAKRA is sleeping, the Dispatcher adds zero meaningful
> overhead to any request. The application performs exactly
> as if CHAKRA was not installed.

```
CHAKRA sleeping:

Request arrives
       ↓
Dispatcher checks activation flag → false
       ↓
Request passes through immediately.
Zero Ring Map lookup.
Zero RPM check.
Zero policy evaluation.
Pure pass-through.

Added latency: < 0.1ms (single boolean check)
```

A company must be able to install CHAKRA in production
on a normal day and see absolutely no performance difference
in their application. This is the adoption requirement.
If CHAKRA costs anything when sleeping, nobody will install it.

---

## 2. THE DECISION SEQUENCE — ACTIVE PATH

When CHAKRA IS active, the full sequence runs on every request:

```
STEP 1 — Activation Check                    < 0.1ms
  Is CHAKRA currently active?
  NO  → pass through immediately (see above)
  YES → continue

STEP 2 — Ring Map Lookup                     < 0.1ms
  Look up METHOD:PATH in compiled lookup table.
  Returns: { block, minLevel, weightBase }
  O(1) hash lookup. No parsing. No iteration.
  Unmatched → default-block (always active)

STEP 3 — Block State Read                    < 0.1ms
  What is the current active level for this block?
  Is this block suspended right now?
  Read from Block State Table (in-memory).

STEP 4 — Suspension Check                    < 0.1ms
  Is this block suspended at the current level?
  NO  → OUTCOME: Serve Fully → pass to backend
  YES → continue to Step 5

STEP 5 — Weight Engine                       < 0.5ms
  Read session context from Session Context Cache.
  Calculate weight score for this request.
  Can weight pull this request to a lower level (closer to core)?
  weight > override_high_threshold  → OUTCOME: Serve Fully
  weight > override_low_threshold   → OUTCOME: Serve Limited
  weight < override_low_threshold   → continue to Step 6

STEP 6 — Policy Engine Check                 < 0.5ms
  Are there any active policies matching this request?
  Premier user policy?
  Moment of Value session policy?
  Custom developer policy?
  Policy says protect → OUTCOME: Serve Fully
  No matching policy → OUTCOME: Suspend

STEP 7 — Execute Outcome                     < 0.1ms
  SERVE FULLY   → forward request to backend unchanged
  SERVE LIMITED → forward with X-Chakra-* context headers
  SUSPEND       → return fallback response directly

TOTAL BUDGET: < 1.5ms
```

All reads are in-memory. No disk. No network. No database.
Total budget under 2ms is consistently achievable.

---

## 3. THE THREE OUTCOMES

---

### OUTCOME 1 — SERVE FULLY
Request passes to backend unchanged.
User receives full, normal response.

When this happens:
- Block is active at current level
- Block has minimum_level 0 (payment, auth — always protected)
- Request weight exceeds high override threshold
- A policy rule protects this request

---

### OUTCOME 2 — SERVE LIMITED
Request passes to backend, but CHAKRA injects context headers.
Backend reads these headers and returns a lighter response.
User receives a real response — just less detailed.

```
Headers injected by Dispatcher:

X-Chakra-Active: true
X-Chakra-Level: 2
X-Chakra-Block: browse-block
X-Chakra-Hint: omit-heavy-data

Backend code reads X-Chakra-Hint and adjusts:
  Normal response:  { product, images[], relatedItems[], reviews[], specs{} }
  Limited response: { product, specs{} }
  (images, related items, reviews omitted)
```

This is the softest form of degradation.
Endpoint still responds. Backend still involved.
User gets something real, just reduced.
Developer writes the "limited mode" logic once in their backend.
CHAKRA triggers it via headers.

When this happens:
- Block is technically suspended at current RPM level
- But request weight is moderate (above low threshold, below high threshold)
- Request deserves partial service — not full, not nothing

---

### OUTCOME 3 — SUSPEND
Request intercepted by CHAKRA entirely.
Fallback response returned directly by CHAKRA middleware.
Backend never sees this request.
This is where real load reduction happens.

```javascript
// CHAKRA returns directly — backend not involved:

// For a JSON API endpoint (recommendations):
{
  status: 200,
  headers: {
    "Content-Type": "application/json",
    "X-Chakra-Suspended": "recommendations-block",
    "X-Chakra-Active": "true"
  },
  body: {
    items: [],
    _chakra_suspended: true,
    _chakra_reason: "high_load"
  }
}

// Developer configures fallback response per block in Ring Map (CP3)
// CHAKRA just returns exactly what was configured
```

The `_chakra_suspended: true` flag lets the frontend
handle gracefully and lets analytics track it.

When this happens:
- Block is suspended at current level
- Request weight is below all override thresholds
- No policy protects this request

---

## 4. THE WEIGHT OVERRIDE THRESHOLDS

Two thresholds control the Serve Limited vs Suspend boundary:

```
weight_override_high: 65  (default — Serve Fully threshold)
weight_override_low:  40  (default — Serve Limited threshold)

Weight score → Outcome:
  weight >= 65  → Serve Fully   (override suspension completely)
  weight 40–64  → Serve Limited (partial service with headers)
  weight < 40   → Suspend       (full interception)
```

Developer configures these in strategy config.
Higher thresholds = harder to override = more aggressive degradation.
Lower thresholds = easier to override = more requests protected.

---

## 5. THE SESSION CONTEXT CACHE

Weight Engine needs session context to calculate accurate weights.
But HTTP is stateless. The Dispatcher needs this without a DB call.

**Session Context Cache** — lightweight in-memory store:

```javascript
// Maintained by Shadow Mode Observer (CP1) — async, not on hot path
// Read by Dispatcher — synchronous, in-memory, microseconds

sessionContextCache = {
  "hashed_session_id_abc123": {
    callCount: 8,
    hasCartItems: true,
    cartItemCount: 3,
    matchesMomentOfValueSignature: true,
    recentEndpoints: [
      "GET:/api/products/456",
      "POST:/api/cart/add",
      "GET:/api/checkout/summary"
    ],
    userTier: "premier",           // if detectable from headers
    sessionStartTime: 1711276282,
    lastSeenTime: 1711276891
  }
}
```

Cache bounds:
- Max 50,000 active sessions in memory at any time
- Sessions evicted using LRU when limit reached
- Sessions expire after 30 minutes of inactivity
- Shadow Mode Observer writes to cache async
- Dispatcher reads from cache sync — read-only on hot path

**Session ID extraction:**
Dispatcher reads session identity from:
1. Session cookie (hashed before use)
2. Authorization header token (hashed before use)
3. X-Session-ID header if present
4. If none available → anonymous session → weight from URL pattern only

---

## 6. CONCURRENCY — THREAD SAFETY ON THE HOT PATH

The Dispatcher handles thousands of concurrent requests.
All reading from the same in-memory state simultaneously.

Design rule: **All Dispatcher reads are immutable snapshots.**

The Ring Map, Block State, Activation State, Session Cache —
these are never mutated while requests are in flight.
Background processes create new versions atomically and
swap the reference pointer. Dispatcher always reads a
consistent, stable snapshot.

```
Background state update process:

  Step 1: Build new version of state in separate memory
  Step 2: Validate new version completely
  Step 3: Atomic pointer swap (nanoseconds — CPU instruction)
  Step 4: Dispatcher now reads new version on next request
  Step 5: Old version garbage collected when no in-flight
          requests reference it (reference counting)

Result:
  Zero locking on the hot path.
  Zero race conditions.
  Zero performance degradation under high concurrency.
  Dispatcher never waits for anything.
```

---

## 7. THE COMPLETE DECISION FLOW

```
HTTP Request
      │
      ▼
┌──────────────────┐
│  CHAKRA Active?  │────── NO ──────────────────────→ Backend
└──────────────────┘                                  (pass-through)
      │ YES
      ▼
┌──────────────────┐
│  Ring Map        │──→ { block, minLevel, weightBase }
│  Lookup          │
└──────────────────┘
      │
      ▼
┌──────────────────┐
│  Block Active    │────── YES (not suspended) ──────→ Backend
│  at current      │                                  (serve fully)
│  level?          │
└──────────────────┘
      │ NO (suspended)
      ▼
┌──────────────────┐
│  Weight Engine   │──→ weightScore (0-100)
│  + Session       │
│  Context         │
└──────────────────┘
      │
      ├── weight >= 65 ──────────────────────────────→ Backend
      │                                                (serve fully)
      │
      ▼
┌──────────────────┐
│  Policy Engine   │
│  Check overrides │
└──────────────────┘
      │
      ├── policy protects ───────────────────────────→ Backend
      │                                                (serve fully)
      │
      ├── weight 40–64 (moderate) ──────────────────→ Backend
      │                                                (serve limited
      │                                                 + headers)
      │
      └── weight < 40, no policy ───────────────────→ CHAKRA
                                                       (suspend:
                                                        return fallback)
```

---

## 8. WHAT NEEDS TO BE BUILT

### Component: Dispatcher Core
The main request interceptor.
Integrates as middleware in the developer's framework.
Runs the full decision sequence.
Manages the pass-through vs active branching.
Language: Node.js first, then Python, Java SDKs.

### Component: Activation State Reader
Single boolean check + current level read.
Reads from Activation State Store (set by CP2.5 logic).
Must be the absolute fastest operation in the system.

### Component: Outcome Executor
Handles the three outcomes:
- Serve Fully: forward request, strip X-Chakra headers if any
- Serve Limited: inject X-Chakra context headers, forward
- Suspend: construct and return fallback response from Ring Map config

### Component: Session Context Cache
In-memory LRU cache.
Written to by Shadow Mode Observer (async, background).
Read by Dispatcher (sync, hot path).
Max 50,000 entries. 30-minute TTL.
Thread-safe reads via immutable snapshot pattern.

### Component: Dispatcher Metrics Collector
Counts per decision type (serve/limit/suspend) per block.
Feeds into RPM Engine and Dashboard.
Async write — never blocks the hot path.

---

## 9. DISPATCHER METRICS — WHAT IT REPORTS

The Dispatcher silently tracks its own decisions.
These metrics feed the Dashboard and RPM Engine.

```
Per 5-second window, reported to Dashboard:

{
  "window": "2026-03-24T14:32:00Z",
  "total_requests": 8420,
  "outcomes": {
    "serve_fully":   6102,   // 72.5%
    "serve_limited":  891,   // 10.6%
    "suspended":     1427    // 16.9%
  },
  "per_block": {
    "payment-block":          { served: 420,  suspended: 0 },
    "cart-block":             { served: 1840, suspended: 0 },
    "browse-block":           { served: 3842, suspended: 891 },
    "recommendations-block":  { served: 0,    suspended: 1427 }
  },
  "weight_overrides": 234,     // requests saved by weight override
  "policy_overrides": 89       // requests saved by policy rules
}
```

This data is what makes the Dashboard meaningful.
Developer can see exactly what CHAKRA is doing in real time.

---

## 10. DESIGN DECISIONS MADE

1. **Pass-through when sleeping is absolute.**
   Single boolean check. Under 0.1ms. No exceptions.
   This is the adoption requirement — zero cost when not needed.

2. **Total active path budget: under 2ms.**
   All reads in-memory. No external calls on hot path.
   This is enforced as a hard requirement during build.

3. **Three outcomes, not two.**
   Serve Fully / Serve Limited / Suspend.
   Serve Limited with context headers gives developers
   a graceful middle ground — real responses, lighter payload.
   Binary on/off would be too blunt for many use cases.

4. **Immutable snapshot pattern for concurrency.**
   Zero locking on hot path. Atomic pointer swaps for updates.
   Dispatcher never waits for anything.

5. **Session Context Cache is read-only on hot path.**
   Shadow Mode Observer writes it async.
   Dispatcher reads it sync.
   Strict separation of read and write paths.

6. **Dispatcher never writes to any state.**
   Pure read-and-decide. All state writing handled by
   background components. Keeps the hot path clean and fast.

7. **Metrics collection is async.**
   Decision counters written to a background buffer.
   Flushed every 5 seconds.
   Never adds latency to the request decision itself.

8. **Fallback response configured by developer per block.**
   CHAKRA does not decide what a suspended block returns.
   Developer configures it in Ring Map (CP3).
   CHAKRA just executes it. Developer knows their frontend best.

---

## 11. NEXT CHECKPOINT

**CP5 — Weight Engine**
Covers: The full weight calculation formula. All signals that
contribute to a request's weight score. How Moment of Value
signatures from Shadow Mode feed into weight calculation.
How developer-defined weight overrides work. The override
threshold configuration.

---

## CONNECTIONS TO OTHER CHECKPOINTS

```
CP1 (Shadow Mode)      → Writes Session Context Cache async.
                         Moment of Value signatures used in Step 5.

CP2 (RPM Engine)       → Block State Table read in Step 3.
                         Per-block RPM determines which blocks
                         are suspended.

CP2.5 (Activation)     → Activation State Store read in Step 1.
                         Determines if Dispatcher runs full path
                         or pure pass-through.

CP3 (Ring Mapper)      → Ring Map Lookup Table read in Step 2.
                         Fallback response config used in Suspend outcome.

CP5 (Weight Engine)    → Called in Step 5. Calculates weight score.
                         Returns score used for override thresholds.

CP6 (Middleware)       → Dispatcher is packaged as part of middleware.
                         Framework integration layer wraps Dispatcher.

CP7 (Policy Engine)    → Called in Step 6. Returns any matching
                         policy overrides for this request.

CP8 (Dashboard)        → Receives Dispatcher metrics every 5 seconds.
                         Shows live serve/suspend breakdown per block.
```

---

*Checkpoint 4 created during Dispatcher design session.*
*Previous: CHAKRA_CP3_RingMapper.md*
*Next: CHAKRA_CP5_WeightEngine.md*
