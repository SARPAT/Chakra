# PROJECT CHAKRA
## Checkpoint 9 — Container Bridge (Optional Infrastructure Awareness)
### Status: DISCUSSION COMPLETE → READY TO BUILD
### Position in Build Order: NINTH (last)
### Priority: OPTIONAL — CHAKRA is complete without this

---

## What The Container Bridge Is — And What It Is Not

CHAKRA does not manage infrastructure.
CHAKRA never touches containers.
CHAKRA never scales pods.
CHAKRA never calls K8s to do anything.

The Container Bridge does exactly one thing:

> Read infrastructure signals — optionally — to make
> CHAKRA's Auto Mode activation decisions more precise.

Without the Container Bridge:
CHAKRA works completely. RPM Engine drives all decisions.
Manual Mode activates on human decision.
Auto Mode activates on RPM thresholds.
The product is fully functional.

With the Container Bridge:
CHAKRA gains one additional piece of intelligence — it knows
what the infrastructure is doing. Is K8s scaling? Are new pods
coming? How long until they're ready? This lets CHAKRA hold
its activation when infrastructure is about to self-heal —
and activate immediately when infrastructure is clearly losing.

Optional enhancement. Not a requirement. Ships last.

---

## 1. THE INTERFACE — THREE QUESTIONS ONLY

The Container Bridge has one job: answer three questions
that the Auto Mode Activation Gate (CP2.5) asks.

```
Question 1: Is scaling activity currently in progress?
            Returns: "yes" / "no" / "unknown"

Question 2: If yes — estimated seconds until new capacity ready?
            Returns: number of seconds / "unknown"

Question 3: Is scaling hitting its limit?
            Returns: "yes" (at max capacity) / "no" / "unknown"
```

That is all CHAKRA needs from infrastructure.
Everything else is the adapter's internal concern.

Different adapters answer these questions differently.
The activation gate receives the same three answers
regardless of which adapter is configured underneath.

---

## 2. THE FOUR ADAPTERS

---

### ADAPTER 1 — Kubernetes Adapter

**What it reads:** Kubernetes API directly.
**Most precise option** for teams running on K8s.

API calls made (read-only):
```
# HPA status — is autoscaler working?
GET /apis/autoscaling/v2/namespaces/{namespace}/horizontalpodautoscalers

Extracts:
  status.currentReplicas   → how many pods running now
  status.desiredReplicas   → how many pods K8s wants
  spec.maxReplicas         → scaling ceiling

# Pod status — how far along is scaling?
GET /api/v1/namespaces/{namespace}/pods?labelSelector={app}

Extracts:
  pods with phase: Pending         → scheduled, not started
  pods with state: ContainerCreating → starting up
  Average pod start time           → learned from observation history
```

How the three questions are answered:
```
Scaling in progress?
  desiredReplicas > currentReplicas → yes

Estimated time?
  (pendingPods + creatingPods) exist
  → estimate based on historical average pod start time
  → tracked by adapter over time, improves with each scaling event

At limit?
  currentReplicas >= maxReplicas → yes
  (K8s cannot scale further — CHAKRA should activate immediately)
```

Configuration:
```yaml
infrastructure:
  type: "kubernetes"
  namespace: "production"
  deployment_names:             # filter to specific deployments
    - "my-app-backend"
    - "my-app-api"
  hold_for_scaling_max_seconds: 120   # wait max 2 min before activating

  # Authentication — choose one:
  # Option A: In-cluster (when CHAKRA runs inside K8s)
  auth: "in-cluster"
  # Option B: External kubeconfig
  auth: "kubeconfig"
  kubeconfig_path: "~/.kube/config"
  # Option C: Token
  auth: "token"
  host_env: "CHAKRA_K8S_HOST"
  token_env: "CHAKRA_K8S_TOKEN"
```

---

### ADAPTER 2 — ECS / Fargate Adapter

**What it reads:** AWS ECS API + optionally CloudWatch.
**For teams running on AWS ECS.**

