// AdapterManager — Fallback chain for Container Bridge adapters
//
// Checks adapters in priority order on each evaluation:
//   1. Configured specific adapter (K8s / ECS / Prometheus) — most precise
//   2. Webhook adapter — fresh signal within TTL
//   3. Fallback — no infrastructure signal available
//
// The Activation Gate (CP2.5) always calls AdapterManager.getSnapshot().
// AdapterManager handles all fallback logic internally.
//
// Adapter failure → silent fallback to next level. CHAKRA never crashes.

import type { InfrastructureAdapter, InfrastructureSnapshot } from '../adapter-interface';
import type { WebhookAdapter } from './webhook';
import type { ChakraConfig } from '../../config/loader';
import { logger } from '../../utils/logger';

// ─── Hold decision ────────────────────────────────────────────────────────────

/**
 * What the Activation Gate should do with this infrastructure state.
 */
export type HoldDecision =
  | { hold: false; reason: string }
  | { hold: true; estimatedReadySeconds: number | null; reason: string };

// ─── AdapterManager ───────────────────────────────────────────────────────────

export class AdapterManager {
  /** Optional primary adapter (K8s / ECS / Prometheus) */
  private primaryAdapter: InfrastructureAdapter | null = null;
  /** Webhook adapter is always present (cheapest, no external dependencies) */
  private readonly webhookAdapter: WebhookAdapter;
  /** Whether the primary adapter was available on last check */
  private primaryAvailable = false;
  /** Last successful snapshot for dashboard reads */
  private lastSnapshot: InfrastructureSnapshot | null = null;

  constructor(webhookAdapter: WebhookAdapter, primaryAdapter?: InfrastructureAdapter) {
    this.webhookAdapter = webhookAdapter;
    this.primaryAdapter = primaryAdapter ?? null;
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Get the current infrastructure snapshot from the best available adapter.
   * Always returns a snapshot — falls back through chain gracefully.
   */
  async getSnapshot(): Promise<InfrastructureSnapshot> {
    // Try primary adapter first
    if (this.primaryAdapter !== null) {
      try {
        const available = await this.primaryAdapter.isAvailable();
        this.primaryAvailable = available;

        if (available) {
          const snapshot = await this.primaryAdapter.getSnapshot();
          this.lastSnapshot = snapshot;
          return snapshot;
        }
      } catch (err) {
        this.primaryAvailable = false;
        logger.warn(
          `Container Bridge primary adapter failed, falling back to webhook: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Try webhook adapter
    try {
      const webhookAvailable = await this.webhookAdapter.isAvailable();
      if (webhookAvailable) {
        const snapshot = await this.webhookAdapter.getSnapshot();
        this.lastSnapshot = snapshot;
        return snapshot;
      }
    } catch (err) {
      logger.warn(
        `Container Bridge webhook adapter failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // No adapter available — return unknown snapshot
    const fallback: InfrastructureSnapshot = {
      scalingInProgress: { value: null, confidence: 'unknown' },
      estimatedReadySeconds: { value: null, confidence: 'unknown' },
      atCapacityLimit: { value: null, confidence: 'unknown' },
      capturedAt: Date.now(),
      summary: 'No infrastructure adapter available — using RPM-only activation',
    };
    this.lastSnapshot = fallback;
    return fallback;
  }

  /**
   * Evaluate whether the Activation Gate should hold for infrastructure scaling.
   *
   * Called by ActivationController when RPM threshold is sustained and
   * CHAKRA would normally activate.
   *
   * Returns hold=false (activate now) when:
   * - No adapter has fresh data (unknown state)
   * - Scaling is not in progress
   * - Infrastructure is at capacity limit (K8s can't add more — activate immediately)
   * - hold_for_scaling_max_seconds is 0 (developer disabled holding)
   * - The hold timer has already exceeded hold_for_scaling_max_seconds
   *
   * Returns hold=true (wait for scaling) when:
   * - Scaling is in progress
   * - Not at capacity limit
   * - Estimated ready time is within hold_for_scaling_max_seconds
   */
  async evaluateHold(
    config: ChakraConfig,
    holdingSince: number | null,
  ): Promise<HoldDecision> {
    const maxHoldSeconds = config.infrastructure?.hold_for_scaling_max_seconds ?? 0;

    // If max hold is 0, never hold — developer wants RPM-only activation
    if (maxHoldSeconds === 0) {
      return { hold: false, reason: 'hold_for_scaling_max_seconds is 0 — RPM-only activation' };
    }

    const snapshot = await this.getSnapshot();

    // Unknown state — can't make a hold decision
    if (snapshot.scalingInProgress.value === null) {
      return { hold: false, reason: 'Infrastructure state unknown — activating on RPM' };
    }

    // Not scaling — activate
    if (!snapshot.scalingInProgress.value) {
      return { hold: false, reason: 'No scaling in progress — activating on RPM threshold' };
    }

    // Scaling in progress but at capacity limit — K8s can't scale further
    if (snapshot.atCapacityLimit.value === true) {
      return {
        hold: false,
        reason: 'Infrastructure at capacity limit — cannot scale further. Activating.',
      };
    }

    // Check if we've been holding too long
    if (holdingSince !== null) {
      const holdingSeconds = (Date.now() - holdingSince) / 1_000;
      if (holdingSeconds >= maxHoldSeconds) {
        return {
          hold: false,
          reason: `Hold time exceeded ${maxHoldSeconds}s — infrastructure scaling too slow. Activating.`,
        };
      }
    }

    // Hold — scaling is in progress and we're within the hold window
    const eta = snapshot.estimatedReadySeconds.value;
    return {
      hold: true,
      estimatedReadySeconds: eta,
      reason: eta !== null
        ? `K8s scaling in progress — ~${eta}s estimated`
        : 'Infrastructure scaling in progress — waiting',
    };
  }

  // ─── Observability ────────────────────────────────────────────────────────────

  /** Last snapshot fetched — used by Dashboard for the infrastructure panel. */
  getLastSnapshot(): InfrastructureSnapshot | null {
    return this.lastSnapshot;
  }

  /** Whether the primary adapter was available on last check. */
  isPrimaryAvailable(): boolean {
    return this.primaryAvailable;
  }

  /** Whether any adapter currently has fresh data. */
  hasActiveAdapter(): boolean {
    return this.lastSnapshot !== null &&
      this.lastSnapshot.scalingInProgress.value !== null;
  }

  // ─── Webhook accessor ─────────────────────────────────────────────────────────

  /**
   * Returns the WebhookAdapter so DashboardServer can wire up
   * the POST /api/infrastructure-signal route to it.
   */
  getWebhookAdapter(): WebhookAdapter {
    return this.webhookAdapter;
  }
}
