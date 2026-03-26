// Key Data Interfaces — shared between components
// These are locked before any component is built.

/** Session context — Shadow Mode writes, Dispatcher reads */
export interface SessionContext {
  callCount: number;
  hasCartItems: boolean;
  cartItemCount: number;
  matchesMomentOfValue: boolean;
  momentOfValueStrength: 'none' | 'partial' | 'full';
  recentEndpoints: string[];
  userTier: string | null;
  sessionAgeSeconds: number;
  lastSeenTime: number;
}

/** Ring Map lookup result — Ring Mapper produces, Dispatcher reads */
export interface RouteInfo {
  block: string;
  minLevel: number;      // 0 = never suspend, 3 = first to go
  weightBase: number;    // 0-100, developer-set importance
}

/** Suspended response returned to client when request is blocked */
export interface SuspendedResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
}

/** Dispatcher outcome */
export type DispatchOutcome =
  | { type: 'SERVE_FULLY' }
  | { type: 'SERVE_LIMITED'; hint: string }
  | { type: 'SUSPEND'; response: SuspendedResponse };

/** RPM state — RPM Engine writes, Dispatcher reads */
export interface RPMState {
  global: number;           // 0-100
  perBlock: Record<string, number>;
  updatedAt: number;
}

/** Block state — determines current active level per block */
export interface BlockState {
  block: string;
  currentLevel: number;
  isActive: boolean;
  isSuspended: boolean;
}
