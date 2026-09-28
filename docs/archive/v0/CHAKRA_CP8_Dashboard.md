# PROJECT CHAKRA
## Checkpoint 8 — Dashboard (The Control Room)
### Status: DISCUSSION COMPLETE → READY TO BUILD
### Position in Build Order: EIGHTH
### Depends on: All previous checkpoints (CP0–CP7)

---

## What The Dashboard Is

The Dashboard is the face of CHAKRA. It is the primary interface
through which every developer, ops engineer, and engineering
manager interacts with the system.

It is not a reporting tool. It is a control room.

It serves four audiences:

```
Developer (setup phase):
  Review Shadow Mode learning progress.
  Approve Ring Map suggestion.
  Write and test policies.
  Understand what CHAKRA is doing.

Ops/SRE (during live incident):
  See live RPM and block states instantly.
  Activate/deactivate CHAKRA in one click.
  Fire emergency presets.
  Add an emergency policy rule in under 30 seconds.

Engineering Manager (post-incident):
  What happened? When did CHAKRA activate?
  What did it suspend? How long?
  What was the impact on users?

Solo developer/startup (everything):
  All of the above, simple enough to manage alone.
```

One dashboard. Four audiences.
Serves all of them without overwhelming any of them.

---

## 1. TECHNICAL FOUNDATION

The Dashboard is a web application served by CHAKRA's internal
server. It starts automatically when the app starts.
No separate installation. No external service. No cloud dependency.

```
Access:           http://localhost:4242  (default)
Server:           Bundled Node.js HTTP server
Frontend:         Single-page app (React)
                  Built and bundled inside the npm package
                  Developer does not need Node/npm to use the dashboard
                  It is served as static files from the package

Authentication:   Basic auth (username + password via env variable)
                  Optional — can be disabled for development environments

Updates:          Dashboard polls CHAKRA's internal API every 3 seconds
                  Live RPM and block state always fresh
                  WebSocket connection for real-time incident streaming
```

Dashboard is included in the middleware package (CP6).
No extra setup. Open browser. Done.

---

## 2. GLOBAL HEADER — ALWAYS VISIBLE

The header is permanent. Visible on every screen.
Ops engineer never hunts for the activate button.

```
SLEEPING state:
┌──────────────────────────────────────────────────────────────┐
│  🔵 CHAKRA    myapp.company.com        ● SLEEPING   14:32   │
│               RPM: 47  ↔ stable        [ ⚡ ACTIVATE ]      │
└──────────────────────────────────────────────────────────────┘

ACTIVE state:
┌──────────────────────────────────────────────────────────────┐
│  🔴 CHAKRA    myapp.company.com     ● ACTIVE  14:32→+12m    │
│               RPM: 79  ↑ rising     Level: 2  [ 💤 SLEEP ]  │
└──────────────────────────────────────────────────────────────┘
```

Header shows:
- CHAKRA status (colour coded — blue sleeping, red active)
- App identifier
- Live RPM with trend arrow
- Duration if active
- Primary action button (Activate or Sleep)

---

## 3. SCREEN 1 — OVERVIEW (Default Landing)

First screen developer sees on opening dashboard.
Designed for the ops engineer's normal day and incident moments.
Everything meaningful at a glance.

