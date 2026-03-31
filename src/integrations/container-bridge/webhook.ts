// Webhook Adapter — POST endpoint for custom infrastructure signals
//
// The simplest adapter. CHAKRA exposes a POST endpoint that any external
// monitoring system can push signals to. Covers any exotic or custom
// infrastructure that the other adapters don't handle.
//
// Signal has a TTL — if monitoring stops sending, CHAKRA falls back to
// RPM-only after the TTL expires. Never stuck in a stale hold state.

import type {
  InfrastructureAdapter,
  InfrastructureSnapshot,
  BoolSignal,
  NumberSignal,
} from '../adapter-interface';

// ─── Webhook signal payload ────────────────────────────────────────────────────

export interface WebhookSignalPayload {
  scaling_in_progress: boolean;
  estimated_ready_seconds?: number | null;
  capacity_limit_reached: boolean;
  /** Human-readable source label — logged only, not used in logic */
  source?: string;
  /** How long (seconds) this signal is valid. Defaults to 30. */
  ttl_seconds?: number;
}

const DEFAULT_TTL_SECONDS = 30;

// ─── WebhookAdapter ────────────────────────────────────────────────────────────

export class WebhookAdapter implements InfrastructureAdapter {
  private lastSignal: WebhookSignalPayload | null = null;
  private signalReceivedAt: number | null = null;

  // ─── Signal ingestion (called by DashboardServer route handler) ──────────────

  /**
   * Record an incoming infrastructure signal.
   * Called by POST /api/infrastructure-signal.
   * Returns true if the payload is valid, false otherwise.
   */
  receiveSignal(payload: unknown): boolean {
    if (!this.isValidPayload(payload)) return false;

    const p = payload as WebhookSignalPayload;
    this.lastSignal = {
      scaling_in_progress: p.scaling_in_progress,
      estimated_ready_seconds: p.estimated_ready_seconds ?? null,
      capacity_limit_reached: p.capacity_limit_reached,
      source: p.source,
      ttl_seconds: typeof p.ttl_seconds === 'number' && p.ttl_seconds > 0
        ? p.ttl_seconds
        : DEFAULT_TTL_SECONDS,
    };
    this.signalReceivedAt = Date.now();
    return true;
  }

  // ─── InfrastructureAdapter implementation ────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    return this.getFreshSignal() !== null;
  }

  async isScalingInProgress(): Promise<BoolSignal> {
    const signal = this.getFreshSignal();
    if (signal === null) return { value: null, confidence: 'unknown' };
    return { value: signal.scaling_in_progress, confidence: 'high' };
  }

  async estimatedReadySeconds(): Promise<NumberSignal> {
    const signal = this.getFreshSignal();
    if (signal === null || !signal.scaling_in_progress) {
      return { value: null, confidence: 'unknown' };
    }
    return {
      value: signal.estimated_ready_seconds ?? null,
      confidence: signal.estimated_ready_seconds != null ? 'medium' : 'unknown',
    };
  }

  async isAtCapacityLimit(): Promise<BoolSignal> {
    const signal = this.getFreshSignal();
    if (signal === null) return { value: null, confidence: 'unknown' };
    return { value: signal.capacity_limit_reached, confidence: 'high' };
  }

  async getSnapshot(): Promise<InfrastructureSnapshot> {
    const signal = this.getFreshSignal();
    const now = Date.now();

    if (signal === null) {
      return {
        scalingInProgress: { value: null, confidence: 'unknown' },
        estimatedReadySeconds: { value: null, confidence: 'unknown' },
        atCapacityLimit: { value: null, confidence: 'unknown' },
        capturedAt: now,
        summary: 'No fresh webhook signal received',
      };
    }

    const ageSeconds = this.signalReceivedAt !== null
      ? Math.round((now - this.signalReceivedAt) / 1000)
      : 0;

    return {
      scalingInProgress: { value: signal.scaling_in_progress, confidence: 'high' },
      estimatedReadySeconds: {
        value: signal.estimated_ready_seconds ?? null,
        confidence: signal.estimated_ready_seconds != null ? 'medium' : 'unknown',
      },
      atCapacityLimit: { value: signal.capacity_limit_reached, confidence: 'high' },
      capturedAt: now,
      summary: `Webhook signal from ${signal.source ?? 'unknown'} (${ageSeconds}s ago)`,
    };
  }

  // ─── TTL helpers ──────────────────────────────────────────────────────────────

  /** Returns the last signal only if it is still within its TTL window. */
  private getFreshSignal(): WebhookSignalPayload | null {
    if (this.lastSignal === null || this.signalReceivedAt === null) return null;

    const ttlMs = (this.lastSignal.ttl_seconds ?? DEFAULT_TTL_SECONDS) * 1_000;
    const ageMs = Date.now() - this.signalReceivedAt;

    return ageMs <= ttlMs ? this.lastSignal : null;
  }

  /** Returns the raw last signal and its received timestamp, regardless of TTL. */
  getLastSignalRaw(): { signal: WebhookSignalPayload; receivedAt: number } | null {
    if (this.lastSignal === null || this.signalReceivedAt === null) return null;
    return { signal: this.lastSignal, receivedAt: this.signalReceivedAt };
  }

  // ─── Payload validation ───────────────────────────────────────────────────────

  private isValidPayload(payload: unknown): boolean {
    if (typeof payload !== 'object' || payload === null) return false;
    const p = payload as Record<string, unknown>;
    if (typeof p['scaling_in_progress'] !== 'boolean') return false;
    if (typeof p['capacity_limit_reached'] !== 'boolean') return false;
    if (
      p['estimated_ready_seconds'] !== undefined &&
      p['estimated_ready_seconds'] !== null &&
      typeof p['estimated_ready_seconds'] !== 'number'
    ) return false;
    if (
      p['ttl_seconds'] !== undefined &&
      typeof p['ttl_seconds'] !== 'number'
    ) return false;
    return true;
  }
}
