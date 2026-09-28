# PROJECT CHAKRA
## Checkpoint 7 — Policy Engine
### Status: DISCUSSION COMPLETE → READY TO BUILD
### Position in Build Order: SEVENTH
### Depends on: CP1, CP2, CP2.5, CP3, CP4, CP5, CP6

---

## What The Policy Engine Does — One Sentence

> Evaluate developer-written rules against each request
> to enforce explicit business logic — the final layer
> of intelligence before the Dispatcher makes its
> routing decision.

---

## 1. WHERE IT SITS — AND WHY

The Policy Engine runs in Step 6 of the Dispatcher.
By this point:
- The block is suspended at current RPM level (Step 4)
- The Weight Engine scored the request below full-override
  threshold (Step 5)

The Policy Engine is the last chance to rescue a request —
or to enforce a business rule that weight scoring alone
cannot express.

```
Dispatcher Step 5: Weight Engine → score below threshold
                                          ↓
                              Policy Engine called here (Step 6)
                                          ↓
                   Matching rule found? → execute action
                   No matching rule?   → Dispatcher makes default decision
                                         (Suspend or Serve Limited
                                          based on weight score)
```

---

## 2. WEIGHT ENGINE VS POLICY ENGINE — THE KEY DISTINCTION

These two components do fundamentally different things.
Understanding the distinction is critical for the coding agent.

```
Weight Engine:
  Calculates HOW VALUABLE this request is
  based on automatically observable signals.
  Implicit. Automatic. Mathematical.
  Example: "This session has 3 cart items and matches
  MoV signature, therefore weight = 85."

Policy Engine:
  Enforces WHAT THE BUSINESS EXPLICITLY WANTS.
  Regardless of signals or calculations.
  Explicit. Deliberate. Rule-based.
  Example: "Premier users always get full service.
  Period. No calculation needed."
```

The Weight Engine is CHAKRA being intelligent.
The Policy Engine is the developer being intentional.
Both are needed. Neither replaces the other.

---

## 3. POLICY RULE STRUCTURE

Every policy rule has exactly four parts:

```yaml
- name: "human-readable-identifier"   # for logging and dashboard
  if:                                  # condition(s) — AND logic
    [condition fields]
  then:                                # action to take
    action: "[action type]"
    [action parameters]
  priority: [number]                   # higher = evaluated first
```

---

## 4. THE FULL CONDITION SYSTEM

All condition fields are optional.
Multiple fields within one rule = AND logic (all must be true).
OR logic = write multiple rules with same action.

### User Conditions
```yaml
user_tier: "premium"                    # header matches configured tier
user_tier_in: ["premium", "enterprise"]
is_authenticated: true
is_authenticated: false
session_depth_above: 5                  # callCount > 5
session_depth_below: 2                  # callCount < 2
has_cart_items: true
has_cart_items: false
cart_items_above: 2                     # 3 or more items
moment_of_value: "full"                 # full MoV signature match
moment_of_value: "partial"
moment_of_value_any: true               # partial or full
```

### Request Conditions
```yaml
method: "POST"
method_in: ["POST", "PUT", "PATCH", "DELETE"]
path_matches: "/api/checkout/*"         # wildcard path match
path_exact: "/api/payment/process"
block: "search-block"                   # request belongs to this block
block_in: ["browse-block", "search-block"]
block_not: ["payment-block", "auth-block"]  # all blocks EXCEPT these
```

### Load Conditions
```yaml
rpm_above: 65                           # current global RPM
rpm_below: 40
rpm_between: [55, 80]
block_rpm_above: 78                     # per-block RPM from CP2
block_rpm_below: 50
error_rate_above: 2.0                   # current error rate %
latency_p95_above_ms: 600
```

### Time Conditions
```yaml
time_between: ["09:00", "18:00"]        # in app's configured timezone
day_of_week_in: ["saturday", "sunday"]
day_of_week_not_in: ["saturday", "sunday"]
```

Time conditions are useful for planned events:
"During our Friday 12:00–15:00 sale, apply this rule."

---

