# PROJECT CHAKRA
## Checkpoint 5 — Weight Engine
### Status: DISCUSSION COMPLETE → READY TO BUILD
### Position in Build Order: FIFTH
### Depends on: CP1 (Shadow Mode), CP3 (Ring Mapper), CP4 (Dispatcher)

---

## What The Weight Engine Does — One Sentence

> Given a request heading for a suspended block, calculate
> a single weight score (0–100) that determines whether
> the request deserves to be rescued to full service,
> partial service, or stays suspended.

The Weight Engine is the most human-aware component in CHAKRA.
Everything else — RPM, Ring Map, Dispatcher — is mechanical.
The Weight Engine is where CHAKRA makes intelligent,
context-sensitive decisions about individual requests.

---

## 1. WHEN THE WEIGHT ENGINE RUNS

The Weight Engine is called only in Step 5 of the Dispatcher —
and only when a request has already reached a suspended block.

```
Dispatcher Step 4: Is this block suspended? YES
                                              ↓
                              Weight Engine called here
                                              ↓
                   Returns weight score → Dispatcher makes final decision
```

It does NOT run for:
- Requests to active (non-suspended) blocks
- Requests when CHAKRA is sleeping
- Requests to blocks with minimum_level 0 (always active)

This keeps the hot path fast — Weight Engine only runs
when its judgment is actually needed.

---

## 2. THE INPUTS

The Weight Engine receives a context package from the Dispatcher:

```javascript
{
  // From Ring Map (CP3)
  block: "browse-block",
  weightBase: 30,
  minLevel: 2,

  // From the HTTP request
  method: "GET",
  path: "/api/products/456",
  isAuthenticated: true,
  userTierHeader: "premier",      // from X-User-Tier header (if present)

  // From Session Context Cache (CP4)
  session: {
    callCount: 7,
    hasCartItems: true,
    cartItemCount: 2,
    matchesMomentOfValue: true,   // from Shadow Mode signatures (CP1)
    momentOfValueStrength: "full", // "none" / "partial" / "full"
    recentEndpoints: [
      "GET:/api/products/456",
      "POST:/api/cart/add",
      "GET:/api/checkout/summary"
    ],
    sessionAgeSeconds: 420
  },

  // From Ring Map developer overrides
  endpointWeightOverride: 0       // developer-specified bonus for this endpoint
}
```

---

## 3. THE WEIGHT FORMULA — 8 LAYERED SIGNALS

Weight is built by accumulating signals layer by layer.
Each signal contributes an additive bonus to the base score.
Final score capped at 100.

```
finalWeight = weightBase
            + methodSignal
            + authSignal
            + sessionDepthSignal
            + cartStateSignal
            + momentOfValueSignal
            + userTierSignal
            + developerOverride

Cap: min(finalWeight, 100)
```

---

### SIGNAL 1 — Block Base Weight (weightBase)
**Source:** Ring Map definition (set by developer)
**Purpose:** Establishes the floor for every request hitting this block.
Reflects the developer's own assessment of this block's importance.

```
Payment block:          90
Cart block:             60
Browse block:           30
Recommendations block:  10
Custom blocks:          developer-defined
```

Every request starts here. Cannot be zero.

---

### SIGNAL 2 — HTTP Method Signal (methodSignal)
**Source:** Request method
**Purpose:** Writes are always more intentful than reads.
A POST means the user is actively doing something — adding to cart,
saving a search, submitting a form. More worth protecting.

```
POST / PUT / DELETE / PATCH  → +15
GET / HEAD / OPTIONS         → +0
```

---

### SIGNAL 3 — Authentication Signal (authSignal)
**Source:** Request authentication status
**Purpose:** Authenticated users are known entities with account
history, purchase history, and commercial value. Worth more.
Anonymous users are unknown — conservative treatment appropriate.

```
Authenticated request  → +10
Anonymous request      → +0
```

---

### SIGNAL 4 — Session Depth Signal (sessionDepthSignal)
**Source:** Session Context Cache — callCount
**Purpose:** The more API calls a session has made, the more
invested that user is. A user on their 9th request has spent
real time in the app. Dropping them is more costly than dropping
someone who just arrived.

