# PROJECT CHAKRA
## Checkpoint 1 — Shadow Mode (The Silent Student)
### Status: DISCUSSION COMPLETE + UPDATED → READY TO BUILD
### Position in Build Order: FIRST — runs before everything else

---

## Why This Comes First

Shadow Mode is the **entry point** into CHAKRA. When a developer installs
the CHAKRA package, the very first thing that activates is Shadow Mode.
Nothing else runs yet. No routing. No policies. No interference.

Shadow Mode runs silently and collects. Everything else in CHAKRA is
built on top of what Shadow Mode learns.

Install CHAKRA → Shadow Mode ON → (weeks pass) → Data collected →
Ring Map suggested → Policies suggested → Developer approves →
CHAKRA goes active.

This ordering matters because:
- It gives value on Day 1 (developer sees their app being mapped)
- It creates zero risk (nothing changes in production)
- It earns trust before asking for control
- It means CHAKRA's first active decisions are already informed,
  not blind guesses

---

## 1. THE ONE ABSOLUTE RULE OF SHADOW MODE

> Shadow Mode observes. It never touches a request.
> It never changes a response. It has zero side effects.

Not even during a crash. Not even if it detects something critical.
Even if it "knows" what should happen — it only watches.

This rule makes Shadow Mode safe to deploy in ANY production environment
from Day 1. A company can run it for months before activating a single
policy. Zero risk to their live traffic. Zero performance overhead
on the request path itself (observation happens async, not inline).

---

## 2. WHAT SHADOW MODE IS ACTUALLY LEARNING

Learning happens in 4 progressive layers. Each layer requires more
time and more data than the previous one.

---

### LEARNING LAYER 1 — App Structure
**Time to learn: Hours (within first day)**

```
What it observes:
  - Every endpoint that receives traffic (URL + HTTP method)
  - Call frequency per endpoint
  - Which endpoints are called together in the same session
  - Read vs write classification (GET vs POST/PUT/DELETE)
  - Response size patterns per endpoint
  - Authentication requirements (which endpoints need a token)

What it produces:
  - Initial endpoint inventory
  - First draft of Block groupings
    (endpoints called together → likely belong in same Block)
  - Preliminary level suggestions based on call frequency
    (rarely called + read-only → likely outer level)
    (always called + write → likely inner level)
```

---

### LEARNING LAYER 2 — Traffic Patterns
**Time to learn: Days to weeks**

```
What it observes:
  - Time-of-day traffic distribution (morning spike, evening spike)
  - Day-of-week patterns (weekends vs weekdays)
  - Weekly rhythm of load (when is RPM typically high vs low)
  - Traffic ramp patterns (gradual climb vs sudden spike)
  - Baseline "normal" RPM for this application

What it produces:
  - RPM baseline established (what does 0–100 mean for THIS app)
  - Historical RPM chart (developer can see their own load patterns)
  - Predicted high-risk windows
    ("Friday 8–10 PM is historically your highest load period")
  - First RPM threshold suggestions
    ("Your system historically shows stress signals above RPM 62")
```

---

### LEARNING LAYER 3 — User Behaviour Profiles
**Time to learn: Weeks**

```
What it observes:
  - Anonymous vs authenticated session patterns
  - User tier signals (premier vs regular — if inferable from headers/tokens)
  - Session journey paths (which endpoints in what sequence)
  - Session depth (how many API calls in an average session)
  - Device/client type patterns (mobile vs desktop endpoint differences)
  - Drop-off points (where do sessions end before converting)
  - Conversion journeys (what does a completed purchase session look like)

What it produces:
  - "Moment of Value" session signatures (see Section 4)
  - User tier → weight mapping suggestions
  - Journey-aware policy suggestions
    ("Users who reach /cart/confirm convert at high rate — protect this endpoint")
  - Session depth thresholds
    ("Sessions with 5+ calls are 3x more likely to convert")
```

---

### LEARNING LAYER 4 — Failure Signatures
**Time to learn: Requires at least one high-stress event**
**Most valuable layer. Only real traffic teaches this.**