API calls made (read-only):
```
# ECS service status
DescribeServices API
  cluster: production-cluster
  services: [my-app-service]

Extracts:
  runningCount    → pods running now
  desiredCount    → pods wanted
  pendingCount    → pods launching
```

How the three questions are answered:
```
Scaling in progress?
  desiredCount > runningCount → yes

Estimated time?
  pendingCount > 0
  → estimate based on Fargate average task start time (~30-90 sec)
  → learned from observation over time

At limit?
  AWS service quotas / task limits
  → detected via DescribeServices capacity provider info
```

Configuration:
```yaml
infrastructure:
  type: "ecs"
  region: "ap-south-1"
  cluster: "production-cluster"
  service_names:
    - "my-app-service"
  hold_for_scaling_max_seconds: 150   # Fargate is slower — give more time
  # Credentials via AWS environment variables or IAM role:
  # AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN
  # or attach IAM role with ecs:DescribeServices permission
```

---

### ADAPTER 3 — Generic Prometheus Adapter

**The most universally useful adapter.**
Almost every infrastructure platform — K8s, ECS, GKE, bare metal,
custom setups — can expose a Prometheus metrics endpoint.
If CHAKRA can read Prometheus, it can read almost anything.

Developer points CHAKRA at their Prometheus endpoint.
CHAKRA queries standard scaling-related metrics.

Standard Kubernetes metrics in Prometheus:
```
kube_deployment_status_replicas_ready
kube_deployment_status_replicas_unavailable
kube_horizontalpodautoscaler_status_current_replicas
kube_horizontalpodautoscaler_status_desired_replicas
kube_horizontalpodautoscaler_spec_max_replicas
```

How the three questions are answered:
```
Scaling in progress?
  desired_replicas > current_ready_replicas → yes

Estimated time?
  unavailable_replicas > 0
  → estimate from historical pod start rate (Prometheus counter)

At limit?
  current_replicas >= max_replicas → yes
```

Configuration:
```yaml
infrastructure:
  type: "prometheus"
  endpoint: "http://prometheus.monitoring.svc:9090"
  hold_for_scaling_max_seconds: 120

  # Optional auth
  bearer_token_env: "CHAKRA_PROM_TOKEN"

  # Metric name overrides (if using non-standard names)
  metrics:
    ready_replicas: "kube_deployment_status_replicas_ready"
    unavailable_replicas: "kube_deployment_status_replicas_unavailable"
    desired_replicas: "kube_horizontalpodautoscaler_status_desired_replicas"
    current_replicas: "kube_horizontalpodautoscaler_status_current_replicas"
    max_replicas: "kube_horizontalpodautoscaler_spec_max_replicas"
```

Why this adapter matters:
For the many companies that don't use standard K8s or ECS —
custom infrastructure, hybrid setups, on-premise deployments —
Prometheus is the closest thing to a universal standard
that exists in infrastructure monitoring today.
One adapter. Covers almost everything.

---

### ADAPTER 4 — Manual Signal Webhook

**For teams with exotic setups.** Custom infrastructure,
proprietary orchestration, unusual combinations of tools.
Anything the other three adapters don't cover.

CHAKRA exposes one HTTP endpoint.
The company's own monitoring system pushes signals to it.
CHAKRA receives the answers to its three questions
without caring where they came from.

```
POST http://localhost:4242/api/infrastructure-signal
Content-Type: application/json

{
  "scaling_in_progress": true,
  "estimated_ready_seconds": 90,
  "capacity_limit_reached": false,
  "source": "our-custom-monitor",    // logged only — not used in logic
  "ttl_seconds": 30                  // signal expires after this if not refreshed
}
```

The company writes one small script that bridges their
monitoring system to this endpoint. Works with:
- Custom Python monitoring scripts
- Datadog webhook forwarding
- Ansible playbooks
- Any system that can make an HTTP POST

TTL is critical — if the monitoring system stops sending signals,
CHAKRA falls back to RPM-only after TTL expires.
Signal never gets permanently stuck in a stale state.