## 5. THE FULL ACTION SYSTEM

### serve_fully
Override suspension. Request passes to backend unchanged.
```yaml
then:
  action: "serve_fully"
```

### serve_limited
Pass request to backend with context headers injected.
Backend returns lighter response.
```yaml
then:
  action: "serve_limited"
  hint: "use-cache"          # X-Chakra-Hint header value
  # available hints:
  #   use-cache
  #   omit-heavy-data
  #   paginate-aggressively
  #   minimal-response
  # developer can define custom hints — backend reads them
```

### suspend
Intercept request. Return fallback directly from CHAKRA.
```yaml
then:
  action: "suspend"
  response: "empty"          # {} or []
  # OR
  response: "cached"         # last cached response for this endpoint
  cache_max_age_seconds: 300
  # OR
  response: "static"
  static_body: '{"items":[],"message":"Service temporarily limited"}'
  static_status: 200
  # OR
  response: "503"
```

### redirect
Forward request to a different endpoint.
Useful for cache-layer or static fallback endpoints.
```yaml
then:
  action: "redirect"
  to: "/api/products/cached-listing"
  method: "GET"              # optional — override original method
```

### rate_limit
Allow but throttle per session.
```yaml
then:
  action: "rate_limit"
  max_per_minute: 30         # per session
  when_exceeded:
    action: "suspend"
    response: "static"
    static_body: '{"error":"Rate limited during high traffic"}'
    static_status: 429
```

---

## 6. PRIORITY — HOW CONFLICTS RESOLVE

Higher priority number = evaluated first = wins on conflict.

```
Priority evaluation order:
  All rules sorted by priority (descending) at compile time.
  On each request: iterate in order, first match wins, stop.

Example:
  Rule A: premier users    → serve_fully    priority: 100
  Rule B: rpm_above 95     → suspend all    priority: 50

  Premier user during RPM 97:
    Rule A evaluated (priority 100): user_tier matches → serve_fully
    Rule B never reached for this request.
    Result: Premier user served fully. ✅

Same priority conflict:
  If two rules have equal priority and both match:
  First rule in config file wins.
  Dashboard shows a warning: "Priority conflict detected between
  rule X and rule Y — consider adjusting priorities."
```

---

## 7. POLICY EVALUATION PERFORMANCE

Policy Engine budget from CP4: **under 0.5ms**

Rules are pre-compiled at startup — not parsed from YAML on each request.

```
AT STARTUP:
  Parse policy rules from config
  Sort by priority (descending)
  Compile each condition into a fast predicate function
  Store as ordered array of compiled rule objects:

  compiledRules = [
    { name: "premier-users", predicate: fn(ctx), action: "serve_fully" },
    { name: "protect-checkout", predicate: fn(ctx), action: "serve_fully" },
    ...
  ]

AT REQUEST TIME (Step 6):
  Iterate compiledRules array in order
  For each rule: call predicate(requestContext) → true/false
  First true → execute action → return immediately
  Exhausted all rules with no match → return null

Performance:
  Per-rule evaluation: ~0.01ms (simple boolean operations)
  10 rules:  ~0.1ms  ✅ well within budget
  50 rules:  ~0.5ms  ✅ at budget limit
  100 rules: ~1.0ms  ⚠️ approaching limit — warn developer in dashboard
```

---

## 8. COMPLETE POLICY EXAMPLES — REAL COMPANY CONFIGS

---

### E-commerce Company
```yaml
policies:

  - name: "premier-users-always-served"
    if:
      user_tier: "premium"
    then:
      action: "serve_fully"
    priority: 100

  - name: "protect-mid-checkout"
    if:
      moment_of_value: "full"
    then:
      action: "serve_fully"
    priority: 95

  - name: "protect-cart-with-items"
    if:
      cart_items_above: 2
      session_depth_above: 4
    then:
      action: "serve_fully"
    priority: 90

  - name: "cache-search-on-moderate-load"
    if:
      block: "search-block"
      rpm_above: 65
    then:
      action: "serve_limited"
      hint: "use-cache"
    priority: 70

  - name: "suspend-ads-early"
    if:
      block: "ads-block"
      rpm_above: 45
    then:
      action: "suspend"
      response: "empty"
    priority: 60

  - name: "emergency-checkout-only"
    if:
      rpm_above: 92
      block_not: ["payment-block", "cart-block", "auth-block"]
    then:
      action: "suspend"
      response: "static"
      static_body: '{"message":"High traffic — some features temporarily limited"}'
    priority: 50
```

