import type {
  RouteInfo, SessionContext, DispatchOutcome,
  SuspendedResponse, ActivationState, DispatcherMetrics,
} from '../types';
import type { RingMapper } from './ring-mapper';

// --- Provider interfaces (dependency injection for unbuilt components) ---

/** Weight Engine provider — implemented by CP5, consumed by Dispatcher */
export interface WeightProvider {
  calculateWeight(
    routeInfo: RouteInfo,
    sessionContext: SessionContext | null,
    currentLevel: number,
  ): number;
}

/** Policy Engine provider — implemented by CP7, consumed by Dispatcher */
export interface PolicyProvider {
  evaluate(
    method: string,
    path: string,
    routeInfo: RouteInfo,
    sessionContext: SessionContext | null,
    currentLevel: number,
  ): DispatchOutcome | null;
}

/** Session Context Cache provider — implemented by CP1/CP4, consumed by Dispatcher */
export interface SessionProvider {
  getSession(sessionId: string): SessionContext | null;
}

// --- Config ---

export interface DispatcherConfig {
  ringMapper: RingMapper;
  weightOverrideHigh?: number;   // default 65
  weightOverrideLow?: number;    // default 40
  weightProvider?: WeightProvider;
  policyProvider?: PolicyProvider;
  sessionProvider?: SessionProvider;
}

// --- Constants ---

const DEFAULT_WEIGHT_HIGH = 65;
const DEFAULT_WEIGHT_LOW = 40;
const DEFAULT_HINT = 'reduce-payload';

// Pre-frozen outcome — reused on every pass-through to avoid allocation
const SERVE_FULLY: Readonly<DispatchOutcome> = Object.freeze({ type: 'SERVE_FULLY' as const });

// --- Dispatcher ---

export class Dispatcher {
  private readonly ringMapper: RingMapper;
  private readonly weightOverrideHigh: number;
  private readonly weightOverrideLow: number;

  // Pluggable providers — swappable at runtime via atomic pointer swap
  private weightProvider: WeightProvider | null;
  private policyProvider: PolicyProvider | null;
  private sessionProvider: SessionProvider | null;

  // Activation state — swapped atomically by Activation component (CP2.5)
  private activationState: Readonly<ActivationState> = Object.freeze({ active: false, currentLevel: 0 });

  // Metrics counters — synchronous increments (nanoseconds in single-threaded Node.js).
  // CP4 spec says "async" but that refers to Dashboard flush, not counting itself.
  private _metrics: DispatcherMetrics;

  constructor(config: DispatcherConfig) {
    this.ringMapper = config.ringMapper;
    this.weightOverrideHigh = config.weightOverrideHigh ?? DEFAULT_WEIGHT_HIGH;
    this.weightOverrideLow = config.weightOverrideLow ?? DEFAULT_WEIGHT_LOW;
    this.weightProvider = config.weightProvider ?? null;
    this.policyProvider = config.policyProvider ?? null;
    this.sessionProvider = config.sessionProvider ?? null;
    this._metrics = createEmptyMetrics();
  }

  // --- Hot path ---

  /**
   * Decide the outcome for a single HTTP request.
   * Budget: < 2ms total. Never throws. Read-only — no state writes.
   */
  dispatch(method: string, path: string, sessionId?: string): Readonly<DispatchOutcome> {
    try {
      this._metrics.totalRequests++;

      // STEP 1 — Activation check (< 0.1ms)
      const activation = this.activationState;
      if (!activation.active) {
        this._metrics.outcomes.serveFully++;
        return SERVE_FULLY;
      }

      // STEP 2 — Ring Map lookup (< 0.1ms)
      const routeInfo = this.ringMapper.lookup(method, path);

      // STEP 3 + 4 — Block state + suspension check (< 0.1ms)
      const blockState = this.ringMapper.getBlockState(routeInfo.block, activation.currentLevel);

      if (blockState.isActive) {
        this._metrics.outcomes.serveFully++;
        trackPerBlock(this._metrics, routeInfo.block, 'served');
        return SERVE_FULLY;
      }

      // Block is suspended — enter weight/policy evaluation

      // Get session context if available
      const session = sessionId && this.sessionProvider
        ? this.sessionProvider.getSession(sessionId)
        : null;

      // STEP 5 — Weight Engine (< 0.5ms)
      const weight = this.weightProvider
        ? this.weightProvider.calculateWeight(routeInfo, session, activation.currentLevel)
        : 0;

      // High weight overrides suspension completely
      if (weight >= this.weightOverrideHigh) {
        this._metrics.weightOverrides++;
        this._metrics.outcomes.serveFully++;
        trackPerBlock(this._metrics, routeInfo.block, 'served');
        return SERVE_FULLY;
      }

      // STEP 6 — Policy Engine (< 0.5ms)
      if (this.policyProvider) {
        const policyOutcome = this.policyProvider.evaluate(
          method, path, routeInfo, session, activation.currentLevel,
        );
        if (policyOutcome) {
          this._metrics.policyOverrides++;
          trackPolicyOutcome(this._metrics, policyOutcome, routeInfo.block);
          return Object.freeze(policyOutcome);
        }
      }

      // STEP 7 — Execute based on weight thresholds
      if (weight >= this.weightOverrideLow) {
        this._metrics.outcomes.serveLimited++;
        trackPerBlock(this._metrics, routeInfo.block, 'limited');
        return Object.freeze({
          type: 'SERVE_LIMITED' as const,
          hint: DEFAULT_HINT,
        });
      }

      // SUSPEND — build and return fallback response
      this._metrics.outcomes.suspended++;
      trackPerBlock(this._metrics, routeInfo.block, 'suspended');
      return Object.freeze({
        type: 'SUSPEND' as const,
        response: buildSuspendedResponse(this.ringMapper, routeInfo.block),
      });
    } catch {
      // Never throw from hot path — safe fallback to pass-through
      return SERVE_FULLY;
    }
  }