No configuration needed beyond enabling the endpoint:
```yaml
infrastructure:
  type: "webhook"
  hold_for_scaling_max_seconds: 120
  # endpoint auto-enabled at /api/infrastructure-signal
```

---

## 3. THE ADAPTER FALLBACK CHAIN

CHAKRA checks adapters in this order on each Auto Mode evaluation:

```
Priority order:

1. Configured specific adapter (K8s / ECS / Prometheus)
   Available and responding? → use it. Most precise.

2. Manual signal webhook
   Fresh signal received within TTL? → use it.

3. Fallback — RPM Engine only.
   No adapter configured / not responding / no fresh signal.
   Time-based activation gate from CP2.5.
   Works correctly. Slightly less precise.
   DEFAULT STATE for all installations.
```

Every CHAKRA installation defaults to Step 3.
Adapters are added when teams want extra precision.
Nothing breaks on any transition between levels.
Adding adapter config and restarting unlocks the next level.

---

## 4. HOW CONTAINER BRIDGE MODIFIES AUTO MODE ACTIVATION

With Container Bridge active, the activation gate
from CP2.5 gains the infrastructure awareness condition:

WITHOUT Container Bridge (default behaviour):
```
Activate when:
  RPM > threshold
  AND sustained for N seconds
```

WITH Container Bridge:
```
HOLD if:
  RPM > threshold AND sustained for N seconds
  BUT scaling_in_progress = yes
  AND estimated_ready_seconds < hold_for_scaling_max_seconds

  → Check again every 10 seconds.

ACTIVATE if:
  RPM > threshold AND sustained for N seconds
  AND (no scaling in progress
       OR scaling in progress but capacity_limit_reached = yes
       OR scaling was in progress but max hold time exceeded
       OR RPM still climbing despite scaling completing)
```

The hold-and-evaluate behaviour:
```
14:30:00  RPM crosses threshold. K8s adapter reports: 6 pods starting.
14:30:00  CHAKRA holds. "K8s scaling — 6 pods, ~45 sec estimated."
14:30:10  Re-evaluate. Pods still starting. RPM 76. Still hold.
14:30:20  Re-evaluate. Pods still starting. RPM 78. Still hold.
14:30:45  Re-evaluate. 6 new pods now running. RPM dropping.
14:30:45  RPM at 65 and falling. Activation cancelled. ✅
          K8s won. CHAKRA correctly stayed out of the way.

OR:

14:30:00  RPM crosses threshold. K8s adapter reports: 6 pods starting.
14:30:00  CHAKRA holds.
14:31:30  Re-evaluate. All 6 pods running. RPM still 82. Still high.
14:31:30  K8s scaling completed. Still stressed. CHAKRA activates. ✅
          Infrastructure couldn't keep up. CHAKRA correctly stepped in.
```

---

## 5. THE `hold_for_scaling_max_seconds` SETTING

This setting prevents CHAKRA from holding indefinitely.

If set to 0:
  Container Bridge information is received and logged.
  But CHAKRA never holds for infrastructure scaling.
  Activates on RPM threshold alone.
  Useful for teams that want infrastructure observability
  in the dashboard without changing activation behaviour.

If set to 120 (default):
  CHAKRA holds up to 2 minutes for K8s to resolve the stress.
  After 2 minutes — activates regardless of what K8s is doing.

Developer tunes this based on their infrastructure's speed:
```
Fast infrastructure (pre-warmed nodes, Fargate):
  hold_for_scaling_max_seconds: 60    # 1 minute is enough

Normal K8s with node provisioning:
  hold_for_scaling_max_seconds: 180   # 3 minutes

Slow infrastructure (cold VMs, manual processes):
  hold_for_scaling_max_seconds: 0     # don't wait, activate immediately
```

---

## 6. DASHBOARD — INFRASTRUCTURE PANEL

If Container Bridge is configured, Overview screen
gains an infrastructure status panel:

