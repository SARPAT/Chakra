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
