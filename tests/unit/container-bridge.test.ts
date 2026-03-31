// Container Bridge tests — WebhookAdapter, AdapterManager
//
// KubernetesAdapter, PrometheusAdapter, and ECSAdapter require real network
// connections and are tested via integration tests. Unit tests here cover
// the pure-logic components: WebhookAdapter (TTL, validation, signals)
// and AdapterManager (fallback chain, evaluateHold logic).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhookAdapter } from '../../src/integrations/container-bridge/webhook';
import { AdapterManager } from '../../src/integrations/container-bridge/adapter-manager';
import type { InfrastructureAdapter, InfrastructureSnapshot } from '../../src/integrations/adapter-interface';
import type { ChakraConfig } from '../../src/config/loader';

// ─── WebhookAdapter ───────────────────────────────────────────────────────────

describe('WebhookAdapter', () => {

  describe('receiveSignal()', () => {
    it('accepts a valid minimal payload', () => {
      const adapter = new WebhookAdapter();
      const ok = adapter.receiveSignal({ scaling_in_progress: true, capacity_limit_reached: false });
      expect(ok).toBe(true);
    });

    it('accepts a full payload with all optional fields', () => {
      const adapter = new WebhookAdapter();
      const ok = adapter.receiveSignal({
        scaling_in_progress: true,
        estimated_ready_seconds: 45,
        capacity_limit_reached: false,
        source: 'test-monitor',
        ttl_seconds: 60,
      });
      expect(ok).toBe(true);
    });

    it('rejects payload missing scaling_in_progress', () => {
      const adapter = new WebhookAdapter();
      const ok = adapter.receiveSignal({ capacity_limit_reached: false });
      expect(ok).toBe(false);
    });

    it('rejects payload missing capacity_limit_reached', () => {
      const adapter = new WebhookAdapter();
      const ok = adapter.receiveSignal({ scaling_in_progress: true });
      expect(ok).toBe(false);
    });

    it('rejects non-boolean scaling_in_progress', () => {
      const adapter = new WebhookAdapter();
      const ok = adapter.receiveSignal({ scaling_in_progress: 'yes', capacity_limit_reached: false });
      expect(ok).toBe(false);
    });

    it('rejects null payload', () => {
      const adapter = new WebhookAdapter();
      expect(adapter.receiveSignal(null)).toBe(false);
    });

    it('rejects non-numeric estimated_ready_seconds', () => {
      const adapter = new WebhookAdapter();
      const ok = adapter.receiveSignal({
        scaling_in_progress: true,
        capacity_limit_reached: false,
        estimated_ready_seconds: 'soon',
      });
      expect(ok).toBe(false);
    });

    it('accepts null estimated_ready_seconds', () => {
      const adapter = new WebhookAdapter();
      const ok = adapter.receiveSignal({
        scaling_in_progress: true,
        capacity_limit_reached: false,
        estimated_ready_seconds: null,
      });
      expect(ok).toBe(true);
    });
  });

  describe('isAvailable()', () => {
    it('returns false when no signal received', async () => {
      const adapter = new WebhookAdapter();
      expect(await adapter.isAvailable()).toBe(false);
    });

    it('returns true immediately after receiving a valid signal', async () => {
      const adapter = new WebhookAdapter();
      adapter.receiveSignal({ scaling_in_progress: false, capacity_limit_reached: false, ttl_seconds: 30 });
      expect(await adapter.isAvailable()).toBe(true);
    });

    it('returns false after signal TTL expires', async () => {
      vi.useFakeTimers();
      const adapter = new WebhookAdapter();
      adapter.receiveSignal({ scaling_in_progress: false, capacity_limit_reached: false, ttl_seconds: 1 });
      vi.advanceTimersByTime(1001);
      expect(await adapter.isAvailable()).toBe(false);
      vi.useRealTimers();
    });
  });

  describe('isScalingInProgress()', () => {
    it('returns unknown when no signal', async () => {
      const adapter = new WebhookAdapter();
      const result = await adapter.isScalingInProgress();
      expect(result.value).toBeNull();
      expect(result.confidence).toBe('unknown');
    });

    it('returns true with high confidence when signal says scaling', async () => {
      const adapter = new WebhookAdapter();
      adapter.receiveSignal({ scaling_in_progress: true, capacity_limit_reached: false });
      const result = await adapter.isScalingInProgress();
      expect(result.value).toBe(true);
      expect(result.confidence).toBe('high');
    });

    it('returns false with high confidence when signal says not scaling', async () => {
      const adapter = new WebhookAdapter();
      adapter.receiveSignal({ scaling_in_progress: false, capacity_limit_reached: false });
      const result = await adapter.isScalingInProgress();
      expect(result.value).toBe(false);
      expect(result.confidence).toBe('high');
    });
  });

  describe('estimatedReadySeconds()', () => {
    it('returns unknown when not scaling', async () => {
      const adapter = new WebhookAdapter();
      adapter.receiveSignal({ scaling_in_progress: false, capacity_limit_reached: false });
      const result = await adapter.estimatedReadySeconds();
      expect(result.value).toBeNull();
    });

    it('returns the provided estimate with medium confidence', async () => {
      const adapter = new WebhookAdapter();
      adapter.receiveSignal({
        scaling_in_progress: true,
        capacity_limit_reached: false,
        estimated_ready_seconds: 60,
      });
      const result = await adapter.estimatedReadySeconds();
      expect(result.value).toBe(60);
      expect(result.confidence).toBe('medium');
    });

    it('returns unknown confidence when no estimate provided', async () => {
      const adapter = new WebhookAdapter();
      adapter.receiveSignal({ scaling_in_progress: true, capacity_limit_reached: false });
      const result = await adapter.estimatedReadySeconds();
      expect(result.value).toBeNull();
      expect(result.confidence).toBe('unknown');
    });
  });

  describe('isAtCapacityLimit()', () => {
    it('returns false when signal says not at limit', async () => {
      const adapter = new WebhookAdapter();
      adapter.receiveSignal({ scaling_in_progress: true, capacity_limit_reached: false });
      const result = await adapter.isAtCapacityLimit();
      expect(result.value).toBe(false);
      expect(result.confidence).toBe('high');
    });

    it('returns true when signal says at limit', async () => {
      const adapter = new WebhookAdapter();
      adapter.receiveSignal({ scaling_in_progress: false, capacity_limit_reached: true });
      const result = await adapter.isAtCapacityLimit();
      expect(result.value).toBe(true);
      expect(result.confidence).toBe('high');
    });
  });

  describe('getSnapshot()', () => {
    it('returns all-unknown snapshot when no signal', async () => {
      const adapter = new WebhookAdapter();
      const snap = await adapter.getSnapshot();
      expect(snap.scalingInProgress.value).toBeNull();
      expect(snap.estimatedReadySeconds.value).toBeNull();
      expect(snap.atCapacityLimit.value).toBeNull();
      expect(snap.summary).toMatch(/No fresh/);
    });

    it('returns populated snapshot from valid signal', async () => {
      const adapter = new WebhookAdapter();
      adapter.receiveSignal({
        scaling_in_progress: true,
        capacity_limit_reached: false,
        estimated_ready_seconds: 45,
        source: 'monitor',
      });
      const snap = await adapter.getSnapshot();
      expect(snap.scalingInProgress.value).toBe(true);
      expect(snap.estimatedReadySeconds.value).toBe(45);
      expect(snap.atCapacityLimit.value).toBe(false);
      expect(snap.summary).toMatch(/monitor/);
    });

    it('includes capturedAt timestamp', async () => {
      const adapter = new WebhookAdapter();
      const before = Date.now();
      const snap = await adapter.getSnapshot();
      expect(snap.capturedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('getLastSignalRaw()', () => {
    it('returns null when no signal received', () => {
      const adapter = new WebhookAdapter();
      expect(adapter.getLastSignalRaw()).toBeNull();
    });

    it('returns raw signal even after TTL expires', () => {
      vi.useFakeTimers();
      const adapter = new WebhookAdapter();
      adapter.receiveSignal({ scaling_in_progress: true, capacity_limit_reached: false, ttl_seconds: 1 });
      vi.advanceTimersByTime(5000);
      const raw = adapter.getLastSignalRaw();
      expect(raw).not.toBeNull();
      expect(raw!.signal.scaling_in_progress).toBe(true);
      vi.useRealTimers();
    });
  });
});

// ─── AdapterManager ────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<InfrastructureSnapshot> = {}): InfrastructureSnapshot {
  return {
    scalingInProgress: { value: false, confidence: 'high' },
    estimatedReadySeconds: { value: null, confidence: 'unknown' },
    atCapacityLimit: { value: false, confidence: 'high' },
    capturedAt: Date.now(),
    summary: 'test',
    ...overrides,
  };
}

function makeMockAdapter(available: boolean, snapshot: InfrastructureSnapshot): InfrastructureAdapter {
  return {
    isAvailable: vi.fn().mockResolvedValue(available),
    isScalingInProgress: vi.fn().mockResolvedValue(snapshot.scalingInProgress),
    estimatedReadySeconds: vi.fn().mockResolvedValue(snapshot.estimatedReadySeconds),
    isAtCapacityLimit: vi.fn().mockResolvedValue(snapshot.atCapacityLimit),
    getSnapshot: vi.fn().mockResolvedValue(snapshot),
  };
}

function makeConfig(infraOverrides: NonNullable<ChakraConfig['infrastructure']> = {}): ChakraConfig {
  return {
    mode: 'auto',
    infrastructure: {
      hold_for_scaling_max_seconds: 120,
      ...infraOverrides,
    },
  };
}

describe('AdapterManager', () => {

  describe('getSnapshot()', () => {
    it('uses primary adapter when available', async () => {
      const primarySnap = makeSnapshot({ summary: 'primary' });
      const primary = makeMockAdapter(true, primarySnap);
      const webhook = new WebhookAdapter();
      const manager = new AdapterManager(webhook, primary);

      const snap = await manager.getSnapshot();
      expect(snap.summary).toBe('primary');
    });

    it('falls back to webhook when primary is unavailable', async () => {
      const primary = makeMockAdapter(false, makeSnapshot());
      const webhook = new WebhookAdapter();
      webhook.receiveSignal({ scaling_in_progress: true, capacity_limit_reached: false, source: 'webhook' });
      const manager = new AdapterManager(webhook, primary);

      const snap = await manager.getSnapshot();
      expect(snap.summary).toMatch(/webhook/);
    });

    it('falls back to unknown snapshot when no adapter has data', async () => {
      const primary = makeMockAdapter(false, makeSnapshot());
      const webhook = new WebhookAdapter();   // no signal
      const manager = new AdapterManager(webhook, primary);

      const snap = await manager.getSnapshot();
      expect(snap.scalingInProgress.value).toBeNull();
      expect(snap.summary).toMatch(/No infrastructure adapter/);
    });

    it('falls back gracefully when primary adapter throws', async () => {
      const primary: InfrastructureAdapter = {
        isAvailable: vi.fn().mockRejectedValue(new Error('network error')),
        isScalingInProgress: vi.fn(),
        estimatedReadySeconds: vi.fn(),
        isAtCapacityLimit: vi.fn(),
        getSnapshot: vi.fn(),
      };
      const webhook = new WebhookAdapter();
      webhook.receiveSignal({ scaling_in_progress: false, capacity_limit_reached: false });
      const manager = new AdapterManager(webhook, primary);

      const snap = await manager.getSnapshot();
      expect(snap.scalingInProgress.value).toBe(false);
    });

    it('uses webhook adapter when no primary configured', async () => {
      const webhook = new WebhookAdapter();
      webhook.receiveSignal({ scaling_in_progress: false, capacity_limit_reached: false });
      const manager = new AdapterManager(webhook);

      const snap = await manager.getSnapshot();
      expect(snap.scalingInProgress.value).toBe(false);
    });
  });

  describe('evaluateHold()', () => {
    it('returns hold=false when hold_for_scaling_max_seconds is 0', async () => {
      const webhook = new WebhookAdapter();
      webhook.receiveSignal({ scaling_in_progress: true, capacity_limit_reached: false });
      const manager = new AdapterManager(webhook);
      const config = makeConfig({ hold_for_scaling_max_seconds: 0 });

      const decision = await manager.evaluateHold(config, null);
      expect(decision.hold).toBe(false);
      expect(decision.reason).toMatch(/0/);
    });

    it('returns hold=false when no infrastructure state available', async () => {
      const webhook = new WebhookAdapter();   // no signal
      const manager = new AdapterManager(webhook);
      const config = makeConfig();

      const decision = await manager.evaluateHold(config, null);
      expect(decision.hold).toBe(false);
      expect(decision.reason).toMatch(/unknown/i);
    });

    it('returns hold=false when scaling is not in progress', async () => {
      const webhook = new WebhookAdapter();
      webhook.receiveSignal({ scaling_in_progress: false, capacity_limit_reached: false });
      const manager = new AdapterManager(webhook);
      const config = makeConfig();

      const decision = await manager.evaluateHold(config, null);
      expect(decision.hold).toBe(false);
      expect(decision.reason).toMatch(/No scaling/);
    });

    it('returns hold=false when at capacity limit (cannot scale further)', async () => {
      const webhook = new WebhookAdapter();
      webhook.receiveSignal({ scaling_in_progress: true, capacity_limit_reached: true });
      const manager = new AdapterManager(webhook);
      const config = makeConfig();

      const decision = await manager.evaluateHold(config, null);
      expect(decision.hold).toBe(false);
      expect(decision.reason).toMatch(/capacity limit/i);
    });

    it('returns hold=true when scaling in progress and within max hold time', async () => {
      const webhook = new WebhookAdapter();
      webhook.receiveSignal({
        scaling_in_progress: true,
        capacity_limit_reached: false,
        estimated_ready_seconds: 45,
      });
      const manager = new AdapterManager(webhook);
      const config = makeConfig({ hold_for_scaling_max_seconds: 120 });

      const decision = await manager.evaluateHold(config, null);
      expect(decision.hold).toBe(true);
      if (decision.hold) {
        expect(decision.estimatedReadySeconds).toBe(45);
        expect(decision.reason).toMatch(/45/);
      }
    });

    it('returns hold=true when scaling in progress and no estimate available', async () => {
      const webhook = new WebhookAdapter();
      webhook.receiveSignal({ scaling_in_progress: true, capacity_limit_reached: false });
      const manager = new AdapterManager(webhook);
      const config = makeConfig({ hold_for_scaling_max_seconds: 120 });

      const decision = await manager.evaluateHold(config, null);
      expect(decision.hold).toBe(true);
      if (decision.hold) {
        expect(decision.estimatedReadySeconds).toBeNull();
      }
    });

    it('returns hold=false when hold time exceeded', async () => {
      const webhook = new WebhookAdapter();
      webhook.receiveSignal({ scaling_in_progress: true, capacity_limit_reached: false });
      const manager = new AdapterManager(webhook);
      const config = makeConfig({ hold_for_scaling_max_seconds: 60 });

      // holdingSince is 120 seconds ago
      const holdingSince = Date.now() - 120_000;
      const decision = await manager.evaluateHold(config, holdingSince);
      expect(decision.hold).toBe(false);
      expect(decision.reason).toMatch(/exceeded/i);
    });

    it('does not exceed hold if holdingSince is recent', async () => {
      const webhook = new WebhookAdapter();
      webhook.receiveSignal({ scaling_in_progress: true, capacity_limit_reached: false });
      const manager = new AdapterManager(webhook);
      const config = makeConfig({ hold_for_scaling_max_seconds: 120 });

      // holdingSince is only 10 seconds ago
      const holdingSince = Date.now() - 10_000;
      const decision = await manager.evaluateHold(config, holdingSince);
      expect(decision.hold).toBe(true);
    });

    it('returns hold=false when hold_for_scaling_max_seconds not configured', async () => {
      const webhook = new WebhookAdapter();
      webhook.receiveSignal({ scaling_in_progress: true, capacity_limit_reached: false });
      const manager = new AdapterManager(webhook);
      const config: ChakraConfig = { mode: 'auto' };   // no infrastructure block

      const decision = await manager.evaluateHold(config, null);
      expect(decision.hold).toBe(false);
    });
  });

  describe('observability', () => {
    it('getLastSnapshot() returns null before first fetch', () => {
      const manager = new AdapterManager(new WebhookAdapter());
      expect(manager.getLastSnapshot()).toBeNull();
    });

    it('getLastSnapshot() returns snapshot after getSnapshot() call', async () => {
      const webhook = new WebhookAdapter();
      webhook.receiveSignal({ scaling_in_progress: false, capacity_limit_reached: false });
      const manager = new AdapterManager(webhook);
      await manager.getSnapshot();
      expect(manager.getLastSnapshot()).not.toBeNull();
    });

    it('isPrimaryAvailable() returns false when no primary adapter', () => {
      const manager = new AdapterManager(new WebhookAdapter());
      expect(manager.isPrimaryAvailable()).toBe(false);
    });

    it('isPrimaryAvailable() returns true after successful primary fetch', async () => {
      const primary = makeMockAdapter(true, makeSnapshot({ summary: 'primary' }));
      const manager = new AdapterManager(new WebhookAdapter(), primary);
      await manager.getSnapshot();
      expect(manager.isPrimaryAvailable()).toBe(true);
    });

    it('getWebhookAdapter() returns the webhook adapter', () => {
      const webhook = new WebhookAdapter();
      const manager = new AdapterManager(webhook);
      expect(manager.getWebhookAdapter()).toBe(webhook);
    });
  });
});
