# PROJECT CHAKRA
## Checkpoint 2 — RPM Engine (The Load Sensor)
### Status: DISCUSSION COMPLETE → READY TO BUILD
### Position in Build Order: SECOND — runs after Shadow Mode has baseline data

---

## What The RPM Engine Does — One Sentence

> At any given moment, produce a single number between 0 and 100
> that honestly represents how stressed this application is right now.

0   = completely healthy, plenty of capacity.
100 = at breaking point, about to fail.

Everything in CHAKRA — every routing decision, every policy trigger,
every level activation — flows from this one number.

---

## Why Not Just Use CPU?

The naive approach is watching CPU. Most systems do this.
The problem: CPU is a lagging indicator.

By the time CPU hits 90%, users have already been suffering
for 60–90 seconds. Requests have been slow. Some have failed.
The damage is done before the signal even appears.

CHAKRA needs signals that say stress is COMING —
not signals that confirm it already arrived.

The RPM Engine uses three signals chosen specifically because
they rise earlier, more honestly, and more usefully than CPU alone.

---

## 1. THE THREE SIGNALS

---

### Signal 1 — Request Arrival Rate (RAR)
**What it measures:** How fast requests are arriving RIGHT NOW
compared to the established normal baseline for this time and day.

**Why this signal:** It is the earliest possible warning.
The moment a sale starts or a viral event hits, request rate
climbs immediately — before latency budges, before errors appear.
RAR gives CHAKRA the maximum possible warning time.

**How it is calculated:**
```
Normal baseline:      500 req/min  (learned by Shadow Mode, time-aware)
Current rate:         1,200 req/min

RAR raw score = current / baseline = 1200 / 500 = 2.4x normal

Normalization to 0–100:
  1.0x (at baseline)      → score 0
  2.0x (double baseline)  → score 50
  3.0x (triple baseline)  → score 75
  4.0x+                   → score 95–100

RAR Score: 80
```

**Important:** Baseline is time-aware. Friday 8 PM baseline is different
from Tuesday 2 AM baseline. Shadow Mode learns these patterns separately.
Comparing Friday evening traffic against a Tuesday baseline would give
false alarms every single week.

---

### Signal 2 — Response Latency Percentile (RLP)
**What it measures:** P95 response latency — the time within which
95% of requests complete — compared to the healthy baseline.

**Why P95 and not average:** Averages lie under stress.
If 90% of requests complete in 100ms but 10% are taking 8 seconds,
the average looks like ~900ms — concerning but not alarming.
P95 catches those struggling requests in the tail — which are always
the first symptom of real stress beginning to build.

**Why this signal is the heaviest weighted:** Latency is the most
continuous and honest signal. It rises smoothly as load increases,
giving CHAKRA time to react before errors appear. It directly
reflects what users are experiencing right now.

**How it is calculated:**
```
Healthy P95 baseline:   180ms   (learned by Shadow Mode)
Current P95:            620ms

RLP raw score = current / baseline = 620 / 180 = 3.4x normal

Normalization to 0–100:
  1.0x  → score 0
  2.0x  → score 40
  3.0x  → score 65
  5.0x+ → score 90–100

RLP Score: 75
```

---

### Signal 3 — Error Rate Delta (ERD)
**What it measures:** The change in error rate (4xx/5xx responses)
compared to the normal baseline error rate.

**Why delta and not raw rate:** Every app has a normal background
error rate (bad requests, auth failures, etc.). Alerting on raw
error rate would cause constant false alarms. What matters is
when errors START CLIMBING above normal — that is the signal.

**Why this signal is urgent:** Error rate delta is the most
severe signal. When errors climb, users are actively failing
right now. This demands immediate response. It also tends to
appear later than RAR and RLP — so when it appears, the
situation is already serious.

**How it is calculated:**
```
Normal error rate baseline:   0.8%   (learned by Shadow Mode)
Current error rate:           3.2%

ERD raw score = current / baseline = 3.2 / 0.8 = 4.0x normal

Normalization to 0–100:
  1.0x  → score 0
  1.5x  → score 30
  2.0x  → score 55
  4.0x+ → score 85–100

ERD Score: 90
```

---

## 2. THE FORMULA

The three signals combine into one RPM score.
They are not weighted equally.

```
RPM = (RAR × 0.30) + (RLP × 0.40) + (ERD × 0.30)

Weight reasoning:
  Request Arrival Rate  (30%): Leading indicator. Important early warning
                                but alone it does not confirm user impact.
  Response Latency P95  (40%): Heaviest weight. Direct, continuous, honest
                                signal of real user experience degradation.
  Error Rate Delta      (30%): High urgency when it appears but tends to
                                arrive later. High weight reflects severity.

Example calculation:
  RAR Score: 80  →  80 × 0.30 = 24.0
  RLP Score: 75  →  75 × 0.40 = 30.0
  ERD Score: 90  →  90 × 0.30 = 27.0

  RPM = 24.0 + 30.0 + 27.0 = 81
  → System is under serious stress. Level 2 or 3 likely active.
```