### Normal Day View
```
┌──────────────────────────────────────────────────────────────┐
│  🔵 CHAKRA    myapp.company.com        ● SLEEPING   14:32   │
│               RPM: 47  ↔ stable        [ ⚡ ACTIVATE ]      │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  RPM — LAST 30 MINUTES                                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  80 ┤                                                   │  │
│  │  60 ┤         ╭──╮    ╭─╮                              │  │
│  │  40 ┤──────╮──╯  ╰────╯ ╰────────────────── 47        │  │
│  │  20 ┤      ╰─                                          │  │
│  │   0 └──────────────────────────────────────────────    │  │
│  └────────────────────────────────────────────────────────┘  │
│  Latency P95: 210ms (baseline: 180ms)                        │
│  Error Rate:  0.9%  (baseline: 0.8%)                         │
│                                                              │
│  BLOCK STATES                                                │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │  payment-block   │  │  cart-block       │                 │
│  │  ✅ Active       │  │  ✅ Active        │                 │
│  │  RPM: 31         │  │  RPM: 44          │                 │
│  └──────────────────┘  └──────────────────┘                 │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │  browse-block    │  │  recs-block       │                 │
│  │  ✅ Active       │  │  ✅ Active        │                 │
│  │  RPM: 52         │  │  RPM: 47          │                 │
│  └──────────────────┘  └──────────────────┘                 │
│                                                              │
│  TODAY                                                       │
│  Activations: 0   │   Last activated: 3 days ago (22 min)   │
│  Learning: Day 14 │   3 policy suggestions ready [ Review ] │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Active Incident View
```
┌──────────────────────────────────────────────────────────────┐
│  🔴 CHAKRA    myapp.company.com     ● ACTIVE  14:32→+12m    │
│               RPM: 79  ↑ rising     Level: 2  [ 💤 SLEEP ]  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  RPM — LAST 30 MINUTES                                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  80 ┤                                    ╭──────── 79  │  │
│  │  60 ┤                              ╭─────╯             │  │
│  │  40 ┤──────────────────────────────╯                   │  │
│  │  20 ┤                                                   │  │
│  └────────────────────────────────────────────────────────┘  │
│  Latency P95: 580ms ⚠  (3.2x baseline)                      │
│  Error Rate:  2.1%  ⚠  (2.3x baseline)                      │
│                                                              │
│  BLOCK STATES                                                │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │  payment-block   │  │  cart-block       │                 │
│  │  ✅ Protected    │  │  ✅ Active        │                 │
│  │  RPM: 45         │  │  RPM: 68          │                 │
│  └──────────────────┘  └──────────────────┘                 │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │  browse-block    │  │  recs-block       │                 │
│  │  ⚠ Limited      │  │  🔴 Suspended     │                 │
│  │  RPM: 84         │  │  RPM: 91          │                 │
│  └──────────────────┘  └──────────────────┘                 │
│                                                              │
│  LIVE STATS (since 14:32:07)                                 │
│  Suspended: 8,420  │  Weight rescues: 234  │  Policy: 89    │
│  Policies active: 4                                          │
│                                                              │
│  EMERGENCY PRESETS                                           │
│  [⚡ Suspend Non-Essential]  [🔒 Checkout-Only]  [↩ Restore]│
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. SCREEN 2 — RING MAP (Visual App Structure)

The Ring Map screen renders the developer's App Ring Map as
an actual ring / concentric circle diagram — the Chakra metaphor
made visible. This is the most unique visual in the product.

```
┌──────────────────────────────────────────────────────────────┐
│  Ring Map                          [ + Add Block ]  [ Edit ] │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                   ╔══════════════════╗                       │
│                   ║  Level 3 (outer) ║  🔴 recs-block        │
│                   ║  ╔════════════╗  ║     9 endpoints       │
│                   ║  ║  Level 2   ║  ║     Suspended         │
│                   ║  ║  ╔══════╗  ║  ║                       │
│                   ║  ║  ║  L1  ║  ║  ║  ⚠ browse-block      │
│                   ║  ║  ║ ╔══╗ ║  ║  ║    12 endpoints      │
│                   ║  ║  ║ ║L0║ ║  ║  ║    Limited           │
│                   ║  ║  ║ ╚══╝ ║  ║  ║                       │
│                   ║  ║  ╚══════╝  ║  ║  ✅ cart-block        │
│                   ║  ╚════════════╝  ║     8 endpoints       │
│                   ╚══════════════════╝     Active            │
│                                                              │
│                                          ✅ payment-block    │
│                                             4 endpoints      │
│                                             Protected         │
│                                                              │
│  ──────────────────────────────────────────────────────────  │
│  SELECTED: browse-block                                      │
│  Endpoints: GET /api/products, GET /api/products/:id,        │
│             GET /api/search, GET /api/categories  (+8 more) │
│  Current RPM: 84  │  Weight Base: 30  │  Min Level: 2       │
│  Status: Limited (X-Chakra-Hint: use-cache)                 │
│                                                              │
│  ⚠ 3 unmatched endpoints receiving traffic  [ Review ]     │
│  Ring Map version: v4  [ History ]  [ Rollback ]            │
└──────────────────────────────────────────────────────────────┘
```

