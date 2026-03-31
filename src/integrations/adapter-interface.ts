// Adapter Interface — Base interface for all container bridge adapters
//
// All adapters answer the same three questions that the Auto Mode
// Activation Gate (CP2.5) asks about infrastructure state.
// New adapters can be added without touching any other component.

// ─── Signal value types ────────────────────────────────────────────────────────

/**
 * Tri-state result with confidence level.
 * 'unknown' means the adapter could not determine the value.
 */
export type TriState = 'yes' | 'no' | 'unknown';

export type Confidence = 'high' | 'medium' | 'low' | 'unknown';

export interface BoolSignal {
  value: boolean | null;   // null when unknown
  confidence: Confidence;
}

export interface NumberSignal {
  value: number | null;    // null when unknown
  confidence: Confidence;
}

// ─── Infrastructure snapshot ──────────────────────────────────────────────────

/**
 * Snapshot of infrastructure state at a point in time.
 * This is what the Activation Gate reads.
 */
export interface InfrastructureSnapshot {
  scalingInProgress: BoolSignal;
  estimatedReadySeconds: NumberSignal;
  atCapacityLimit: BoolSignal;
  /** ISO timestamp of when this snapshot was taken */
  capturedAt: number;
  /** Human-readable description of current infra state (for dashboard) */
  summary?: string;
}

// ─── Adapter interface ────────────────────────────────────────────────────────

/**
 * Base interface all Container Bridge adapters must implement.
 * Each adapter reads infrastructure state from a different source
 * but always answers the same three questions.
 */
export interface InfrastructureAdapter {
  /**
   * Whether scaling activity is currently in progress.
   * e.g. K8s desiredReplicas > currentReplicas
   */
  isScalingInProgress(): Promise<BoolSignal>;

  /**
   * Estimated seconds until new capacity is ready.
   * null when no scaling is in progress or estimate is unavailable.
   */
  estimatedReadySeconds(): Promise<NumberSignal>;

  /**
   * Whether the infrastructure has reached its scaling limit
   * and cannot add more capacity.
   * e.g. K8s currentReplicas >= maxReplicas
   */
  isAtCapacityLimit(): Promise<BoolSignal>;

  /**
   * Whether the adapter can currently reach its data source.
   * Returns false on network errors, auth failures, etc.
   * CHAKRA falls back to RPM-only when this returns false.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Fetch a complete snapshot in one call.
   * Adapters may implement this more efficiently than three separate calls.
   */
  getSnapshot(): Promise<InfrastructureSnapshot>;
}
