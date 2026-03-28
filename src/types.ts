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
  status: number;
  body: unknown;
  headers?: Record<string, string>;
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
  phase: 1 | 2 | 3;        // cold start phase
}

/** Block state — determines current active level per block */
export interface BlockState {
  block: string;
  currentLevel: number;
  isActive: boolean;
  isSuspended: boolean;
}

/** Parameters for recording a request in the RPM Engine's signal collector */
export interface RecordRequestParams {
  endpoint: string;
  block: string;
  responseTimeMs: number;
  statusCode: number;
}

/** Baseline configuration for RPM Engine — provided by Shadow Mode or defaults */
export interface BaselineConfig {
  requestRateBaseline: number;    // requests per minute
  latencyP95Baseline: number;     // milliseconds
  errorRateBaseline: number;      // percentage (0-100)
}

// --- Ring Mapper types ---

/** How to handle requests to endpoints not in the Ring Map */
export type UnmatchedEndpointMode = 'default-block' | 'outermost-level' | 'alert-only';

/** What response type to return when a block is suspended */
export type SuspendedBlockResponseType = 'empty' | 'cached' | 'static' | '503';

/** Per-block suspension response configuration */
export interface SuspendedBlockConfig {
  responseType: SuspendedBlockResponseType;
  staticResponse?: string;
  cacheMaxAgeSeconds?: number;
}

/** Developer's block definition input */
export interface BlockDefinition {
  name?: string;
  endpoints: string[];
  minLevel: number;             // 0 = never suspend, 3 = first to go
  weightBase: number;           // 0-100
  whenSuspended?: SuspendedBlockConfig;
}

/** Full Ring Map configuration input */
export interface RingMapConfig {
  blocks?: Record<string, BlockDefinition>;
  unmatchedEndpointHandling?: UnmatchedEndpointMode;
  maxVersionHistory?: number;
}

/** Computed state at a given degradation level */
export interface LevelState {
  level: number;
  activeBlocks: readonly string[];
  suspendedBlocks: readonly string[];
}

// --- Dashboard types ---

/** A single RPM reading stored for historical chart display */
export interface RPMHistoryEntry {
  timestamp: number;
  rpm: number;
}

/** Auto-generated incident report produced on every CHAKRA deactivation */
export interface IncidentReport {
  id: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  mode: 'manual' | 'auto';
  initiatedBy?: string;
  triggerReason?: string;
  rpmAtActivation: number;
  peakRpm: number;
  levelTimeline: Array<{ timestamp: number; level: number; note?: string }>;
  requests: {
    total: number;
    serveFully: number;
    serveLimited: number;
    suspended: number;
  };
  weightRescues: number;
  policyRescues: number;
}

// --- Dispatcher types ---

/** Activation state — Activation component writes, Dispatcher reads */
export interface ActivationState {
  active: boolean;
  currentLevel: number;   // 0-3
}

/** Dispatcher metrics — Dispatcher produces, Dashboard reads */
export interface DispatcherMetrics {
  totalRequests: number;
  outcomes: {
    serveFully: number;
    serveLimited: number;
    suspended: number;
  };
  perBlock: Record<string, { served: number; limited: number; suspended: number }>;
  weightOverrides: number;
  policyOverrides: number;
}
