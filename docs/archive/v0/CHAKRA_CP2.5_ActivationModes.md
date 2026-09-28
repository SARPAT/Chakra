# PROJECT CHAKRA
## Checkpoint 2.5 — Activation Modes & Strategy Engine
### Status: DISCUSSION COMPLETE → READY TO BUILD
### Position in Build Order: BETWEEN RPM Engine and Ring Mapper
### Depends on: CP1 (Shadow Mode), CP2 (RPM Engine)

---

## Why This Checkpoint Exists

During CP2 discussion, a fundamental design question was raised:

> "How does CHAKRA decide when to wake up and go to sleep —
>  given that every company uses different infrastructure,
>  different strategies, and different tech combinations?"

The answer was not to build complex infrastructure connectors
or a universal activation gate.

The answer was simpler and more powerful:
**Give the company two clean modes and let them own their strategy.**

This checkpoint defines exactly how that works.

---

## 1. THE TWO MODES

---

### MODE 1 — MANUAL
**Philosophy:** The human who knows the system best makes the call.

The developer or ops team decides when CHAKRA wakes up.
They watch their own dashboards, their own alerts, their own war rooms.
When they decide the situation needs CHAKRA — they activate it.
When they decide the situation is resolved — they initiate sleep.

CHAKRA executes precisely and immediately. No automation. No surprises.

```
Ops engineer sees systems struggling
        ↓
Opens CHAKRA dashboard
        ↓
Clicks [ ACTIVATE CHAKRA ]
        ↓
CHAKRA wakes up instantly
Policies execute. Degradation begins intelligently.
        ↓
Infrastructure catches up / traffic normalises
        ↓
Ops engineer satisfied
        ↓
Clicks [ INITIATE SLEEP ]
        ↓
CHAKRA begins gradual restoration sequence
        ↓
Full app restored. CHAKRA sleeping.
```

**What CHAKRA tracks in Manual Mode:**
Nothing for activation purposes.
Shadow Mode still runs (always).
RPM Engine still runs (for visibility in dashboard).
But neither triggers any activation automatically.
The human is the only trigger.

**Who should use Manual Mode:**
Large companies with dedicated ops/SRE teams.
Companies running planned sale events (Big Billion Day, Black Friday).
Companies where any automated degradation decision requires human approval.
Any company that wants full control — no surprises, ever.

**Why Manual Mode is not the "basic" option:**
Manual Mode is the preferred professional choice for
sophisticated teams. It is not a fallback. It is a deliberate
decision to keep humans in the loop for high-stakes moments.
Flipkart, Amazon, Myntra-scale companies would likely use Manual Mode
precisely because they have war rooms and want precise human control.

---

### MODE 2 — AUTOMATIC
**Philosophy:** The company teaches CHAKRA their strategy once.
CHAKRA executes it automatically forever.

The company configures their strategy — their own conditions,
their own thresholds, their own priorities.
CHAKRA watches the RPM Engine signals and activates/deactivates
exactly when the company's strategy says to.

No human needed in the activation loop.
The company's thinking runs automatically.

```
CHAKRA watching RPM Engine continuously
        ↓
Strategy conditions met (company-defined thresholds)
        ↓
CHAKRA activates automatically
Policies execute. Degradation begins.
        ↓
Recovery conditions met (company-defined)
        ↓
CHAKRA initiates gradual sleep automatically
        ↓
Full app restored. CHAKRA sleeping. Watching again.
```

**What CHAKRA tracks in Auto Mode:**
RPM score (global + per block) from RPM Engine.
Response latency trends.
Error rate trends.
Evaluates these against the company's strategy config continuously.

**Who should use Auto Mode:**
Startups and growing companies without dedicated ops teams.
Companies with unpredictable traffic spikes (viral moments, unexpected surges).
Companies that want CHAKRA protecting them 24/7 without manual intervention.
Any company whose surges happen faster than a human can respond.

---

## 2. THE STRATEGY CONFIG — COMPANY OWNS THEIR LOGIC