---

### Banking App
```yaml
policies:

  - name: "never-suspend-auth"
    if:
      block: "auth-block"
    then:
      action: "serve_fully"
    priority: 100

  - name: "never-suspend-payment"
    if:
      block: "payment-block"
    then:
      action: "serve_fully"
    priority: 100

  - name: "suspend-statements-on-any-load"
    if:
      block: "statements-block"
      rpm_above: 50
    then:
      action: "suspend"
      response: "static"
      static_body: '{"message":"Statement download temporarily unavailable"}'
    priority: 80

  - name: "rate-limit-reports-under-stress"
    if:
      block: "reports-block"
      rpm_above: 65
    then:
      action: "rate_limit"
      max_per_minute: 5
      when_exceeded:
        action: "suspend"
        response: "503"
    priority: 70
```

---

### Gaming Platform
```yaml
policies:

  - name: "never-interrupt-active-game"
    if:
      block: "game-session-block"
    then:
      action: "serve_fully"
    priority: 100

  - name: "protect-matchmaking"
    if:
      block: "matchmaking-block"
    then:
      action: "serve_fully"
    priority: 95

  - name: "suspend-replays-on-load"
    if:
      block: "replay-block"
      rpm_above: 70
    then:
      action: "suspend"
      response: "static"
      static_body: '{"available":false,"reason":"high_traffic"}'
    priority: 60

  - name: "weekend-cache-store"
    if:
      block: "store-block"
      day_of_week_in: ["saturday", "sunday"]
      rpm_above: 60
    then:
      action: "serve_limited"
      hint: "use-cache"
    priority: 50
```

---

## 9. LIVE POLICY EDITING — NO RESTART REQUIRED

Policies must be editable at any time — especially during
a live incident. Redeployment during a crisis is unacceptable.

```
Edit flow:

  Developer edits policy in Dashboard policy editor
  (or edits chakra.config.yaml directly — file watcher picks it up)
        ↓
  CHAKRA validates new policy set
  Error? → Show clear error in dashboard. Current policies unchanged.
  Valid? → Continue.
        ↓
  New policy set compiled into predicate array
        ↓
  Atomic pointer swap (same pattern as CP4 — CP3)
  New policies active within next evaluation cycle (< 5 seconds)
        ↓
  Dashboard confirms: "Policies updated — active since 14:32:07"
        ↓
  Audit log entry created with full diff of what changed
```

During a live Friday sale incident, an ops engineer can add
an emergency rule in the dashboard and it is active
within 5 seconds. No restart. No redeployment.

---

## 10. SHADOW MODE POLICY SUGGESTIONS

Shadow Mode (CP1) generates policy suggestions based on learned patterns.
These surface in the dashboard as reviewable, one-click-activatable rules.

```
Dashboard — Policy Suggestions from Shadow Mode:

─────────────────────────────────────────────────────
SUGGESTION 1  (confidence: HIGH — 30 days data)
  Observation: Sessions with 3+ cart items account for
               67% of all conversions.
  Suggested rule:
    name: "protect-high-cart-sessions"
    if: { cart_items_above: 2 }
    then: { action: "serve_fully" }
    priority: 88

  [ ✓ Activate ]  [ ✎ Modify ]  [ ✗ Dismiss ]

─────────────────────────────────────────────────────
SUGGESTION 2  (confidence: MEDIUM — 30 days data)
  Observation: /api/recommendations is never called in
               sessions that completed a purchase.
  Suggested rule:
    name: "suspend-recs-on-moderate-load"
    if: { block: "recommendations-block", rpm_above: 45 }
    then: { action: "suspend", response: "empty" }
    priority: 65

  [ ✓ Activate ]  [ ✎ Modify ]  [ ✗ Dismiss ]

─────────────────────────────────────────────────────
SUGGESTION 3  (confidence: HIGH — from stress event Mar 15)
  Observation: During observed stress event, search block
               degraded 4 minutes before checkout failures.
               Protecting search earlier would have
               prevented the cascade.
  Suggested rule:
    name: "cache-search-before-cascade"
    if: { block: "search-block", block_rpm_above: 72 }
    then: { action: "serve_limited", hint: "use-cache" }
    priority: 75

  [ ✓ Activate ]  [ ✎ Modify ]  [ ✗ Dismiss ]
─────────────────────────────────────────────────────
```