```
What it observes during high-load events:
  - RPM at first sign of degradation (latency climbing)
  - Which endpoint degrades first (the weakest link)
  - Cascade sequence (A slows → B backs up → C times out → crash)
  - Time between first signal and full degradation
  - Which user journeys were interrupted and at what stage
  - Which endpoints remained stable even during chaos
    (these are the true resilient core — actual Level 0)
  - Recovery pattern (what sequence did endpoints recover in?)

What it produces:
  - Exact RPM thresholds validated by real failure data
    (not guesses — actual measured breaking points)
  - Corrected Ring Map
    ("Your checkout degrades at RPM 71, not 80 as we initially estimated")
  - Updated policy suggestions with failure-validated triggers
  - Cascade prevention rules
    ("If /search latency exceeds 800ms, it signals impending checkout failure.
      Suspend search early to prevent cascade.")
  - A failure anatomy report the developer can read
    (human-readable post-mortem generated automatically)
```

---

## 3. THE PROGRESSIVE LEARNING TIMELINE

```
DAY 1 — INSTALL
  Shadow Mode activates.
  Starts building endpoint inventory.
  Developer sees dashboard: "CHAKRA is learning your application."
  First block groupings appear within hours.

WEEK 1
  Basic Ring Map draft ready for developer review.
  Endpoint inventory complete.
  First weight suggestions based on URL patterns + method types.
  Dashboard shows: "We've identified 4 blocks in your application."

MONTH 1
  Traffic patterns established.
  RPM baseline defined for this specific application.
  Historical load chart visible in dashboard.
  First RPM threshold suggestions appear.
  Dashboard shows: "We suggest activating Level 1 at RPM 58."

FIRST HIGH-STRESS EVENT (sale day / viral moment / anything that strains the app)
  Even if the app crashes — especially if it crashes.
  Learning Layer 4 activates fully.
  Failure anatomy captured.
  Ring Map refined with real breaking point data.
  New policy suggestions generated automatically.
  Dashboard shows: "We observed a stress event. Here is what we learned.
                   We have 3 new policy suggestions based on this event."

MONTH 3+
  Moment of Value signatures refined.
  User behaviour profiles deepened.
  CHAKRA's suggestions become highly specific to this application.
  System is now deeply calibrated to this app's unique behaviour.

ONGOING — FOREVER
  Shadow Mode never stops.
  Even after CHAKRA goes fully active, Shadow Mode keeps observing.
  New endpoints added to the app → automatically discovered.
  Traffic patterns shift → Shadow Mode notices and updates suggestions.
  New failure signatures → captured and learned from.
  The system never stops getting smarter.
```

---

## 4. MOMENT OF VALUE — THE KEY INTELLIGENCE

This is one of the most original capabilities of Shadow Mode.

**The idea:**
A user in the middle of completing a payment is worth protecting — everyone
knows this intuitively. But Shadow Mode learns this *quantitatively*, for
each specific application.

**How it works:**
Shadow Mode observes completed purchase sessions over time.
It identifies the pattern of API calls that reliably precede a conversion.

Example pattern it might discover:
```
GET  /products/{id}        → (viewed product)
POST /cart/add             → (added to cart)
GET  /cart                 → (reviewed cart)
POST /cart/apply-coupon    → (applied coupon — strong intent signal)
GET  /checkout/summary     → (viewing checkout)
                           → CONVERSION IMMINENT
POST /checkout/confirm     → (completing purchase)
POST /payment/process      → (payment)
```

Shadow Mode learns that any session matching this sequence
(or a significant portion of it) has a very high probability of converting.

**During a surge, when CHAKRA is active:**
Any live session that matches this signature pattern gets automatically
elevated weight — even if the user is technically on a "low priority"
endpoint at that exact moment.

CHAKRA knows they are about to convert. It protects them.

This is the difference between a dumb circuit breaker (treats all users
equally) and an intelligent system (knows which users are in critical
moments).

---

## 5. WHAT SHADOW MODE PRODUCES — THE THREE OUTPUTS

All observation eventually produces three deliverables.
These feed directly into CHAKRA's active layers.

```
OUTPUT 1: Suggested Ring Map
  "Based on X days of observation, here is how we suggest
   organizing your endpoints into blocks and levels.
   You have 4 blocks. Here is our suggested level assignment."
  → Developer reviews → edits if needed → approves
  → Becomes the active Ring Map (CP2)

OUTPUT 2: Suggested RPM Thresholds
  "Based on your traffic history and failure patterns:
   Activate Level 1 at RPM 58
   Activate Level 2 at RPM 74
   Activate Level 3 at RPM 89"
  → Developer reviews → adjusts if needed → approves
  → Becomes the RPM Engine's threshold config (CP2 RPM Engine)

OUTPUT 3: Suggested Policy Rules
  "Based on user behaviour analysis, we suggest these policies:
   Rule 1: Protect sessions with Moment of Value signature
   Rule 2: Premier users always served at Level 0
   Rule 3: Suspend recommendations block at RPM 58
   Rule 4: Cache search results above RPM 74"
  → Developer reviews each rule → activates what they want
  → Becomes the active Policy Engine rules (CP7)
```