This is the most important concept in this checkpoint.

CHAKRA does not have one universal activation algorithm.
Each company configures their own strategy.
CHAKRA executes that strategy. Nothing more.

CHAKRA is the engine. The company's strategy is the fuel.

**Full strategy config structure:**

```yaml
# chakra.config.yaml

# ─────────────────────────────────────────
# MODE SELECTION
# ─────────────────────────────────────────
mode: "auto"          # "manual" or "auto"

# ─────────────────────────────────────────
# AUTO MODE — ACTIVATION CONDITIONS
# (ignored in manual mode)
# ─────────────────────────────────────────
activate_when:
  rpm_threshold: 72             # RPM must exceed this
  sustained_seconds: 90         # for this long continuously
  error_rate_above: 2.5         # optional: also trigger on error spike
  latency_p95_above_ms: 800     # optional: also trigger on latency spike
  condition_logic: "rpm_AND_sustained
                    OR error_rate
                    OR latency"  # how conditions combine

# ─────────────────────────────────────────
# AUTO MODE — DEACTIVATION / SLEEP CONDITIONS
# (ignored in manual mode)
# ─────────────────────────────────────────
deactivate_when:
  rpm_below: 55
  sustained_seconds: 60
  error_rate_below: 1.0         # optional
  restore_sequence: "gradual"   # "gradual" or "immediate"
  restore_step_wait_seconds: 30 # wait between each level restoration

# ─────────────────────────────────────────
# PROTECTION RULES — apply in both modes
# ─────────────────────────────────────────
always_protect:                 # these endpoints never degraded, ever
  - /api/payment
  - /api/checkout
  - /api/auth
  - /api/order-confirm

degrade_first:                  # these are suspended at earliest stage
  - /api/recommendations
  - /api/ads
  - /api/social-feed
  - /api/blog
  - /api/reviews

# ─────────────────────────────────────────
# USER TIER OVERRIDES — apply in both modes
# ─────────────────────────────────────────
user_overrides:
  premier_users:
    header: "X-User-Tier"
    value: "premier"
    treatment: always_level_0   # premier users always get full app

  mid_checkout_sessions:
    detection: "moment_of_value_signature"  # from Shadow Mode learning
    treatment: always_level_0

# ─────────────────────────────────────────
# ABORT SLEEP — auto mode only
# ─────────────────────────────────────────
abort_sleep_if:
  rpm_climbs_above: 65          # if RPM rises again during restoration
  action: "pause_restoration"   # pause and re-evaluate, do not snap back
```

---

## 3. REAL COMPANY STRATEGY EXAMPLES

These show how different companies configure completely different
behaviours from the same CHAKRA system.

---

### Company A — Banking App (Risk Averse)
```yaml
mode: "auto"

activate_when:
  rpm_threshold: 55           # step in early
  sustained_seconds: 30       # don't wait long
  error_rate_above: 1.0       # very sensitive to errors

deactivate_when:
  rpm_below: 40
  sustained_seconds: 120      # wait longer before declaring safe
  restore_sequence: "gradual"
  restore_step_wait_seconds: 60

always_protect:
  - /api/payment
  - /api/auth
  - /api/account-balance
  - /api/transfer

degrade_first:
  - /api/statements-download
  - /api/chat-support
  - /api/branch-locator
  - /api/offers

user_overrides:
  premier_users:
    treatment: always_level_0
```

---

### Company B — Gaming Platform (User Experience Priority)
```yaml
mode: "auto"

activate_when:
  rpm_threshold: 88           # let infra fight first
  sustained_seconds: 180      # wait longer
  error_rate_above: 3.0       # only step in when breaking

deactivate_when:
  rpm_below: 70
  sustained_seconds: 45       # recover faster when possible
  restore_sequence: "immediate"  # snap back fast — gamers notice delays

always_protect:
  - /api/game-session
  - /api/matchmaking
  - /api/leaderboard

degrade_first:
  - /api/friend-suggestions
  - /api/replay-storage
  - /api/achievement-badges
  - /api/store-recommendations
```