Developer reviews. Activates what they trust.
CHAKRA never auto-activates suggestions. Human always approves.

---

## 11. EMERGENCY PRESETS — MANUAL MODE WAR ROOM

For Manual Mode operators during a live incident —
typing full YAML rules is too slow.

Developer pre-defines emergency preset rules in config.
Dashboard shows them as one-click buttons.

```yaml
# chakra.config.yaml

emergency_presets:

  - name: "Suspend Non-Essential"
    icon: "⚡"
    policies:
      - name: "_emergency_suspend_non_essential"
        if: { block_in: ["recommendations-block", "ads-block", "social-block"] }
        then: { action: "suspend", response: "empty" }
        priority: 999          # highest priority — overrides everything

  - name: "Checkout-Only Mode"
    icon: "🔒"
    policies:
      - name: "_emergency_checkout_only"
        if: { block_not: ["payment-block", "cart-block", "auth-block"] }
        then: { action: "suspend", response: "static",
                static_body: '{"message":"High traffic period"}' }
        priority: 999

  - name: "Cache Everything"
    icon: "🐢"
    policies:
      - name: "_emergency_cache_all"
        if: { rpm_above: 0 }    # matches everything when active
        then: { action: "serve_limited", hint: "use-cache" }
        priority: 999

  - name: "Restore All"
    icon: "↩"
    action: "remove_all_emergency_policies"
```

In dashboard during incident:
```
EMERGENCY CONTROLS:
[ ⚡ Suspend Non-Essential ]  [ 🔒 Checkout-Only Mode ]
[ 🐢 Cache Everything ]       [ ↩ Restore All ]
```

One click. Active within 5 seconds. Logged with operator identity.

---

## 12. POLICY AUDIT LOG

Every policy change and every policy-driven routing decision
is logged. Full audit trail.

```
Policy Audit Log:

[14:31:02]  POLICY ACTIVATED
            Rule: "premier-users-always-served"
            Activated by: ops-engineer@company.com (dashboard)

[14:32:07]  POLICY TRIGGERED
            Rule: "protect-mid-checkout"
            Request: POST /api/cart/add
            Session: hashed_xyz (mid-checkout)
            Action: serve_fully (override applied)

[14:33:45]  POLICY UPDATED (live edit)
            Changed by: ops-engineer@company.com
            Rule: "cache-search-on-moderate-load"
            Change: rpm_above threshold 65 → 55
            Previous config archived as v3.

[14:45:00]  EMERGENCY PRESET ACTIVATED
            Preset: "Checkout-Only Mode"
            Activated by: senior-sre@company.com
            Duration: active

[15:02:30]  EMERGENCY PRESET DEACTIVATED
            Preset: "Checkout-Only Mode" → "Restore All"
            Duration was: 17 minutes 30 seconds
```

This log is visible in the dashboard. Exportable.
Developer and ops teams can review exactly what CHAKRA did
and why during any incident.

---

## 13. WHAT NEEDS TO BE BUILT

### Component: Policy Compiler
Reads policy rules from config at startup (and on live updates).
Validates syntax and condition fields.
Sorts by priority.
Compiles each condition into a fast predicate function.
Outputs ordered compiled rule array.