---

## 3. UPDATE FREQUENCY AND SMOOTHING

**Update frequency: every 5 seconds.**

Why not faster?
Faster than 5 seconds creates thrashing — CHAKRA activates Level 2,
then deactivates it, then activates again as the number bounces.
Users see flickering functionality. Operators see noise.
The system becomes untrustworthy.

Why not slower?
Slower than 5 seconds means a 30-second surge has done significant
damage before CHAKRA has a chance to respond.

5 seconds is the right balance — responsive but stable.

**Smoothing — rolling weighted average:**
The RPM number is not raw. It is smoothed across the last 3 readings
(15 seconds of history). This prevents a single anomalous spike from
triggering level changes unnecessarily.

```
RPM_smooth = (RPM_now × 0.50) + (RPM_5s_ago × 0.30) + (RPM_10s_ago × 0.20)

Example:
  RPM 10s ago:   45
  RPM 5s ago:    62
  RPM now:       78

  RPM_smooth = (78 × 0.50) + (62 × 0.30) + (45 × 0.20)
             = 39.0 + 18.6 + 9.0
             = 66.6  →  RPM: 67

  Without smoothing: 78 (would trigger Level 2 prematurely)
  With smoothing:    67 (correctly reflects that stress is building, not peaked)
```

**Hysteresis on level transitions:**
When RPM crosses a threshold going UP → level changes immediately.
When RPM drops back below a threshold → wait for 3 consecutive readings
below the threshold before deactivating the level.

This prevents rapid on/off flickering at threshold boundaries.

---

## 4. WHY SHADOW MODE IS ESSENTIAL TO THE RPM ENGINE

Every formula above compares current values against a BASELINE.
Without a baseline, the numbers are meaningless.

500 req/min — is that high?
Depends entirely on the app. For a small startup, 500 req/min is a surge.
For a large e-commerce platform, it is a quiet morning.

This is why Shadow Mode comes first. It establishes the baseline
for each application individually. The RPM Engine without Shadow Mode
data is an engine without fuel — the mechanism exists but cannot run.

```
Shadow Mode provides to RPM Engine:
  - Normal request rate baseline (per hour-of-day AND per day-of-week)
  - Normal P95 latency baseline (same time-awareness)
  - Normal error rate baseline
  - Historical RPM distribution
    (what does RPM 60 actually mean for THIS app?
     Is it unusual? Does it happen every Friday? Never?)
  - Validated stress thresholds (from Layer 4 failure signatures)
    (at what RPM did this app actually start degrading historically?)
```

The RPM Engine is calibrated per application. Never generic.

---

## 5. COLD START — BEFORE SHADOW MODE HAS BASELINE DATA

There is a chicken-and-egg problem:
RPM Engine needs baseline data from Shadow Mode.
Shadow Mode needs time to build it.
What happens in the first hours after install?

Three-phase cold start handles this:

```
PHASE 1 — First 2 hours (Conservative Defaults)
  No baseline data yet. Use safe industry-standard defaults.
  Request rate:  treat current rate as baseline (no comparison)
  Latency:       flag if P95 exceeds 500ms
  Error rate:    flag if error rate exceeds 2%
  RPM during this phase is approximate and conservative.
  CHAKRA stays in Shadow Mode only. No routing decisions made.

PHASE 2 — Hours 2 to 24 (Bootstrapping)
  Shadow Mode has enough data for a rough app-specific baseline.
  RPM Engine switches from defaults to observed baseline.
  Thresholds are conservative but now app-specific.
  CHAKRA still in Shadow Mode. Just watching.

PHASE 3 — Day 2 onwards (Fully Calibrated)
  Shadow Mode has observed baseline across multiple time-of-day windows.
  RPM Engine is now accurate for this specific application.
  CHAKRA can be activated by the developer if they choose to.
  RPM scores from this point are trustworthy.
```

---

## 6. PER-BLOCK RPM — SURGICAL PRECISION

The RPM Engine does not produce only one global RPM.
It produces per-block RPM as well.

This is a critical design decision.

**Why:** If only the Search block is struggling, CHAKRA should degrade
only Search — not Cart, not Checkout. A blunt global RPM would cause
CHAKRA to degrade the entire app when only one part is stressed.
Per-block RPM gives the Dispatcher the surgical precision it needs.