---

### Company C — E-commerce (Manual, Sale Events)
```yaml
mode: "manual"               # ops team handles it

# activate_when and deactivate_when ignored in manual mode

always_protect:
  - /api/payment
  - /api/checkout
  - /api/cart
  - /api/order-status

degrade_first:
  - /api/recommendations
  - /api/recently-viewed
  - /api/social-proof
  - /api/banner-ads

user_overrides:
  premier_users:
    header: "X-Membership"
    value: "gold"
    treatment: always_level_0
  mid_checkout_sessions:
    detection: "moment_of_value_signature"
    treatment: always_level_0
```

---

## 4. THE SLEEP PROCESS — GRADUAL VS IMMEDIATE

When CHAKRA deactivates — manually or automatically — it does not
snap back to full functionality instantly.

Snapping back is dangerous. Traffic may still be elevated.
The infrastructure may still be catching up.
Restoring everything at once could re-trigger the stress
that CHAKRA just managed.

**Gradual Restoration (default):**

```
CHAKRA sleep initiated
        ↓
Step 1: Restore outermost degraded level
        (bring back recommendations, ads, social features)
        Wait [restore_step_wait_seconds] → confirm RPM stable
        If RPM climbs → pause restoration → hold at this level
        ↓
Step 2: Restore next level inward
        Wait [restore_step_wait_seconds] → confirm stable
        ↓
Step 3: Full restoration — Level 0 for all users
        ↓
CHAKRA sleeping. Shadow Mode and RPM Engine still watching.
```

**Immediate Restoration (developer choice):**

```
CHAKRA sleep initiated
        ↓
All levels restored simultaneously
        ↓
CHAKRA sleeping.
```

Used when traffic has dropped sharply and system is clearly healthy.
Appropriate for gaming platforms, media apps where feature flicker
is more disruptive than the risk of re-triggering.

**Abort Sleep (Auto Mode only):**

```
During gradual restoration, if RPM climbs above [abort_sleep_if threshold]:
  → Pause restoration at current level
  → Do not step back up to higher degradation (avoid whiplash)
  → Re-evaluate every 30 seconds
  → Continue restoration only when RPM drops again
  → Never fully reactivate without falling back through normal
     activation conditions
```

---

## 5. MANUAL MODE — THE DASHBOARD CONTROLS

In Manual Mode, the CHAKRA dashboard shows a prominent control panel:

```
┌─────────────────────────────────────────────────┐
│  CHAKRA STATUS: SLEEPING                        │
│                                                 │
│  Current RPM: 71  ↑ Rising                     │
│  Latency P95: 340ms  (baseline: 180ms)          │
│  Error Rate:  1.2%   (baseline: 0.8%)           │
│                                                 │
│  [ ⚡ ACTIVATE CHAKRA ]                         │
│                                                 │
│  Last activated: 3 days ago (duration: 22 min)  │
└─────────────────────────────────────────────────┘

─── when active ───────────────────────────────────

┌─────────────────────────────────────────────────┐
│  CHAKRA STATUS: ● ACTIVE  (since 14:32:07)      │
│                                                 │
│  Current Level: 2                               │
│  Protected blocks: Payment ✅  Cart ✅           │
│  Suspended blocks: Recommendations 🔴  Ads 🔴   │
│                                                 │
│  RPM: 79  ↓ Dropping slowly                    │
│  Latency P95: 420ms  ↓ Recovering               │
│                                                 │
│  [ 💤 INITIATE SLEEP ]  [ Immediate ]           │
└─────────────────────────────────────────────────┘
```

The dashboard shows enough context that the ops engineer
can make a confident, informed decision — not just a blind switch.

---

## 6. ACTIVATION LOG — THE AUDIT TRAIL

Every activation and deactivation is logged with full context.
This is the trust mechanism — every action is explainable.