### Component: Policy Evaluator
Iterates compiled rules on each request (Step 6 of Dispatcher).
Takes request context package (same as Weight Engine input).
Returns first matching rule's action — or null if no match.
Must complete in < 0.5ms for up to 50 rules.

### Component: Policy Config Watcher
Watches chakra.config.yaml for changes (file system watcher).
Also watches for changes saved via dashboard API.
Triggers Policy Compiler on change.
Atomic swap of compiled rule array.

### Component: Emergency Preset Manager
Stores developer-defined emergency presets.
Activates/deactivates preset rule sets via dashboard button.
Injects emergency rules at priority 999 (always evaluated first).
Removes them cleanly on deactivation.

### Component: Policy Audit Logger
Logs every policy activation, deactivation, live edit,
and policy-triggered routing decision.
Writes to persistent log file + exposes via dashboard API.

### Component: Shadow Mode Policy Suggester
Receives pattern data from Shadow Mode Analyser (CP1).
Formats patterns as reviewable policy rule suggestions.
Exposes suggestions via dashboard API.
On developer approval: adds rule to active policy set.

---

## 14. DESIGN DECISIONS MADE

1. **Policies are explicit, not inferred.**
   The Policy Engine enforces what the developer deliberately
   writes. Not what CHAKRA calculates or infers.
   Developer intent is always respected over algorithm output.

2. **Priority system is simple and transparent.**
   Higher number wins. Conflicts flagged in dashboard.
   No black-box rule interaction. Developer always knows
   which rule is going to fire for a given scenario.

3. **Live editing without restart — non-negotiable.**
   During a live incident, redeployment is not an option.
   Policy changes must be active within 5 seconds of save.
   This drives the file-watcher + atomic-swap architecture.

4. **Emergency presets are developer-defined.**
   CHAKRA does not decide what "emergency mode" means.
   The developer defines their own emergency scenarios once.
   Ops team activates them with one click during incidents.

5. **Suggestions never auto-activate.**
   Shadow Mode suggestions are advisory only.
   Human approval always required before any rule goes live.

6. **Policy Engine returns null on no match.**
   It does not make a default decision.
   The Dispatcher makes the default decision based on weight score.
   Clean separation of concerns — Policy Engine only acts when
   a rule explicitly matches.

7. **Audit log is permanent and exportable.**
   Every change, every trigger logged with timestamp and context.
   This is what makes CHAKRA trustworthy in enterprise environments
   where decisions need to be defensible and reviewable.

8. **Rule count performance warning at 100 rules.**
   Dashboard warns developer if policy set grows beyond 100 rules.
   Encourages consolidation. Keeps evaluation within budget.

---

## 15. NEXT CHECKPOINT

**CP8 — Dashboard**
Covers: The web UI that is the developer's primary interface
to all of CHAKRA. What it shows, how it is organised,
what the developer can do from it. Shadow Mode learning view,
Ring Map visualiser, live RPM, policy editor, activation controls,
audit log.

---

## CONNECTIONS TO OTHER CHECKPOINTS

```
CP1 (Shadow Mode)      → Generates policy suggestions.
                         Moment of Value data used in conditions.

CP2 (RPM Engine)       → rpm_above / rpm_below / block_rpm_above
                         conditions read from RPM State Store.

CP2.5 (Activation)     → Emergency presets interface with
                         manual activation controls.

CP3 (Ring Mapper)      → block / block_in / block_not conditions
                         reference block names from Ring Map.

CP4 (Dispatcher)       → Calls Policy Engine in Step 6.
                         Receives action result, executes it.

CP5 (Weight Engine)    → Runs before Policy Engine (Step 5).
                         Policy Engine is last-chance override
                         after weight calculation.

CP6 (Middleware)       → Policy Engine packaged inside core/.
                         policy-engine.js component.

CP8 (Dashboard)        → Policy editor UI.
                         Emergency preset controls.
                         Policy suggestions from Shadow Mode.
                         Audit log display.
```

---

*Checkpoint 7 created during Policy Engine design session.*
*Previous: CHAKRA_CP6_Middleware.md*
*Next: CHAKRA_CP8_Dashboard.md*
