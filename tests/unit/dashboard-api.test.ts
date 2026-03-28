// DashboardAPI unit tests
//
// Tests the data access layer for the CHAKRA dashboard.
// DashboardServer (HTTP/WebSocket) is tested separately in dashboard-server.test.ts

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DashboardAPI } from '../../src/dashboard/api';
import type { DashboardAPIConfig } from '../../src/dashboard/api';
import type { RPMState, BlockState, DispatcherMetrics } from '../../src/types';
import type { ChakraStatus } from '../../src/index';
import type { ChakraConfig } from '../../src/config/loader';
import type { PolicyRule } from '../../src/core/policy-engine';
import type { ActivationLogEntry } from '../../src/core/activation';

// ─── Test helpers ──────────────────────────────────────────────────────────────

function makeRPMState(rpm = 0): RPMState {
  return { global: rpm, perBlock: {}, updatedAt: Date.now(), phase: 1 };
}

function makeStatus(active = false, rpm = 0): ChakraStatus {
  return { active, mode: 'manual', currentLevel: active ? 1 : 0, rpm, rpmPhase: 1, disabled: false };
}

function makeMetrics(overrides: Partial<DispatcherMetrics> = {}): DispatcherMetrics {
  return {
    totalRequests: 0,
    outcomes: { serveFully: 0, serveLimited: 0, suspended: 0 },
    perBlock: {},
    weightOverrides: 0,
    policyOverrides: 0,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<DashboardAPIConfig> = {}): DashboardAPIConfig {
  return {
    getStatus: () => makeStatus(),
    getRPMState: () => makeRPMState(),
    getBlockStates: () => [],
    getActivationLog: () => [],
    getMetrics: () => makeMetrics(),
    getConfig: () => ({ mode: 'manual' } as ChakraConfig),
    initialPolicies: [],
    onPoliciesUpdated: vi.fn(),
    activate: vi.fn(),
    initiateSleep: vi.fn(),
    updateConfig: vi.fn(),
    ...overrides,
  };
}

function makeAPI(overrides: Partial<DashboardAPIConfig> = {}): DashboardAPI {
  return new DashboardAPI(makeConfig(overrides));
}

// ─── status() ────────────────────────────────────────────────────────────────

describe('DashboardAPI.status()', () => {
  it('returns the current status from getStatus callback', () => {
    const expected = makeStatus(true, 55);
    const api = makeAPI({ getStatus: () => expected });
    expect(api.status()).toEqual(expected);
  });

  it('reflects changes when getStatus callback changes', () => {
    let active = false;
    const api = makeAPI({ getStatus: () => makeStatus(active) });
    expect(api.status().active).toBe(false);
    active = true;
    expect(api.status().active).toBe(true);
  });
});

// ─── rpm() and recordRPMSample() ─────────────────────────────────────────────

describe('DashboardAPI.rpm()', () => {
  it('returns current RPM state from callback', () => {
    const rpmState = makeRPMState(72);
    const api = makeAPI({ getRPMState: () => rpmState });
    expect(api.rpm().current).toEqual(rpmState);
  });

  it('returns empty history initially', () => {
    const api = makeAPI();
    expect(api.rpm().history).toEqual([]);
  });

  it('returns a copy of history — mutations do not affect internal state', () => {
    const api = makeAPI();
    api.recordRPMSample(makeRPMState(50));
    const h = api.rpm().history;
    h.splice(0);
    expect(api.rpm().history).toHaveLength(1);
  });
});

describe('DashboardAPI.recordRPMSample()', () => {
  it('appends an entry with correct timestamp and rpm', () => {
    const api = makeAPI();
    const state = { global: 63, perBlock: {}, updatedAt: 1000, phase: 1 as const };
    api.recordRPMSample(state);
    const hist = api.rpm().history;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toEqual({ timestamp: 1000, rpm: 63 });
  });

  it('caps history at maxHistoryEntries (default 360)', () => {
    const api = makeAPI({ maxHistoryEntries: 5 });
    for (let i = 0; i < 8; i++) {
      api.recordRPMSample({ global: i, perBlock: {}, updatedAt: i * 1000, phase: 1 });
    }
    expect(api.rpm().history).toHaveLength(5);
    // Should retain the most recent entries
    expect(api.rpm().history[0].rpm).toBe(3);
    expect(api.rpm().history[4].rpm).toBe(7);
  });
});

// ─── blocks() ────────────────────────────────────────────────────────────────

describe('DashboardAPI.blocks()', () => {
  it('returns block states and per-block RPM', () => {
    const blockState: BlockState = {
      block: 'payment-block',
      currentLevel: 0,
      isActive: true,
      isSuspended: false,
    };
    const rpmState: RPMState = {
      global: 45,
      perBlock: { 'payment-block': 31 },
      updatedAt: Date.now(),
      phase: 1,
    };
    const api = makeAPI({
      getBlockStates: () => [blockState],
      getRPMState: () => rpmState,
    });
    const result = api.blocks();
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].block).toBe('payment-block');
    expect(result.perBlockRpm['payment-block']).toBe(31);
  });

  it('returns empty blocks when no blocks registered', () => {
    const api = makeAPI();
    expect(api.blocks().blocks).toEqual([]);
    expect(api.blocks().perBlockRpm).toEqual({});
  });
});