```
CHAKRA Activation Log:

[14:32:07]  ACTIVATED (Manual)
            Initiated by: ops-engineer@company.com
            RPM at activation: 79
            Latency P95 at activation: 620ms
            Error rate at activation: 2.1%
            Level activated: 2
            Blocks suspended: Recommendations, Ads, Reviews

[14:51:23]  SLEEP INITIATED (Manual)
            Initiated by: ops-engineer@company.com
            RPM at deactivation: 54
            Restoration sequence: Gradual

[14:51:53]  RESTORATION STEP 1 COMPLETE
            Recommendations restored.
            RPM: 51 — stable. Continuing.

[14:52:23]  RESTORATION STEP 2 COMPLETE
            Ads, Reviews restored.
            RPM: 49 — stable. Continuing.

[14:52:53]  FULLY RESTORED
            All blocks active. CHAKRA sleeping.
            Total active duration: 19 minutes 16 seconds.
```

For Auto Mode, the log shows what conditions triggered activation:

```
[08:14:33]  ACTIVATED (Auto)
            Trigger: RPM exceeded threshold 72 for 93 seconds.
            RPM at activation: 76
            Strategy condition met: rpm_AND_sustained
```

---

## 7. DESIGN DECISIONS MADE

1. **Two modes, not one.** Manual and Auto serve genuinely different
   needs and different company types. Neither is superior.
   Both are first-class.

2. **Company owns their strategy.** CHAKRA does not have a universal
   activation algorithm. It executes whatever strategy the company
   configures. This is the core philosophy of the Strategy Engine.

3. **No infrastructure connector required for activation.**
   In Manual Mode — human decides.
   In Auto Mode — RPM Engine signals decide.
   Neither mode requires reading K8s API, ECS, or anything external.
   Infrastructure connectors (from CP2 discussion) become optional
   enhancements, not requirements.

4. **Gradual sleep by default.** Snapping back to full functionality
   is dangerous. Gradual restoration with health checks between
   each step is the safe default. Immediate restoration is opt-in.

5. **Abort sleep prevents whiplash.** During restoration, if RPM
   climbs again, CHAKRA pauses — it does not snap back to full
   degradation. Smooth, controlled behaviour in both directions.

6. **Full audit log always.** Every activation, every deactivation,
   every restoration step is logged with context. This is what
   makes CHAKRA trustworthy to ops teams and company leadership.

7. **Strategy config is live-editable.** Company can change their
   strategy at any time without restarting CHAKRA or redeploying
   their app. Takes effect on next evaluation cycle.

8. **Shadow Mode and RPM Engine run regardless of activation mode.**
   Even in Manual Mode with CHAKRA sleeping, the system is always
   watching and always learning. The dashboard always shows
   live RPM so the ops team has the context to make good decisions.

---

## 8. NEXT CHECKPOINT

**CP3 — Ring Mapper**
Covers: How the App Ring Map is structured as a data model.
How annotations work in code. How blocks are defined and stored.
How the Ring Map feeds the Dispatcher with routing decisions.
How Shadow Mode suggestions become the live Ring Map.

---

## CONNECTIONS TO OTHER CHECKPOINTS

```
CP1 (Shadow Mode)    → Runs always, regardless of activation mode.
                       Provides learning data that informs strategy config.

CP2 (RPM Engine)     → Primary signal source for Auto Mode activation.
                       Visible in dashboard for Manual Mode decision-making.

CP3 (Ring Mapper)    → Defines what each level and block contains.
                       Strategy config references blocks and levels.

CP4 (Dispatcher)     → Reads current activation state.
                       When CHAKRA active: routes by Ring Map + policies.
                       When CHAKRA sleeping: passes all requests through.

CP7 (Policy Engine)  → Executes the protection and user override rules
                       defined in the strategy config.

CP8 (Dashboard)      → Primary interface for Manual Mode.
                       Shows activation controls, live RPM, audit log.
                       Strategy config editor lives here.
```

---

*Checkpoint 2.5 created after discussion on activation modes and strategy design.*
*Previous: CHAKRA_CP2_RPMEngine.md*
*Next: CHAKRA_CP3_RingMapper.md*