Clicking a block shows its endpoint list, current RPM,
weight settings, and current status in a detail panel below.
Color coding: green = active, orange = limited, red = suspended, blue = protected.

---

## 5. SCREEN 3 — POLICIES

```
┌──────────────────────────────────────────────────────────────┐
│  Policies                    [ + New Policy ]  [ Presets ]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ACTIVE POLICIES (6)                                         │
│                                                              │
│  P:100  premier-users-always-served              ✅ Active  │
│         IF user_tier: premium                               │
│         → serve_fully                                        │
│         Triggered today: 89 times     [ Edit ] [ Disable ]  │
│                                                              │
│  P:95   protect-mid-checkout                     ✅ Active  │
│         IF moment_of_value: full                            │
│         → serve_fully                                        │
│         Triggered today: 234 times    [ Edit ] [ Disable ]  │
│                                                              │
│  P:70   cache-search-on-load                     ✅ Active  │
│         IF block: search-block AND rpm_above: 65            │
│         → serve_limited (use-cache)                         │
│         Triggered today: 1,204 times  [ Edit ] [ Disable ]  │
│                                                              │
│  ─────────────────────────────────────────────────────────  │
│                                                              │
│  SUGGESTIONS FROM SHADOW MODE (3)                            │
│                                                              │
│  💡 protect-high-cart-sessions                              │
│     confidence: HIGH — 30 days data                         │
│     IF cart_items_above: 2 → serve_fully                    │
│     [ ✓ Activate ] [ ✎ Modify ] [ ✗ Dismiss ]               │
│                                                              │
│  💡 suspend-recs-on-moderate-load                           │
│     confidence: MEDIUM — 30 days data                       │
│     IF block: recs-block AND rpm_above: 45 → suspend        │
│     [ ✓ Activate ] [ ✎ Modify ] [ ✗ Dismiss ]               │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Policy Editor (inline or modal)
Simple form. Not raw YAML in the UI.
```
┌───────────────────────────────────────────────────────────┐
│  New Policy                                               │
│                                                           │
│  Name:  [protect-enterprise-users              ]          │
│                                                           │
│  Conditions (AND):                                        │
│  [ user_tier ▾ ]  [ = ▾ ]  [ enterprise        ]  [+ Add]│
│                                                           │
│  Action:  [ serve_fully ▾ ]                              │
│                                                           │
│  Priority: [ 98 ]                                         │
│                                                           │
│  [ Save Policy ]  [ Test Against Sample Request ]         │
└───────────────────────────────────────────────────────────┘
```

Policy tester — developer can input a sample request context
and see which rules would match and what action would fire.
Critical for building confidence before going live.

### Emergency Presets Panel
```
┌───────────────────────────────────────────────────────────┐
│  Emergency Presets                                        │
│                                                           │
│  [⚡ Suspend Non-Essential]    Suspends: recs, ads, social │
│  [🔒 Checkout-Only Mode]       Suspends: all except payment│
│  [🐢 Cache Everything]         Sets all to serve_limited  │
│  [↩ Restore All]               Removes all emergency rules │
│                                                           │
│  Last used: Mar 21 14:32 — Checkout-Only Mode (17 min)   │
│  [ + Define New Preset ]                                   │
└───────────────────────────────────────────────────────────┘
```

---

## 6. SCREEN 4 — LEARNING (Shadow Mode Status)

```
┌──────────────────────────────────────────────────────────────┐
│  Learning                                                    │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  LEARNING PROGRESS — Day 14                                  │
│  Force activate after: Day 30  (16 days remaining)          │
│                                                              │
│  ✅ Layer 1 — App Structure                                  │
│     Complete (Day 1)  │  47 endpoints  │  4 blocks          │
│                                                              │
│  ✅ Layer 2 — Traffic Patterns                               │
│     Complete (Day 7)  │  14 days data                       │
│     Peak: Fridays 19:00–21:00  │  Avg peak RPM: 71          │
│                                                              │
│  🔄 Layer 3 — User Behaviour                                 │
│     In progress (60%)  │  342 conversions observed          │
│     Need ~200 more conversions for high-confidence MoV      │
│     2 MoV signatures identified so far                      │
│                                                              │
│  ⏳ Layer 4 — Failure Signatures                             │
│     Waiting for stress event                                │
│     [ Import Historical Logs ]  shortcut to Layer 4         │
│                                                              │
│  ─────────────────────────────────────────────────────────  │
│                                                              │
│  READY FOR YOUR REVIEW                                       │
│  ✅ Ring Map suggestion      Day 3  [ Review + Approve ]    │
│  ✅ RPM thresholds            Day 7  [ Review + Approve ]   │
│  ⏳ Failure-based policies    waiting for Layer 4           │
│                                                              │
│  ─────────────────────────────────────────────────────────  │
│                                                              │
│  IMPORT HISTORICAL LOGS                                      │
│  Train Layer 4 immediately using past log files.            │
│  Supported formats: nginx, Apache, CloudWatch JSON          │
│  [ Choose Log File ]                                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 7. SCREEN 5 — HISTORY (Audit Log + Incident Reports)