```
callCount 1–2     → +0   (just arrived)
callCount 3–5     → +5   (warming up)
callCount 6–10    → +10  (engaged)
callCount 11–20   → +15  (highly engaged)
callCount 21+     → +20  (deeply invested — do not drop)
```

---

### SIGNAL 5 — Cart State Signal (cartStateSignal)
**Source:** Session Context Cache — hasCartItems, cartItemCount
**Purpose:** Cart items are the strongest commercial intent signal.
A user with items in their cart is actively in a buying journey.
Dropping them costs real revenue. The more items, the higher the stake.

```
No cart items      → +0
1–2 cart items     → +15
3–5 cart items     → +25
6+ cart items      → +30  (serious buyer — protect strongly)
```

---

### SIGNAL 6 — Moment of Value Signal (momentOfValueSignal)
**Source:** Session Context Cache — matchesMomentOfValue,
           momentOfValueStrength (from Shadow Mode CP1)
**Purpose:** Shadow Mode learns the sequence of API calls that
reliably precede a conversion. If a session matches this sequence,
it is statistically likely to convert in the next few requests.
This is the most intelligent signal — it identifies high-value
sessions regardless of tier or explicit signals.

```
No signature match        → +0
Partial signature match   → +15  (on the journey, not yet at peak)
Full signature match      → +30  (conversion imminent — protect)
```

This signal gets more accurate over time as Shadow Mode
observes more conversions and refines its signatures.
Early in Shadow Mode learning, this signal may be +0 for most
sessions. As patterns accumulate, it becomes increasingly precise.

---

### SIGNAL 7 — User Tier Signal (userTierSignal)
**Source:** Request headers (X-User-Tier or developer-configured header)
**Purpose:** Developer's business policy — premium users should
always receive better service. The tier signal provides a large
enough bonus that premier users almost always exceed the
Serve Fully threshold regardless of other signals.

```
No tier detected   → +0
standard tier      → +0
premium tier       → +40
enterprise tier    → +50  (if developer configures enterprise tier)
```

The +40 for premium is deliberately large. Combined with
weightBase and any other signals, premium users almost
always reach the Serve Fully threshold (65 default).

Developer configures which header carries tier information
and what values map to which tier in strategy config.

---

### SIGNAL 8 — Developer Weight Override (endpointWeightOverride)
**Source:** Ring Map per-endpoint override config (CP3)
**Purpose:** For endpoints that don't fit automatic signal patterns.
Developer knows their app — they can manually boost specific endpoints.

```yaml
# Example in chakra.ringmap.yaml

blocks:
  browse-block:
    weight_overrides:
      "POST /api/search/save":     +20   # saving search = high intent
      "POST /api/wishlist/add":    +15   # wishlist add = commercial intent
      "GET /api/products/:id":     +0    # normal browse, no boost
```

Can be positive (boost) or negative (suppress).
Negative overrides can force certain endpoints to always suspend.

---

## 4. COMPLETE CALCULATION EXAMPLES

---

### Example A — Anonymous user, first visit, browsing
```
weightBase:              30   (browse-block)
method GET:              +0
anonymous:               +0
callCount 1:             +0
no cart:                 +0
no MoV match:            +0
no tier:                 +0
no override:             +0
────────────────────────────
finalWeight:             30   → SUSPEND
```
Correct. New anonymous visitor — no investment, no signals.
Suspend recommendations and non-essentials. Let them prove intent.

---

### Example B — Logged-in user, 8 calls, 2 items in cart
```
weightBase:              30   (browse-block)
method GET:              +0
authenticated:           +10
callCount 8:             +10
2 cart items:            +15
no MoV match:            +0
no tier:                 +0
no override:             +0
────────────────────────────
finalWeight:             65   → SERVE FULLY (at threshold exactly)
```
This engaged buyer with cart items just clears the threshold.
Correct — they deserve full service.

---

### Example C — Premium user browsing
```
weightBase:              30   (browse-block)
method GET:              +0
authenticated:           +10
callCount 3:             +5
1 cart item:             +15
no MoV match:            +0
premium tier:            +40
no override:             +0
────────────────────────────
finalWeight:             100  → SERVE FULLY (capped)
```
Premium user always protected. Correct.

