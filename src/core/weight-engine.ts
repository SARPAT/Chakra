// Weight Engine — Request scoring for suspended blocks
// Pure function: calculates 0-100 weight score using 8 additive signals.
// Called by Dispatcher Step 5 only when a block is suspended.
// Budget: < 0.5ms. No external calls. No side effects.

import type { RouteInfo, SessionContext } from '../types';
import type { WeightProvider } from './dispatcher';

// --- Signal functions (exported for direct unit testing) ---

/** Signal 2: HTTP method — writes are more intentful than reads */
export function calculateMethodSignal(method: string): number {
  switch (method.toUpperCase()) {
    case 'POST':
    case 'PUT':
    case 'DELETE':
    case 'PATCH':
      return 15;
    default:
      return 0;
  }
}

/** Signal 3: Authentication — known users are worth more */
export function calculateAuthSignal(isAuthenticated: boolean): number {
  return isAuthenticated ? 10 : 0;
}

/** Signal 4: Session depth — more calls = more invested user */
export function calculateSessionDepthSignal(callCount: number): number {
  if (callCount >= 21) return 20;
  if (callCount >= 11) return 15;
  if (callCount >= 6) return 10;
  if (callCount >= 3) return 5;
  return 0;
}

/** Signal 5: Cart state — cart items = strongest commercial intent */
export function calculateCartStateSignal(cartItemCount: number): number {
  if (cartItemCount >= 6) return 30;
  if (cartItemCount >= 3) return 25;
  if (cartItemCount >= 1) return 15;
  return 0;
}

/** Signal 6: Moment of Value — Shadow Mode learned conversion proximity */
export function calculateMoVSignal(strength: 'none' | 'partial' | 'full'): number {
  switch (strength) {
    case 'full': return 30;
    case 'partial': return 15;
    default: return 0;
  }
}

/** Signal 7: User tier — business policy for premium treatment */
export function calculateTierSignal(
  userTier: string | null,
  tierConfig: Readonly<Record<string, number>>,
): number {
  if (!userTier) return 0;
  return tierConfig[userTier] ?? 0;
}

// --- Configuration ---

/** Default tier bonuses */
const DEFAULT_TIER_CONFIG: Readonly<Record<string, number>> = Object.freeze({
  standard: 0,
  premium: 40,
  enterprise: 50,
});

/** Session staleness threshold — sessions older than 30 minutes are treated as absent */
const SESSION_STALE_THRESHOLD_MS = 30 * 60 * 1000;

/** Weight Engine configuration */
export interface WeightEngineConfig {
  /** User tier bonuses by tier name. Default: standard=0, premium=40, enterprise=50 */
  tierConfig?: Record<string, number>;
  /** Per-endpoint developer weight overrides. Key: "METHOD /path", value: additive bonus */
  endpointOverrides?: Record<string, number>;
}

// --- WeightEngine class ---

export class WeightEngine implements WeightProvider {
  private readonly tierConfig: Readonly<Record<string, number>>;
  private readonly endpointOverrides: Readonly<Record<string, number>>;
  private readonly hasEndpointOverrides: boolean;

  constructor(config?: WeightEngineConfig) {
    this.tierConfig = config?.tierConfig
      ? Object.freeze({ ...config.tierConfig })
      : DEFAULT_TIER_CONFIG;
    this.endpointOverrides = config?.endpointOverrides
      ? Object.freeze({ ...config.endpointOverrides })
      : Object.freeze({});
    this.hasEndpointOverrides = Object.keys(this.endpointOverrides).length > 0;
  }

  /**
   * Calculate weight score for a request hitting a suspended block.
   * Pure function — same inputs always produce same output.
   * Budget: < 0.5ms. Never throws.
   */
  calculateWeight(
    routeInfo: RouteInfo,
    sessionContext: SessionContext | null,
    _currentLevel: number,
    method: string,
    path: string,
  ): number {
    try {
      // Normalise method once — avoids duplicate toUpperCase() allocations
      const upperMethod = method.toUpperCase();

      // Signal 1 — Block Base Weight (from Ring Map)
      let weight = routeInfo.weightBase;

      // Signal 2 — HTTP Method (+15 for writes)
      weight += calculateMethodSignal(upperMethod);

      // Session staleness check — treat stale sessions as absent
      const session = sessionContext && !isSessionStale(sessionContext)
        ? sessionContext
        : null;

      // Signal 3 — Authentication (proxy: session with callCount > 0)
      // Design decision: real isAuthenticated from request headers is not available
      // via WeightProvider interface. Using session presence as proxy means anonymous
      // returning visitors observed by Shadow Mode get +10 bonus. This is acceptable:
      // returning visitors with session history have demonstrated engagement.
      const isAuthenticated = session != null && session.callCount > 0;
      weight += calculateAuthSignal(isAuthenticated);

      // Signals 4–7 — Session-derived signals (default to 0 if no session)
      if (session) {
        weight += calculateSessionDepthSignal(session.callCount);
        weight += calculateCartStateSignal(session.cartItemCount);
        weight += calculateMoVSignal(session.momentOfValueStrength);
        weight += calculateTierSignal(session.userTier, this.tierConfig);
      }

      // Signal 8 — Developer endpoint override (skip allocation when no overrides configured)
      if (this.hasEndpointOverrides) {
        const endpointKey = `${upperMethod} ${path}`;
        weight += this.endpointOverrides[endpointKey] ?? 0;
      }

      // Cap at 100, floor at 0
      return Math.min(Math.max(weight, 0), 100);
    } catch {
      // Never throw from Weight Engine — return base weight as safe fallback
      return Math.min(Math.max(routeInfo.weightBase, 0), 100);
    }
  }

  /** Get the current tier configuration (for Dashboard display) */
  getTierConfig(): Readonly<Record<string, number>> {
    return this.tierConfig;
  }

  /** Get endpoint overrides (for Dashboard display) */
  getEndpointOverrides(): Readonly<Record<string, number>> {
    return this.endpointOverrides;
  }
}

// --- Helpers ---

function isSessionStale(session: SessionContext): boolean {
  // lastSeenTime undefined/null → time not tracked, assume fresh
  // lastSeenTime 0 → epoch, treat as stale (no valid session has epoch timestamp)
  if (session.lastSeenTime == null) return false;
  if (session.lastSeenTime === 0) return true;
  return (Date.now() - session.lastSeenTime) > SESSION_STALE_THRESHOLD_MS;
}

export default WeightEngine;