```
┌──────────────────────────────────────────────────────────────┐
│  History               [ Export CSV ]  [ Filter: all time ]  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ACTIVATION EVENTS                                           │
│                                                              │
│  🔴 Mar 21  14:32–14:51  (19 min)  Manual                   │
│     Peak RPM: 81  │  Suspended: 8,420  │  Protected: 323   │
│     Initiated by: ops-engineer@company.com                  │
│     [ View Full Report ]                                     │
│                                                              │
│  🔴 Mar 18  20:14–20:38  (24 min)  Auto (RPM 74 × 93s)      │
│     Peak RPM: 79  │  Suspended: 12,103  │  Protected: 441  │
│     [ View Full Report ]                                     │
│                                                              │
│  ─────────────────────────────────────────────────────────  │
│                                                              │
│  POLICY CHANGES                                              │
│                                                              │
│  Mar 21 14:33  cache-search threshold: 65 → 55              │
│                by ops-engineer@company.com  [ View diff ]   │
│                                                              │
│  Mar 20 09:15  NEW: protect-high-cart-sessions              │
│                by developer@company.com (from suggestion)   │
│                                                              │
│  Mar 18 09:00  NEW: premier-users-always-served             │
│                by developer@company.com                     │
│                                                              │
│  ─────────────────────────────────────────────────────────  │
│                                                              │
│  RING MAP CHANGES                                            │
│                                                              │
│  Mar 15  Ring Map v4 activated                               │
│           Added: social-block (3 endpoints)                  │
│           by developer@company.com  [ View diff ]           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 8. AUTO-GENERATED INCIDENT REPORT

When CHAKRA deactivates — manually or automatically — it
generates a complete incident report automatically.
Available in History screen under "View Full Report".

```
╔══════════════════════════════════════════════════════════════╗
║  CHAKRA INCIDENT REPORT                                      ║
║  Mar 21, 2026  14:32:07 – 14:51:23  (19 min 16 sec)         ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  ACTIVATION                                                  ║
║  Mode: Manual                                                ║
║  Initiated by: ops-engineer@company.com                      ║
║  RPM at activation: 79                                       ║
║  Latency P95: 580ms  (baseline 180ms — 3.2× above normal)   ║
║  Error rate: 2.1%  (baseline 0.9% — 2.3× above normal)      ║
║                                                              ║
║  PEAK CONDITIONS                                             ║
║  Max RPM: 83  at 14:38:14                                    ║
║  Max latency P95: 640ms  at 14:37:55                         ║
║  Max error rate: 2.8%  at 14:38:02                           ║
║                                                              ║
║  LEVEL TIMELINE                                              ║
║  14:32:07  Level 1 — recs-block suspended                    ║
║  14:36:44  Level 2 — browse-block limited (cached)           ║
║  14:51:23  Sleep initiated                                   ║
║  14:51:53  Restoration Step 1 — recs-block restored          ║
║  14:52:23  Restoration Step 2 — browse-block restored        ║
║  14:52:53  Fully restored — CHAKRA sleeping                  ║
║                                                              ║
║  REQUESTS HANDLED (14:32–14:51)                              ║
║  Total requests:       47,203                                ║
║  Served fully:         32,840  (69.6%)                       ║
║  Served limited:        5,943  (12.6%)                       ║
║  Suspended:             8,420  (17.8%)                       ║
║                                                              ║
║  RESCUES — REQUESTS PROTECTED FROM SUSPENSION               ║
║  By weight score:         234  (session depth + cart items)  ║
║  By policy rules:          89  (premier users + mid-checkout)║
║  Total protected:         323                                ║
║                                                              ║
║  POLICIES ACTIVE DURING INCIDENT                             ║
║  premier-users-always-served      triggered: 89 times        ║
║  protect-mid-checkout             triggered: 234 times       ║
║  cache-search-on-load             triggered: 1,204 times     ║
║                                                              ║
║  DEACTIVATION                                                ║
║  Initiated by: ops-engineer@company.com                      ║
║  Restoration: Gradual (2 steps × 30 seconds)                 ║
║  Total duration: 19 minutes 16 seconds                       ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