  // --- State management (called by background processes) ---

  /** Set activation state. Called by Activation component (CP2.5). */
  setActivationState(state: ActivationState): void {
    this.activationState = Object.freeze({ ...state });
  }

  /** Swap in a Weight Engine provider. */
  setWeightProvider(provider: WeightProvider): void {
    this.weightProvider = provider;
  }

  /** Swap in a Policy Engine provider. */
  setPolicyProvider(provider: PolicyProvider): void {
    this.policyProvider = provider;
  }

  /** Swap in a Session Context Cache provider. */
  setSessionProvider(provider: SessionProvider): void {
    this.sessionProvider = provider;
  }

  // --- Queries ---

  /** Check if CHAKRA is currently active. */
  isActive(): boolean {
    return this.activationState.active;
  }

  /** Get the current activation state snapshot. */
  getActivationState(): Readonly<ActivationState> {
    return this.activationState;
  }

  // --- Metrics ---

  /** Get a snapshot of current metrics. Returns a deep copy. */
  getMetrics(): DispatcherMetrics {
    const perBlock: Record<string, { served: number; limited: number; suspended: number }> = {};
    for (const [block, entry] of Object.entries(this._metrics.perBlock)) {
      perBlock[block] = { ...entry };
    }
    return {
      totalRequests: this._metrics.totalRequests,
      outcomes: { ...this._metrics.outcomes },
      perBlock,
      weightOverrides: this._metrics.weightOverrides,
      policyOverrides: this._metrics.policyOverrides,
    };
  }

  /** Reset all metrics counters. Called by Dashboard after flushing. */
  resetMetrics(): void {
    this._metrics = createEmptyMetrics();
  }
}

// --- Pure helpers (module-level to keep class body focused on hot path) ---

function createEmptyMetrics(): DispatcherMetrics {
  return {
    totalRequests: 0,
    outcomes: { serveFully: 0, serveLimited: 0, suspended: 0 },
    perBlock: {},
    weightOverrides: 0,
    policyOverrides: 0,
  };
}

function trackPerBlock(
  metrics: DispatcherMetrics,
  block: string,
  type: 'served' | 'limited' | 'suspended',
): void {
  let entry = metrics.perBlock[block];
  if (!entry) {
    entry = { served: 0, limited: 0, suspended: 0 };
    metrics.perBlock[block] = entry;
  }
  entry[type]++;
}

function trackPolicyOutcome(
  metrics: DispatcherMetrics,
  outcome: DispatchOutcome,
  block: string,
): void {
  switch (outcome.type) {
    case 'SERVE_FULLY':
      metrics.outcomes.serveFully++;
      trackPerBlock(metrics, block, 'served');
      break;
    case 'SERVE_LIMITED':
      metrics.outcomes.serveLimited++;
      trackPerBlock(metrics, block, 'limited');
      break;
    case 'SUSPEND':
      metrics.outcomes.suspended++;
      trackPerBlock(metrics, block, 'suspended');
      break;
  }
}

function buildSuspendedResponse(ringMapper: RingMapper, blockName: string): SuspendedResponse {
  const config = ringMapper.getSuspendedBlockConfig(blockName);
  const baseHeaders: Record<string, string> = {
    'X-Chakra-Suspended': blockName,
    'X-Chakra-Active': 'true',
  };

  if (!config) {
    return {
      status: 200,
      body: { _chakra_suspended: true, _chakra_reason: 'high_load' },
      headers: baseHeaders,
    };
  }

  switch (config.responseType) {
    case '503':
      return {
        status: 503,
        body: 'Service temporarily unavailable',
        headers: { ...baseHeaders, 'Retry-After': '30' },
      };
    case 'static':
      return {
        status: 200,
        body: config.staticResponse ?? '',
        headers: baseHeaders,
      };
    case 'cached':
      // Cached responses require cache infrastructure (future) — empty fallback
      return {
        status: 200,
        body: { _chakra_suspended: true, _chakra_reason: 'high_load', _chakra_cached: false },
        headers: baseHeaders,
      };
    case 'empty':
    default:
      return {
        status: 200,
        body: { _chakra_suspended: true, _chakra_reason: 'high_load' },
        headers: baseHeaders,
      };
  }
}

export default Dispatcher;