```
NORMAL STATE (no scaling):
┌──────────────────────────────────────────────────┐
│  INFRASTRUCTURE  (Kubernetes — production)       │
│  my-app-backend: 8 pods running  ✅              │
│  HPA: stable (8/8 ready, max: 20)               │
└──────────────────────────────────────────────────┘

SCALING IN PROGRESS:
┌──────────────────────────────────────────────────┐
│  INFRASTRUCTURE  (Kubernetes — production)  ↑    │
│  my-app-backend: 8/12 pods ready             │   │
│  4 pods starting (~45 sec estimated)         │   │
│  HPA: scaling (target: 12, max: 20)          │   │
│                                              │   │
│  CHAKRA: Holding activation.                 │   │
│  "K8s scaling in progress. Waiting 60 sec."  │   │
└──────────────────────────────────────────────────┘

AT SCALING LIMIT:
┌──────────────────────────────────────────────────┐
│  INFRASTRUCTURE  (Kubernetes — production)  ⚠    │
│  my-app-backend: 20/20 pods (AT MAX)            │
│  HPA: at maxReplicas — cannot scale further     │
│                                                  │
│  CHAKRA: Activating now.                        │
│  "Infrastructure at limit. CHAKRA stepping in." │
└──────────────────────────────────────────────────┘
```

Full transparency. Every decision explained in plain language.
Developer and ops team always know why CHAKRA did what it did.

---

## 7. WHAT NEEDS TO BE BUILT

### Component: Adapter Interface
Defines the standard interface all adapters implement:
```javascript
class InfrastructureAdapter {
  async isScalingInProgress()    → { value: bool, confidence: string }
  async estimatedReadySeconds()  → { value: number|null, confidence: string }
  async isAtCapacityLimit()      → { value: bool, confidence: string }
  async isAvailable()            → bool
}
```

### Component: Kubernetes Adapter
Implements InfrastructureAdapter.
Reads K8s API (HPA + Pod endpoints).
Tracks historical pod start times to improve estimates.
Handles in-cluster and out-of-cluster auth.

### Component: ECS Adapter
Implements InfrastructureAdapter.
Reads AWS ECS DescribeServices API.
Uses AWS SDK v3 (lightweight).

### Component: Prometheus Adapter
Implements InfrastructureAdapter.
Reads any Prometheus /api/v1/query endpoint.
Configurable metric names for non-standard setups.

### Component: Webhook Receiver
Exposes POST /api/infrastructure-signal endpoint.
Validates incoming signal structure.
Stores with TTL (auto-expires stale signals).
Implements InfrastructureAdapter for webhook signals.

### Component: Adapter Manager
Reads config to determine which adapter to use.
Instantiates the configured adapter.
Manages the fallback chain.
Feeds answers to Auto Mode Activation Gate (CP2.5).
Exposes infrastructure state to Dashboard API (CP8).

---

## 8. RELEASE PRIORITY — SHIP IN STAGES

```
Release 1 (MVP — ships with everything else):
  ✅ Webhook Receiver (Manual Signal)
     Simplest to build. Single POST endpoint.
     Covers any exotic or custom infrastructure.
     Zero adapter complexity.

Release 2 (after MVP is stable):
  ✅ Kubernetes Adapter
     Largest market. Most teams running K8s.
     Highest impact adapter.

Release 3:
  ✅ Prometheus Adapter
     Near-universal coverage.
     Covers K8s, ECS, GKE, bare metal, custom setups.
     Any team with Prometheus can use this.

Release 4 (if demand exists):
  ✅ ECS Adapter
     For teams specifically on AWS ECS without Prometheus.
     Smaller market than K8s but significant.
```

CHAKRA ships fully functional at Release 1 without
any infrastructure adapter. The webhook receiver
is a bonus that covers exotic setups immediately.

---

## 9. DESIGN DECISIONS MADE

1. **Container Bridge is permanently optional.**
   CHAKRA is complete without it. This never changes.
   Teams should never feel they need the Container Bridge
   to use CHAKRA properly. It is an enhancement, not a requirement.

2. **One interface, four adapters.**
   Activation gate always talks to the same interface.
   New adapters can be added without touching any other code.
   Community could contribute adapters for Nomad, Fly.io,
   custom platforms — the architecture supports it cleanly.