---

### Example D — Anonymous user, full Moment of Value match
```
weightBase:              30   (browse-block)
method GET:              +0
anonymous:               +0
callCount 9:             +10
3 cart items:            +25
full MoV match:          +30
no tier:                 +0
no override:             +0
────────────────────────────
finalWeight:             95   → SERVE FULLY
```
Most important case. Anonymous user — no login, no tier.
But Shadow Mode's signature says this session is about to convert.
CHAKRA protects them completely.
This is what makes CHAKRA intelligent rather than just mechanical.

---

### Example E — Logged-in user, shallow session, no cart
```
weightBase:              30   (browse-block)
method GET:              +0
authenticated:           +10
callCount 2:             +0
no cart:                 +0
no MoV match:            +0
no tier:                 +0
no override:             +0
────────────────────────────
finalWeight:             40   → SERVE LIMITED (at low threshold)
```
Known user but no strong signals. Gets a real response
but CHAKRA hints to backend to return lighter payload.
Fair treatment — not suspended, not fully served.

---

## 5. WEIGHT THRESHOLDS — DEVELOPER CONFIGURABLE

```yaml
# chakra.config.yaml

weight_engine:

  # Decision thresholds
  serve_fully_threshold:   65    # weight >= this → Serve Fully
  serve_limited_threshold: 40    # weight >= this → Serve Limited
                                 # weight < 40    → Suspend

  # User tier header configuration
  user_tier:
    header: "X-User-Tier"        # which header carries tier info
    tiers:
      standard:  0               # no bonus
      premium:   40              # premium bonus
      enterprise: 50             # enterprise bonus

  # Optional: tune individual signal contributions
  signal_tuning:
    cart_items_high: 30          # default 25 — increase for cart-heavy apps
    moment_of_value_full: 30     # default — increase if Shadow Mode is mature
    premium_tier: 40             # default — increase to 60 to guarantee
                                 # premium users always fully served

  # Optional: suppress Weight Engine entirely for specific blocks
  # (blocks with minimum_level 0 bypass Weight Engine already)
  bypass_weight_engine:
    - "payment-block"            # already bypassed via minLevel 0
```

Developers who want strict degradation can raise thresholds.
Developers who want aggressive protection can lower them.
The defaults are calibrated to be sensible for most e-commerce apps.

---

## 6. EDGE CASES

### No Session Context Available
Session not in cache — new session, first request, cache evicted.

```
Fallback: use request-only signals only.

finalWeight = weightBase
            + methodSignal
            + authSignal
            (all session signals return +0)
```

Conservative. Lower weight. More likely to suspend.
Correct — we know nothing about this session yet.
Shadow Mode will build context over the next few requests.

---

### Session Context Stale
Last seen time > 30 minutes ago — session expired in cache.
Treat as no session context. Same fallback as above.

---

### Minimum Level Override
If Ring Map says block has minimum_level: 0 —
Weight Engine is never called. Block cannot be suspended.
Dispatcher handles this in Step 4 before reaching Step 5.

---

### Negative Developer Override
Developer sets a negative override for a specific endpoint:
```yaml
"GET /api/internal/debug":  -100   # always suspend this endpoint
```
finalWeight can go negative. Any weight < 0 treated as 0 → Suspend.

---

## 7. PERFORMANCE REQUIREMENTS

Weight Engine budget from CP4: **under 0.5ms**

All operations:
- In-memory reads from Session Context Cache
- Simple arithmetic (addition, comparison, min/max)
- Header reads from request object (already in memory)
- Array lookups for signal tier tables

No external calls. No database. No network.

Estimated actual performance: **0.1–0.2ms**
Well within budget even under high concurrency.

---

## 8. WHAT NEEDS TO BE BUILT

### Component: Weight Calculator
Core calculation logic.
Takes context package from Dispatcher.
Applies all 8 signals in sequence.
Returns finalWeight (0–100).
Pure function — same inputs always produce same output.
Easily testable.