**Important:** CHAKRA never auto-activates policies without human approval.
Shadow Mode suggests. The developer decides. Always.

---

## 6. WHAT NEEDS TO BE BUILT

### Component: Shadow Mode Observer Agent

**What it is:**
A lightweight, async process that runs inside the CHAKRA middleware.
Hooks into the request/response lifecycle but runs completely
out-of-band — it never adds latency to the request itself.

**What it captures per request:**
```javascript
{
  timestamp: "2026-03-24T12:00:00Z",
  sessionId: "hashed_session_token",   // hashed, never raw token
  userId: "hashed_user_id",            // hashed if present, null if anonymous
  method: "POST",
  endpoint: "/api/cart/add",
  normalizedEndpoint: "/api/cart/:id", // parameterized form for grouping
  responseTimeMs: 142,
  statusCode: 200,
  requestSize: 240,
  responseSize: 1820,
  userAgent: "mobile/ios",             // device class only
  isAuthenticated: true,
  sessionDepth: 4                      // how many calls in this session so far
}
```

**What it does NOT capture:**
```
- Request body contents (privacy)
- Response body contents (privacy)
- Raw session tokens (security)
- Raw user IDs (privacy — always hashed)
- Any PII whatsoever
```

Privacy is non-negotiable. Shadow Mode learns about behaviour patterns,
not about individual users.

---

### Component: Pattern Analyser

**What it is:**
Processes the raw observation data and runs analysis jobs.
Not real-time — runs on a schedule (every hour, every day).

**Jobs it runs:**
```
Hourly:
  - Update endpoint inventory
  - Recalculate current RPM baseline
  - Update traffic pattern models

Daily:
  - Re-cluster endpoints into block suggestions
  - Update user journey path analysis
  - Refresh Moment of Value signatures
  - Check for new endpoints added to the app

After stress events (triggered by RPM spike + error rate spike):
  - Run failure anatomy analysis
  - Generate failure report
  - Produce updated Ring Map suggestions
  - Generate new policy suggestions
  - Notify developer via dashboard
```

---

### Component: Shadow Mode Dashboard View

**What developer sees:**
```
CHAKRA SHADOW MODE — Day 14 of observation

Learning Progress:
  ✅ App Structure       (complete — 47 endpoints discovered, 4 blocks identified)
  ✅ Traffic Patterns    (complete — 14 days of data)
  🔄 User Profiles       (in progress — need more conversion events)
  ⏳ Failure Signatures  (waiting — no stress event observed yet)

Ready for Review:
  → Ring Map suggestion ready     [ Review ]
  → RPM thresholds ready          [ Review ]
  → 3 policy suggestions ready    [ Review ]

Observations so far:
  - 47 endpoints active
  - 4 natural blocks identified
  - Highest load: Fridays 7–9 PM (RPM avg 71)
  - 2 Moment of Value signatures identified
  - No stress events observed yet
```

---

## 7. DATA STORAGE APPROACH

Shadow Mode generates a lot of data over time.
Storage strategy must be lightweight and not require heavy infra.

```
Short-term (raw observations): 
  Local time-series store (InfluxDB or simple SQLite)
  Kept for 30 days rolling window
  Auto-purged after 30 days

Medium-term (aggregated patterns):
  Aggregated hourly/daily summaries
  Kept indefinitely (small size after aggregation)
  This is what the Pattern Analyser works on

Long-term (learned models):
  The Ring Map, threshold suggestions, policy suggestions
  Stored as structured JSON
  Version-controlled (each update creates new version, old kept)
  Developer can see how suggestions evolved over time
```

---

## 8. LEARNING DURATION — HOW LONG SHADOW MODE LEARNS BEFORE SUGGESTING

This is developer-configurable. Two modes available.

---

### Mode 1 — Auto Mode (Default)
CHAKRA decides when it has learned enough.
Not time-based — **data-based.**

A layer graduates when it has seen enough data to be statistically
confident — not simply because a number of days have passed.
A low-traffic app that has been running for 3 days but only received
40 requests has NOT been learned. Time without data means nothing.