```
Global RPM:  72  (overall app stress — drives global level decisions)

Per-Block RPM:
  Block A — Payment/Checkout:   45  (healthy — protected, few requests)
  Block B — Cart/Orders:        68  (moderate stress)
  Block C — Browse/Search:      91  (under heavy load — the problem)
  Block D — Recommendations:    95  (saturated)

Dispatcher uses:
  Global RPM     → for global level decisions
  Per-block RPM  → for block-specific routing decisions
  (a block can be degraded even if global RPM is moderate,
   if that block's own RPM is high)
```

Per-block RPM uses the same formula and same signals —
but calculated only from requests touching that block's endpoints.

---

## 7. WHAT NEEDS TO BE BUILT

### Component: Signal Collector
**What it does:**
Runs inside the CHAKRA middleware layer.
On every request/response cycle, records:
  - Timestamp
  - Response time (for latency calculation)
  - Status code (for error rate calculation)
  - Which block this request belongs to

Maintains a sliding 60-second window of raw data in memory.
Feeds the RPM Calculator every 5 seconds.

Implementation: In-memory ring buffer. No disk I/O on the hot path.
Must add zero meaningful latency to request handling.

---

### Component: RPM Calculator
**What it does:**
Runs every 5 seconds on a background timer.
Reads the 60-second window from Signal Collector.
Fetches current baselines from Shadow Mode data store.
Calculates RAR, RLP, ERD scores.
Applies the formula.
Applies smoothing.
Outputs: global RPM + per-block RPM.
Writes result to RPM State Store.

---

### Component: RPM State Store
**What it does:**
Holds the current RPM value (global + per-block).
In-memory. Extremely fast reads.
The Dispatcher reads from here on every single request.
Also maintains last 24 hours of RPM history for the dashboard.

Implementation: Simple in-memory object.
Background job writes to persistent store (SQLite) every minute
for historical dashboard display.

---

### Component: Threshold Config
**What it holds:**
The RPM levels at which CHAKRA activates each degradation level.
Set initially by Shadow Mode suggestions.
Overridable by developer in config or dashboard.

```javascript
// Default thresholds (overridden by Shadow Mode suggestions)
{
  level_1_threshold: 55,   // RPM >= 55 → activate Level 1
  level_2_threshold: 72,   // RPM >= 72 → activate Level 2
  level_3_threshold: 88,   // RPM >= 88 → activate Level 3
  hysteresis_readings: 3   // consecutive readings needed to deactivate a level
}
```

---

## 8. DESIGN DECISIONS MADE

1. **Three signals, not CPU.** RAR + RLP + ERD gives earlier warning,
   more accuracy, and direct connection to user experience vs CPU alone.

2. **P95 latency, not average.** Averages hide the tail. P95 reveals
   the struggling requests that are the first symptom of stress.

3. **Delta not absolute for error rate.** Every app has a noise floor
   of background errors. Alerting on delta prevents constant false alarms.

4. **5-second update cycle with smoothing.** Balance between
   responsiveness and stability. Prevents thrashing at boundaries.

5. **Hysteresis on deactivation.** Level activates fast, deactivates slow.
   Prevents flickering when RPM bounces around a threshold.

6. **Per-block RPM alongside global RPM.** Enables surgical degradation —
   affect only the stressed block, not the entire application.

7. **Baselines from Shadow Mode, not hardcoded.**
   RPM is meaningful only relative to what is normal for THIS app.
   Generic thresholds would create constant false positives/negatives.

8. **Three-phase cold start.** Handles the period before Shadow Mode
   has sufficient data. Conservative defaults protect users during
   the learning bootstrap period.

---

## 9. NEXT CHECKPOINT

**CP3 — Ring Mapper**
Covers: How the App Ring Map is structured as a data model.
How annotations work in code. How Shadow Mode's block suggestions
become the Ring Map. How the map is stored and updated.
What the Ring Map looks like as a data structure the Dispatcher reads.

---

## CONNECTIONS TO OTHER CHECKPOINTS

```
CP1 (Shadow Mode)    → Provides all baselines to RPM Engine.
                       Per-app calibration entirely dependent on CP1 data.
CP3 (Ring Mapper)    → Receives per-block RPM to know which blocks are stressed.
CP4 (Dispatcher)     → Reads RPM State Store on every request.
                       Primary consumer of RPM Engine output.
CP7 (Policy Engine)  → Policy rules reference RPM thresholds
                       (e.g. "IF RPM > 70 THEN suspend Block D")
CP8 (Dashboard)      → Displays live RPM gauge + 24-hour RPM history.
                       Shows per-block RPM breakdown.
```

---

*Checkpoint 2 created after RPM Engine design discussion.*
*Previous: CHAKRA_CP1_ShadowMode.md*
*Next: CHAKRA_CP3_RingMapper.md*