### Component: Signal Library
Each signal is a separate, independently testable function:
```
calculateMethodSignal(method)         → number
calculateAuthSignal(isAuthenticated)  → number
calculateSessionDepthSignal(count)    → number
calculateCartStateSignal(items)       → number
calculateMoVSignal(strength)          → number
calculateTierSignal(tier, config)     → number
applyDeveloperOverride(path, config)  → number
```
Modular. Each signal can be tuned or replaced independently.
New signals can be added without touching the calculator core.

### Component: Weight Config Reader
Reads threshold and tuning config from strategy config.
Caches in memory. Updates on live config changes.
Provides config to Weight Calculator on each call.

---

## 9. DESIGN DECISIONS MADE

1. **Additive layered formula, not multiplicative.**
   Addition is transparent and predictable.
   Developer can reason about why a specific weight score
   was produced. Multiplicative formulas create non-intuitive
   results that are hard to debug and tune.

2. **8 signals, each independently tunable.**
   Not a black box. Each signal has a clear, explainable
   reason. Developer can increase or decrease any signal's
   contribution to match their business priorities.

3. **Moment of Value signal is the most powerful.**
   Shadow Mode's intelligence feeds directly here.
   As Shadow Mode learns more conversion patterns,
   this signal becomes increasingly accurate and valuable.
   The Weight Engine gets smarter as the system matures.

4. **No session context → conservative fallback.**
   Unknown sessions get lower weights. Correct behaviour —
   protect users we know are valuable, be cautious with
   users we know nothing about.

5. **Developer override is additive, not replacement.**
   Developer bonus adds to the calculated score —
   it does not replace the calculation entirely.
   This preserves the intelligence of other signals
   while allowing precise manual tuning.

6. **Weight Engine is a pure function.**
   Same inputs always produce same output.
   No internal state. No side effects.
   Trivially testable. Easy to reason about.
   Easy to debug when a weight seems wrong.

7. **Thresholds are configurable but default to sensible values.**
   65 / 40 defaults work well for most e-commerce apps.
   Teams with different needs can tune without touching code.

8. **New signals can be added without breaking existing behaviour.**
   Modular signal library means future signals (time-of-day,
   geographic priority, device type, etc.) can be added
   as new additive layers without changing the existing formula.

---

## 10. FUTURE SIGNAL IDEAS (NOT IN V1)

Signals worth considering for future versions:

```
Time proximity signal:
  "This endpoint is only called in the final 60 seconds
   before checkout historically."
  → High weight during that window

Device type signal:
  Mobile users completing checkout → higher weight
  (mobile checkout abandonment is costlier)

Geographic priority signal:
  Developer marks certain regions as higher priority
  during events targeting specific markets

Return user signal:
  User has completed a purchase before → +15
  (proven buyer, worth protecting)

Recency signal:
  Session started within last 5 minutes → +5
  (fresh session, high engagement window)
```

All additive. All independently tunable. Can be added in v2+
without changing the v1 formula or existing behaviour.

---

## 11. NEXT CHECKPOINT

**CP6 — Middleware Package**
Covers: How CHAKRA is packaged as an installable middleware.
Framework integration for Node.js (Express, Fastify), Python
(FastAPI, Django, Flask), and Java (Spring Boot).
The install experience. How all components wire together.
What the developer does from npm install to first active CHAKRA.

---

## CONNECTIONS TO OTHER CHECKPOINTS

```
CP1 (Shadow Mode)      → Provides Moment of Value signatures.
                         Writes session context to cache.
                         Both feed Weight Engine's most powerful signals.

CP3 (Ring Mapper)      → Provides weightBase and endpointWeightOverride
                         for each block/endpoint combination.

CP4 (Dispatcher)       → Calls Weight Engine in Step 5.
                         Receives finalWeight back.
                         Uses it against thresholds for final decision.

CP7 (Policy Engine)    → Runs after Weight Engine in Step 6.
                         Policy can override regardless of weight score.
                         (e.g. premier user policy overrides even if
                          Weight Engine score is low for some reason)

CP8 (Dashboard)        → Shows weight score distribution in analytics.
                         "X% of requests were rescued by weight override."
                         "Moment of Value signal rescued Y sessions today."
```

---

*Checkpoint 5 created during Weight Engine design session.*
*Previous: CHAKRA_CP4_Dispatcher.md*
*Next: CHAKRA_CP6_Middleware.md*