This report is what engineering managers, CTOs, and post-mortem
reviews need. CHAKRA generates it automatically every time.
Exportable as PDF or CSV.

---

## 9. SETTINGS SCREEN

```
┌──────────────────────────────────────────────────────────────┐
│  Settings                                                    │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  MODE                                                        │
│  ( ) Manual   (●) Auto                                       │
│                                                              │
│  AUTO ACTIVATION THRESHOLDS                                  │
│  RPM threshold:       [ 72 ]  sustained for: [ 90 ] seconds │
│  Error rate above:    [ 2.5 ]%                               │
│                                                              │
│  AUTO DEACTIVATION                                           │
│  RPM below:           [ 55 ]  sustained for: [ 60 ] seconds │
│  Restore sequence:    (●) Gradual  ( ) Immediate             │
│  Step wait:           [ 30 ] seconds                         │
│                                                              │
│  WEIGHT ENGINE THRESHOLDS                                    │
│  Serve Fully above:   [ 65 ]                                 │
│  Serve Limited above: [ 40 ]                                 │
│                                                              │
│  SHADOW MODE                                                 │
│  Minimum learning days:      [ 7 ]                           │
│  Force activate after:       [ 30 ] days                     │
│                                                              │
│  DASHBOARD                                                   │
│  Port:           [ 4242 ]                                    │
│  Auth:           (●) Enabled  ( ) Disabled                   │
│                                                              │
│  [ Save Settings ]  (takes effect immediately, no restart)   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

All settings take effect immediately without restart.

---

## 10. WHAT NEEDS TO BE BUILT

### Component: Dashboard Server
Bundled Node.js HTTP server.
Serves static frontend files from package.
Exposes REST API for frontend to consume.
WebSocket endpoint for real-time streaming during incidents.
Starts automatically on port 4242.

### Component: Dashboard API
Internal REST API consumed by frontend:
```
GET  /api/status           → current CHAKRA status
GET  /api/rpm              → current + historical RPM
GET  /api/blocks           → all block states + per-block RPM
GET  /api/policies         → active policies + suggestions
GET  /api/learning         → Shadow Mode progress
GET  /api/history          → activation events + policy changes
GET  /api/report/:id       → specific incident report