3. **Three questions only.**
   The interface is minimal by design. CHAKRA does not need
   to understand infrastructure deeply. It needs three answers.
   This keeps adapters simple and easy to implement and test.

4. **Signal TTL on webhook prevents stale state.**
   If the company's monitoring system stops sending signals,
   CHAKRA falls back to RPM-only after TTL. Never permanently
   stuck in an incorrect hold state.

5. **`hold_for_scaling_max_seconds: 0` disables holding.**
   Teams that want infrastructure visibility in the dashboard
   without changing activation behaviour can set this to 0.
   Observability and behaviour are independently controllable.

6. **Adapter failure → fallback silently.**
   If the K8s adapter loses connectivity, CHAKRA logs a warning
   and falls back to RPM-only activation. No crash.
   No user-visible impact. Same self-healing philosophy as
   the rest of CHAKRA (CP6 — CHAKRA never fails the app).

7. **Webhook ships with Release 1.**
   It is so simple to build (one POST endpoint + TTL store)
   that shipping it with the MVP costs almost nothing.
   But it immediately covers all exotic infrastructure setups.
   No team is ever completely without a Container Bridge option.

8. **Dashboard makes every decision transparent.**
   When CHAKRA holds for infrastructure, the dashboard says why.
   When CHAKRA activates despite scaling, the dashboard says why.
   Every decision is explained in plain language.
   Trust requires transparency.

---

## 10. THE BLUEPRINT IS COMPLETE

CP9 is the final checkpoint. The complete CHAKRA blueprint
is now documented across 10 checkpoint files.

```
COMPLETE CHECKPOINT STACK:

CP0  Foundation & Vision
CP1  Shadow Mode (Silent Student)
CP2  RPM Engine (Load Sensor)
CP2.5 Activation Modes & Strategy Engine
CP3  Ring Mapper
CP4  Dispatcher (Hot Path)
CP5  Weight Engine
CP6  Middleware Package (Front Door)
CP7  Policy Engine
CP8  Dashboard (Control Room)
CP9  Container Bridge (Optional Infrastructure Awareness)
```

BUILD ORDER FOR CODING AGENTS:

```
Phase 1 — Core Infrastructure (CP2, CP1, CP3)
  1. RPM Engine — the foundation signal
  2. Shadow Mode Observer — starts collecting immediately
  3. Ring Mapper — compile lookup table from annotations

Phase 2 — The Hot Path (CP4, CP5, CP7)
  4. Dispatcher — the request routing engine
  5. Weight Engine — request scoring
  6. Policy Engine — business rule enforcement

Phase 3 — The Shell (CP6, CP2.5)
  7. Middleware Package — wire everything together
  8. Activation Modes — Manual + Auto gate logic

Phase 4 — The Face (CP8)
  9. Dashboard — control room web UI

Phase 5 — Enhancement (CP9)
  10. Container Bridge — optional infrastructure awareness
      Start with Webhook Receiver (simplest)
      Then Kubernetes Adapter
      Then Prometheus Adapter
```

Each phase is independently deployable and testable.
A coding agent can work through phases sequentially,
validating each before moving to the next.

---

## CONNECTIONS TO OTHER CHECKPOINTS

```
CP2 (RPM Engine)     → RPM signals drive activation alongside
                       Container Bridge signals.

CP2.5 (Activation)   → Activation Gate is the primary consumer
                       of Container Bridge output.
                       Hold/activate decision lives here.

CP6 (Middleware)     → Adapter Manager initialised at startup.
                       Adapter config read from chakra.config.yaml.
                       Adapter failure handled gracefully (CP6 rules).

CP8 (Dashboard)      → Infrastructure panel in Overview screen.
                       Shows scaling status, CHAKRA hold decisions.
                       Webhook signal status.
```

---

*Checkpoint 9 created during Container Bridge design session.*
*This is the final checkpoint. Blueprint is complete.*
*Previous: CHAKRA_CP8_Dashboard.md*
*Next: Begin build — start with CHAKRA_CP2_RPMEngine.md*