// ─── getPolicies() ────────────────────────────────────────────────────────────

describe('DashboardAPI.getPolicies()', () => {
  it('returns active policies (excluding preset rules)', () => {
    const rule: PolicyRule = {
      name: 'protect-premium',
      if: { user_tier: 'premium' },
      then: { action: 'serve_fully' },
      priority: 100,
    };
    const api = makeAPI({ initialPolicies: [rule] });
    const result = api.getPolicies();
    expect(result.active).toHaveLength(1);
    expect(result.active[0].name).toBe('protect-premium');
  });

  it('excludes __preset__ rules from active list', () => {
    const api = makeAPI();
    api.activatePreset('checkout-only');
    expect(api.getPolicies().active).toHaveLength(0);
  });

  it('returns empty suggestions (Shadow Mode not built)', () => {
    const api = makeAPI();
    expect(api.getPolicies().suggestions).toEqual([]);
  });
});

// ─── createPolicy() ──────────────────────────────────────────────────────────

describe('DashboardAPI.createPolicy()', () => {
  it('adds a new policy and notifies callback', () => {
    const onUpdate = vi.fn();
    const api = makeAPI({ onPoliciesUpdated: onUpdate });
    const rule: PolicyRule = {
      name: 'new-rule',
      if: {},
      then: { action: 'serve_fully' },
      priority: 50,
    };
    api.createPolicy(rule);
    expect(api.getPolicies().active).toHaveLength(1);
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('throws if policy name already exists', () => {
    const rule: PolicyRule = { name: 'dup', if: {}, then: { action: 'serve_fully' }, priority: 1 };
    const api = makeAPI({ initialPolicies: [rule] });
    expect(() => api.createPolicy(rule)).toThrow("Policy 'dup' already exists");
  });
});

// ─── updatePolicy() ──────────────────────────────────────────────────────────

describe('DashboardAPI.updatePolicy()', () => {
  it('replaces the matching rule and notifies callback', () => {
    const onUpdate = vi.fn();
    const original: PolicyRule = { name: 'r1', if: {}, then: { action: 'suspend' }, priority: 10 };
    const api = makeAPI({ initialPolicies: [original], onPoliciesUpdated: onUpdate });
    const updated: PolicyRule = { name: 'r1', if: {}, then: { action: 'serve_fully' }, priority: 10 };
    api.updatePolicy('r1', updated);
    expect(api.getPolicies().active[0].then.action).toBe('serve_fully');
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('throws if policy not found', () => {
    const api = makeAPI();
    expect(() => api.updatePolicy('ghost', { name: 'ghost', if: {}, then: { action: 'suspend' }, priority: 1 }))
      .toThrow("Policy 'ghost' not found");
  });
});

// ─── deletePolicy() ──────────────────────────────────────────────────────────

describe('DashboardAPI.deletePolicy()', () => {
  it('removes the policy and notifies callback', () => {
    const onUpdate = vi.fn();
    const rule: PolicyRule = { name: 'to-delete', if: {}, then: { action: 'suspend' }, priority: 1 };
    const api = makeAPI({ initialPolicies: [rule], onPoliciesUpdated: onUpdate });
    api.deletePolicy('to-delete');
    expect(api.getPolicies().active).toHaveLength(0);
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('throws if policy not found', () => {
    const api = makeAPI();
    expect(() => api.deletePolicy('ghost')).toThrow("Policy 'ghost' not found");
  });
});

// ─── activatePreset() ────────────────────────────────────────────────────────

describe('DashboardAPI.activatePreset()', () => {
  it('adds __preset__ rules for checkout-only', () => {
    const onUpdate = vi.fn();
    const api = makeAPI({ onPoliciesUpdated: onUpdate });
    api.activatePreset('checkout-only');
    expect(onUpdate).toHaveBeenCalledOnce();
    // Preset rules should exist internally (not in active policies list)
    expect(api.getPolicies().active).toHaveLength(0);
  });

  it('adds __preset__ rules for suspend-non-essential', () => {
    const api = makeAPI();
    api.activatePreset('suspend-non-essential');
    // Active policies excludes preset rules
    expect(api.getPolicies().active).toHaveLength(0);
  });

  it('adds __preset__ rules for cache-everything', () => {
    const api = makeAPI();
    api.activatePreset('cache-everything');
    expect(api.getPolicies().active).toHaveLength(0);
  });

  it('restore-all removes all preset rules', () => {
    const userRule: PolicyRule = { name: 'user-rule', if: {}, then: { action: 'serve_fully' }, priority: 1 };
    const api = makeAPI({ initialPolicies: [userRule] });
    api.activatePreset('checkout-only');
    api.activatePreset('restore-all');
    const active = api.getPolicies().active;
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('user-rule');
  });

  it('throws on unknown preset name', () => {
    const api = makeAPI();
    expect(() => api.activatePreset('unknown-preset')).toThrow("Unknown preset 'unknown-preset'");
  });

  it('user policies are preserved when activating a preset', () => {
    const userRule: PolicyRule = { name: 'keep-me', if: {}, then: { action: 'serve_fully' }, priority: 1 };
    const api = makeAPI({ initialPolicies: [userRule] });
    api.activatePreset('checkout-only');
    expect(api.getPolicies().active[0].name).toBe('keep-me');
  });
});

// ─── learning() ──────────────────────────────────────────────────────────────

describe('DashboardAPI.learning()', () => {
  it('returns placeholder data while Shadow Mode is not built', () => {
    const api = makeAPI();
    const result = api.learning();
    expect(result.daysSinceInstall).toBe(0);
    expect(result.layers.appStructure.complete).toBe(false);
    expect(result.layers.failureSignatures.awaitingStressEvent).toBe(true);
    expect(result.suggestions.ringMap).toBe(false);
  });
});

// ─── activate() and deactivate() ─────────────────────────────────────────────

describe('DashboardAPI.activate()', () => {
  it('calls activate callback with level and initiatedBy', () => {
    const activate = vi.fn();
    const getMetrics = vi.fn().mockReturnValue(makeMetrics());
    const api = makeAPI({ activate, getMetrics });
    api.activate(2, 'ops@example.com');
    expect(activate).toHaveBeenCalledWith(2, 'ops@example.com');
  });

  it('snapshots metrics at activation time', () => {
    const activate = vi.fn();
    const snap = makeMetrics({ totalRequests: 1000 });
    const getMetrics = vi.fn().mockReturnValue(snap);
    const api = makeAPI({ activate, getMetrics });
    api.activate(1);
    // Metrics snapshot captured — used in later incident report
    expect(getMetrics).toHaveBeenCalled();
  });
});

describe('DashboardAPI.deactivate()', () => {
  it('calls initiateSleep callback with sequence and initiatedBy', () => {
    const initiateSleep = vi.fn();
    const api = makeAPI({ initiateSleep });
    api.deactivate('immediate', 'ops@example.com');
    expect(initiateSleep).toHaveBeenCalledWith('immediate', 'ops@example.com');
  });
});

// ─── updateSettings() and getConfig() ────────────────────────────────────────

describe('DashboardAPI.updateSettings()', () => {
  it('calls updateConfig callback with the patch', () => {
    const updateConfig = vi.fn();
    const api = makeAPI({ updateConfig });
    api.updateSettings({ mode: 'auto' });
    expect(updateConfig).toHaveBeenCalledWith({ mode: 'auto' });
  });
});

describe('DashboardAPI.getConfig()', () => {
  it('returns the current config from getConfig callback', () => {
    const cfg = { mode: 'auto' as const };
    const api = makeAPI({ getConfig: () => cfg as ChakraConfig });
    expect(api.getConfig()).toEqual(cfg);
  });
});

// ─── history() ───────────────────────────────────────────────────────────────

describe('DashboardAPI.history()', () => {
  it('returns empty activations and incidents initially', () => {
    const api = makeAPI();
    const h = api.history();
    expect(h.activations).toHaveLength(0);
    expect(h.incidents).toHaveLength(0);
  });

  it('returns activation log from callback', () => {
    const entry: ActivationLogEntry = {
      timestamp: 1000,
      kind: 'activated',
      mode: 'manual',
      level: 1,
      rpmAtEvent: 72,
    };
    const api = makeAPI({ getActivationLog: () => [entry] });
    expect(api.history().activations).toHaveLength(1);
  });

  it('returns a copy of incidents — mutations do not affect internal state', () => {
    const api = makeAPI();
    const incidents = api.history().incidents;
    incidents.push({} as never);
    expect(api.history().incidents).toHaveLength(0);
  });
});

// ─── report() ────────────────────────────────────────────────────────────────

describe('DashboardAPI.report()', () => {
  it('returns null when no reports exist', () => {
    const api = makeAPI();
    expect(api.report('incident-1000')).toBeNull();
  });

  it('returns an incident report by id after generateIncidentReport()', () => {
    const now = 10_000;
    const log: ActivationLogEntry[] = [
      { timestamp: now, kind: 'activated', mode: 'manual', level: 1, rpmAtEvent: 70 },
      { timestamp: now + 1000, kind: 'fully_restored', mode: 'manual', level: 0, rpmAtEvent: 40 },
    ];
    const api = makeAPI({ getActivationLog: () => log });
    api.generateIncidentReport();
    const report = api.report(`incident-${now}`);
    expect(report).not.toBeNull();
    expect(report!.id).toBe(`incident-${now}`);
    expect(report!.startTime).toBe(now);
    expect(report!.mode).toBe('manual');
  });
});

// ─── generateIncidentReport() ────────────────────────────────────────────────

describe('DashboardAPI.generateIncidentReport()', () => {
  it('does nothing when no activation entry exists', () => {
    const api = makeAPI({ getActivationLog: () => [] });
    api.generateIncidentReport();
    expect(api.history().incidents).toHaveLength(0);
  });

  it('does nothing when activation exists but no fully_restored entry', () => {
    const log: ActivationLogEntry[] = [
      { timestamp: 1000, kind: 'activated', mode: 'manual', level: 1, rpmAtEvent: 70 },
    ];
    const api = makeAPI({ getActivationLog: () => log });
    api.generateIncidentReport();
    expect(api.history().incidents).toHaveLength(0);
  });

  it('computes durationMs correctly', () => {
    const start = 10_000;
    const end = 70_000;
    const log: ActivationLogEntry[] = [
      { timestamp: start, kind: 'activated', mode: 'manual', level: 1, rpmAtEvent: 70 },
      { timestamp: end, kind: 'fully_restored', mode: 'manual', level: 0, rpmAtEvent: 40 },
    ];
    const api = makeAPI({ getActivationLog: () => log });
    api.generateIncidentReport();
    expect(api.history().incidents[0].durationMs).toBe(60_000);
  });

  it('computes request deltas from metrics snapshots', () => {
    const start = 10_000;
    const end = 70_000;
    const log: ActivationLogEntry[] = [
      { timestamp: start, kind: 'activated', mode: 'manual', level: 1, rpmAtEvent: 70 },
      { timestamp: end, kind: 'fully_restored', mode: 'manual', level: 0, rpmAtEvent: 40 },
    ];
    let callCount = 0;
    const getMetrics = vi.fn().mockImplementation(() => {
      callCount++;
      return makeMetrics({
        totalRequests: callCount === 1 ? 1000 : 1500,
        outcomes: {
          serveFully: callCount === 1 ? 800 : 1100,
          serveLimited: callCount === 1 ? 100 : 250,
          suspended: callCount === 1 ? 100 : 150,
        },
      });
    });
    const api = makeAPI({ activate: vi.fn(), getMetrics, getActivationLog: () => log });
    // Simulate activation snapshot
    api.activate(1);
    // Now generate report
    api.generateIncidentReport();
    const report = api.history().incidents[0];
    expect(report.requests.total).toBe(500);     // 1500 - 1000
    expect(report.requests.serveFully).toBe(300); // 1100 - 800
  });

  it('caps incident reports at maxIncidentReports', () => {
    const makeLog = (t: number): ActivationLogEntry[] => [
      { timestamp: t, kind: 'activated', mode: 'manual', level: 1, rpmAtEvent: 70 },
      { timestamp: t + 1000, kind: 'fully_restored', mode: 'manual', level: 0, rpmAtEvent: 40 },
    ];
    const api = new DashboardAPI(makeConfig({
      maxIncidentReports: 3,
      getActivationLog: (() => {
        let idx = 0;
        const logs = [makeLog(1000), makeLog(2000), makeLog(3000), makeLog(4000)];
        return () => logs[Math.min(idx++, logs.length - 1)];
      })(),
    }));
    for (let i = 0; i < 4; i++) api.generateIncidentReport();
    expect(api.history().incidents).toHaveLength(3);
  });
});