POST /api/activate         → Manual Mode activation
POST /api/deactivate       → Manual Mode sleep initiation
POST /api/policies         → create new policy
PUT  /api/policies/:name   → update policy
DELETE /api/policies/:name → remove policy
POST /api/presets/:name    → activate emergency preset
POST /api/settings         → update settings
POST /api/logs/import      → upload historical logs
```

### Component: Dashboard Frontend (React SPA)
Five screens as described above.
Built and bundled into the npm package as static files.
Developer does not need any frontend tooling to use it.
Ships pre-built inside the package.

### Component: Incident Report Generator
Triggers on CHAKRA deactivation.
Compiles data from activation event log.
Produces structured report object.
Stores in persistent history.
Exposed via dashboard API.

### Component: Real-time Stream (WebSocket)
During active incidents, streams live data to dashboard.
RPM updates every 5 seconds.
Block state changes instantly.
Policy trigger counts live.
Ops engineer sees everything happening in real time.

---

## 11. DESIGN DECISIONS MADE

1. **Dashboard ships inside the middleware package.**
   No separate installation. No cloud dependency. No extra port
   to configure. Open browser to localhost:4242. Done.
   Developer does not need frontend tooling — pre-built bundle.

2. **Header always shows status and primary action.**
   Ops engineer opens dashboard during an incident.
   The Activate button is in the header — always visible.
   Never more than zero clicks away.

3. **Ring Map rendered as actual ring diagram.**
   The Chakra metaphor made visible.
   Developer understands their app's structure intuitively.
   Colour coding matches block states in real time.

4. **Policy editor is a form, not raw YAML.**
   YAML is for the config file. The dashboard is for humans.
   Form-based editor reduces syntax errors.
   Policy tester lets developer validate before going live.

5. **Emergency presets are always visible during active incidents.**
   On the Overview screen when CHAKRA is active.
   One click. Active in 5 seconds.
   No navigation required during a crisis.

6. **Incident report generated automatically on every deactivation.**
   Developer and ops team never have to write a post-mortem
   from scratch. CHAKRA provides the data. They provide the analysis.

7. **All settings changes take effect immediately.**
   No restart. No redeployment.
   Config file also updated on disk so changes survive restart.

8. **Dashboard updates every 3 seconds normally,**
   **real-time via WebSocket during active incidents.**
   Low frequency when calm — reduces noise.
   High frequency when active — ops engineer needs live data.

---

## 12. NEXT CHECKPOINT

**CP9 — Container Bridge**
Covers: The optional integration layer that connects CHAKRA
to K8s / ECS / infrastructure. How it is structured as
pluggable adapters. What it enables vs what CHAKRA does
without it. The Prometheus adapter as the universal bridge.
Manual signal webhook for custom infrastructure.

---

## CONNECTIONS TO OTHER CHECKPOINTS

```
CP1 (Shadow Mode)      → Learning screen shows Layer progress.
                         Suggestions surface in Policies screen.
                         Log import triggers Shadow Mode ingestion.

CP2 (RPM Engine)       → RPM chart + current score in header + Overview.
                         Per-block RPM in Ring Map and block state cards.

CP2.5 (Activation)     → Activate/Sleep buttons in header.
                         Mode selection in Settings.
                         Activation thresholds configurable.

CP3 (Ring Mapper)      → Ring Map screen — visual diagram.
                         Block detail panel. Unmatched endpoints alert.
                         Version history and rollback.

CP4 (Dispatcher)       → Live stats: suspended/served/limited counts.
                         Displayed in Overview during active incidents.

CP5 (Weight Engine)    → Weight rescue count in Overview + incident report.
                         Shows developer CHAKRA's intelligence at work.

CP6 (Middleware)       → Dashboard packaged inside middleware.
                         Settings screen saves to chakra.config.yaml.

CP7 (Policy Engine)    → Policies screen — active rules, suggestions,
                         editor, emergency presets.
                         Policy trigger counts in real time.

CP9 (Container Bridge) → Optional infrastructure status shown in Overview.
                         (if adapter is configured)
```

---

*Checkpoint 8 created during Dashboard design session.*
*Previous: CHAKRA_CP7_PolicyEngine.md*
*Next: CHAKRA_CP9_ContainerBridge.md*