```
Layer 1 graduates when:  500+ unique requests observed across endpoints
Layer 2 graduates when:  7+ days of traffic AND consistent daily patterns seen
Layer 3 graduates when:  50+ completed conversion journeys observed
Layer 4 graduates when:  1+ stress event observed (RPM spike + elevated errors)
```

Each layer graduation triggers new suggestions in the dashboard.
Developer is notified: "Layer 2 learning complete. RPM thresholds ready for review."

---

### Mode 2 — Developer Override
Company sets their own learning parameters in the CHAKRA config.
Full control. Useful for companies that know their own traffic rhythms.

```yaml
# chakra.config.yaml — shadow mode settings

shadow_mode:
  mode: "manual"                 # "auto" (default) or "manual"
  min_learning_days: 7           # don't suggest Ring Map before 7 days
  min_conversions_observed: 100  # wait for 100 conversions before Layer 3
  stress_event_wait: true        # don't suggest thresholds until 1 stress event seen
  force_activate_after_days: 30  # hard deadline — go active after 30 days regardless
```

The `force_activate_after_days` field is critical.
Some low-traffic apps may never see a stress event.
We cannot hold them in Shadow Mode forever waiting for one.
After the hard deadline, CHAKRA activates with whatever it has learned
and continues learning from that point forward.

---

### Special Case — Historical Log Import
A company may come to CHAKRA *after* they have already experienced
a painful crash. They have logs. They have data. Shadow Mode was not
there to observe it — but that doesn't mean the data is lost.

CHAKRA supports importing historical access logs:
```
Supported formats:
  - NGINX access logs
  - Apache access logs
  - CloudWatch logs (AWS)
  - Custom JSON log format (with field mapping config)
```

CHAKRA ingests historical logs and learns from them as if Shadow Mode
had been present. This gives Layer 4 (Failure Signatures) data from
day one — even before a single live request is observed.

For companies that have already suffered a crash, this shortcut means
CHAKRA can suggest validated failure-aware policies on day one
instead of waiting months for another stress event.

---

## 9. IMPORTANT DESIGN DECISIONS MADE

1. **Shadow Mode runs forever** — not just in setup phase.
   Even when CHAKRA is fully active, Shadow Mode keeps observing.
   The system never stops learning.

2. **Crash events are treated as valuable, not failures.**
   A high-traffic event that degrades or crashes the app is the most
   valuable learning event CHAKRA can observe. The system is designed
   to capture maximum data during and after such events.

3. **Zero PII policy.** All user identifiers are hashed.
   No request/response bodies are stored. Behaviour patterns only.

4. **Suggestions never auto-activate.** Human approval always required.
   Shadow Mode is an advisor, not an actor.

5. **Shadow Mode is the product's trust builder.**
   Running for weeks before CHAKRA goes active means the developer
   has seen the system working, understands what it learned, and
   trusts its suggestions before giving it control.

6. **Learning is data-driven, not time-driven (default).**
   A layer graduates when sufficient data is observed — not simply
   because N days have passed. Time without traffic is meaningless.

7. **Hard deadline prevents infinite waiting.**
   `force_activate_after_days` ensures even low-traffic apps eventually
   get CHAKRA active, using whatever has been learned up to that point.

8. **Historical log import closes the cold-start gap.**
   Companies with prior crash history can feed that data in on day one,
   skipping months of waiting for Layer 4 data to accumulate naturally.

---

## 10. NEXT CHECKPOINT

**CP2 — RPM Engine**
Covers: How Shadow Mode's baseline data feeds the RPM Engine.
Exact formula for 0–100 RPM score. Update frequency.
How RPM thresholds are calibrated per application using Shadow Mode data.

---

## 11. CONNECTIONS TO OTHER CHECKPOINTS

```
CP0 (Foundation)     → Shadow Mode referenced as Component 2
CP2 (RPM Engine)     → Uses Shadow Mode baseline data for calibration
CP3 (Dispatcher)     → Uses Ring Map produced by Shadow Mode
CP4 (Weight Engine)  → Uses Moment of Value signatures from Shadow Mode
CP7 (Policy Engine)  → Receives policy suggestions from Shadow Mode
CP8 (Dashboard)      → Shows Shadow Mode learning status and outputs
```

---

*Checkpoint 1 created after extended discussion on learning system design.*
*Previous: CHAKRA_CP0_Foundation.md*
*Next: CHAKRA_CP2_RPMEngine.md*
