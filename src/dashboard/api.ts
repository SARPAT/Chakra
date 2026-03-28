// Dashboard API — data access layer for the CHAKRA dashboard
//
// Sits between the HTTP server and the CHAKRA internals.
// Owns: RPM history ring buffer, incident reports, policy rule list.
// Never throws — all methods catch and return safe fallback values.

import type {
  RPMState, BlockState, RPMHistoryEntry, IncidentReport,
  DispatcherMetrics,
} from '../types';
import type { ChakraStatus } from '../index';
import type { ChakraConfig } from '../config/loader';
import type { PolicyRule } from '../core/policy-engine';
import type { ActivationLogEntry } from '../core/activation';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DashboardAPIConfig {
  getStatus: () => ChakraStatus;
  getRPMState: () => RPMState;
  getBlockStates: () => BlockState[];
  getActivationLog: () => readonly ActivationLogEntry[];
  getMetrics: () => DispatcherMetrics;
  getConfig: () => ChakraConfig;
  initialPolicies: PolicyRule[];
  onPoliciesUpdated: (rules: PolicyRule[]) => void;
  activate: (level?: number, initiatedBy?: string) => void;
  initiateSleep: (sequence?: 'gradual' | 'immediate', initiatedBy?: string) => void;
  updateConfig: (patch: Partial<ChakraConfig>) => void;
  /** Max RPM history entries to retain (default: 360 = 30 minutes at 5-second intervals) */
  maxHistoryEntries?: number;
  /** Max incident reports to retain in memory (default: 100) */
  maxIncidentReports?: number;
}

export interface RPMResponse {
  current: Readonly<RPMState>;
  history: RPMHistoryEntry[];
}

export interface BlocksResponse {
  blocks: BlockState[];
  perBlockRpm: Record<string, number>;
}

export interface PoliciesResponse {
  active: PolicyRule[];
  suggestions: PolicySuggestion[];
}

/** A policy suggestion from Shadow Mode (stub — Shadow Mode not yet built) */
export interface PolicySuggestion {
  id: string;
  name: string;
  confidence: 'low' | 'medium' | 'high';
  rule: PolicyRule;
  reason: string;
}

export interface LearningResponse {
  daysSinceInstall: number;
  layers: {
    appStructure: { complete: boolean; completedDay?: number; endpointCount: number };
    trafficPatterns: { complete: boolean; completedDay?: number; daysOfData: number };
    userBehaviour: { complete: boolean; progressPercent: number; conversionsObserved: number };
    failureSignatures: { complete: boolean; awaitingStressEvent: boolean };
  };
  suggestions: { ringMap: boolean; rpmThresholds: boolean };
}

export interface HistoryResponse {
  activations: readonly ActivationLogEntry[];
  incidents: IncidentReport[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_HISTORY_ENTRIES = 360;   // 30 minutes × 12 ticks/min
const DEFAULT_MAX_INCIDENT_REPORTS = 100;
const PRESET_RULE_PREFIX = '__preset__';

// ─── Emergency presets ────────────────────────────────────────────────────────

const EMERGENCY_PRESETS: Record<string, PolicyRule[]> = {
  'suspend-non-essential': [
    {
      name: `${PRESET_RULE_PREFIX}suspend-non-essential`,
      if: { block_not: ['payment-block', 'checkout-block', 'auth-block'] },
      then: { action: 'suspend' },
      priority: 9_900,
    },
  ],
  'checkout-only': [
    {
      name: `${PRESET_RULE_PREFIX}checkout-only`,
      if: { block_not: ['payment-block', 'checkout-block'] },
      then: { action: 'suspend' },
      priority: 9_900,
    },
  ],
  'cache-everything': [
    {
      name: `${PRESET_RULE_PREFIX}cache-everything`,
      if: {},
      then: { action: 'serve_limited', hint: 'use-cache' },
      priority: 9_800,
    },
  ],
};

// ─── DashboardAPI ──────────────────────────────────────────────────────────────

export class DashboardAPI {
  private readonly config: DashboardAPIConfig;
  private readonly maxHistoryEntries: number;
  private readonly maxIncidentReports: number;

  private readonly rpmHistory: RPMHistoryEntry[] = [];
  private readonly incidentReports: IncidentReport[] = [];
  private policies: PolicyRule[];

  // Metrics snapshot taken at activation — used to compute request deltas in reports
  private activationMetricsSnapshot: DispatcherMetrics | null = null;

  constructor(config: DashboardAPIConfig) {
    this.config = config;
    this.maxHistoryEntries = config.maxHistoryEntries ?? DEFAULT_MAX_HISTORY_ENTRIES;
    this.maxIncidentReports = config.maxIncidentReports ?? DEFAULT_MAX_INCIDENT_REPORTS;
    this.policies = [...config.initialPolicies];
  }

  // ─── Status ──────────────────────────────────────────────────────────────────

  status(): ChakraStatus {
    return this.config.getStatus();
  }

  // ─── RPM ─────────────────────────────────────────────────────────────────────

  rpm(): RPMResponse {
    return {
      current: this.config.getRPMState(),
      history: [...this.rpmHistory],
    };
  }

  /**
   * Record a new RPM sample into the history ring buffer.
   * Called by DashboardServer on each RPM tick.
   */
  recordRPMSample(state: RPMState): void {
    this.rpmHistory.push({ timestamp: state.updatedAt, rpm: state.global });
    if (this.rpmHistory.length > this.maxHistoryEntries) {
      this.rpmHistory.splice(0, this.rpmHistory.length - this.maxHistoryEntries);
    }
  }

  // ─── Blocks ──────────────────────────────────────────────────────────────────

  blocks(): BlocksResponse {
    const rpmState = this.config.getRPMState();
    return {
      blocks: this.config.getBlockStates(),
      perBlockRpm: { ...rpmState.perBlock },
    };
  }

  // ─── Policies ────────────────────────────────────────────────────────────────

  getPolicies(): PoliciesResponse {
    return {
      active: this.policies.filter(r => !r.name.startsWith(PRESET_RULE_PREFIX)),
      suggestions: [],   // Shadow Mode not yet built
    };
  }

  createPolicy(rule: PolicyRule): void {
    if (this.policies.some(r => r.name === rule.name)) {
      throw new Error(`Policy '${rule.name}' already exists`);
    }
    this.policies = [...this.policies, rule];
    this.config.onPoliciesUpdated(this.policies);
  }

  updatePolicy(name: string, updated: PolicyRule): void {
    const idx = this.policies.findIndex(r => r.name === name);
    if (idx === -1) throw new Error(`Policy '${name}' not found`);
    this.policies = this.policies.map((r, i) => (i === idx ? updated : r));
    this.config.onPoliciesUpdated(this.policies);
  }

  deletePolicy(name: string): void {
    const before = this.policies.length;
    this.policies = this.policies.filter(r => r.name !== name);
    if (this.policies.length === before) throw new Error(`Policy '${name}' not found`);
    this.config.onPoliciesUpdated(this.policies);
  }

  // ─── Emergency presets ───────────────────────────────────────────────────────

  activatePreset(name: string): void {
    if (name === 'restore-all') {
      this.policies = this.policies.filter(r => !r.name.startsWith(PRESET_RULE_PREFIX));
      this.config.onPoliciesUpdated(this.policies);
      return;
    }

    const preset = EMERGENCY_PRESETS[name];
    if (!preset) throw new Error(`Unknown preset '${name}'`);

    // Remove any existing preset rules, then add new ones
    const withoutPreset = this.policies.filter(r => !r.name.startsWith(PRESET_RULE_PREFIX));
    this.policies = [...withoutPreset, ...preset];
    this.config.onPoliciesUpdated(this.policies);
  }

  // ─── Learning (Shadow Mode stub) ─────────────────────────────────────────────

  learning(): LearningResponse {
    // Shadow Mode not yet built — return placeholder showing no learning data
    return {
      daysSinceInstall: 0,
      layers: {
        appStructure: { complete: false, endpointCount: 0 },
        trafficPatterns: { complete: false, daysOfData: 0 },
        userBehaviour: { complete: false, progressPercent: 0, conversionsObserved: 0 },
        failureSignatures: { complete: false, awaitingStressEvent: true },
      },
      suggestions: { ringMap: false, rpmThresholds: false },
    };
  }

  // ─── Activation controls ──────────────────────────────────────────────────────

  activate(level?: number, initiatedBy?: string): void {
    // Snapshot metrics at activation start for later incident report generation
    try { this.activationMetricsSnapshot = this.config.getMetrics(); } catch { /* ignore */ }
    this.config.activate(level, initiatedBy);
  }

  deactivate(sequence?: 'gradual' | 'immediate', initiatedBy?: string): void {
    this.config.initiateSleep(sequence, initiatedBy);
  }

  // ─── Settings ────────────────────────────────────────────────────────────────

  updateSettings(patch: Partial<ChakraConfig>): void {
    this.config.updateConfig(patch);
  }

  getConfig(): ChakraConfig {
    return this.config.getConfig();
  }

  // ─── History ─────────────────────────────────────────────────────────────────

  history(): HistoryResponse {
    return {
      activations: this.config.getActivationLog(),
      incidents: [...this.incidentReports],
    };
  }

  report(id: string): IncidentReport | null {
    return this.incidentReports.find(r => r.id === id) ?? null;
  }

  // ─── Incident report generation ───────────────────────────────────────────────

  /**
   * Generate and store an incident report.
   * Call this immediately after a CHAKRA deactivation completes.
   */
  generateIncidentReport(): void {
    try {
      const report = this.buildIncidentReport();
      if (report === null) return;

      this.incidentReports.push(report);
      if (this.incidentReports.length > this.maxIncidentReports) {
        this.incidentReports.splice(0, this.incidentReports.length - this.maxIncidentReports);
      }
      this.activationMetricsSnapshot = null;
    } catch {
      /* never propagate — background operation */
    }
  }

  private buildIncidentReport(): IncidentReport | null {
    const log = this.config.getActivationLog();

    // Find the last activation entry
    let activationIdx = -1;
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].kind === 'activated') { activationIdx = i; break; }
    }
    if (activationIdx === -1) return null;

    const activationEntry = log[activationIdx];

    // Find the fully_restored entry that follows this activation
    let endEntry: ActivationLogEntry | null = null;
    for (let i = activationIdx + 1; i < log.length; i++) {
      if (log[i].kind === 'fully_restored') { endEntry = log[i]; break; }
    }
    if (endEntry === null) return null;

    // Build level timeline from log entries between activation and fully_restored
    const timeline: IncidentReport['levelTimeline'] = [];
    for (let i = activationIdx; i < log.length; i++) {
      const e = log[i];
      timeline.push({ timestamp: e.timestamp, level: e.level, note: e.note });
      if (e.kind === 'fully_restored') break;
    }

    // Compute peak RPM from history window
    const startTime = activationEntry.timestamp;
    const endTime = endEntry.timestamp;
    const windowEntries = this.rpmHistory.filter(
      h => h.timestamp >= startTime && h.timestamp <= endTime,
    );
    const peakRpm = windowEntries.reduce(
      (max, h) => Math.max(max, h.rpm),
      activationEntry.rpmAtEvent,
    );

    // Compute request deltas
    const currentMetrics = this.config.getMetrics();
    const snap = this.activationMetricsSnapshot;
    const requests = {
      total: snap ? currentMetrics.totalRequests - snap.totalRequests : currentMetrics.totalRequests,
      serveFully: snap
        ? currentMetrics.outcomes.serveFully - snap.outcomes.serveFully
        : currentMetrics.outcomes.serveFully,
      serveLimited: snap
        ? currentMetrics.outcomes.serveLimited - snap.outcomes.serveLimited
        : currentMetrics.outcomes.serveLimited,
      suspended: snap
        ? currentMetrics.outcomes.suspended - snap.outcomes.suspended
        : currentMetrics.outcomes.suspended,
    };

    const weightRescues = snap
      ? currentMetrics.weightOverrides - snap.weightOverrides
      : currentMetrics.weightOverrides;
    const policyRescues = snap
      ? currentMetrics.policyOverrides - snap.policyOverrides
      : currentMetrics.policyOverrides;

    return {
      id: `incident-${startTime}`,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      mode: activationEntry.mode,
      ...(activationEntry.initiatedBy !== undefined && { initiatedBy: activationEntry.initiatedBy }),
      ...(activationEntry.triggerReason !== undefined && { triggerReason: activationEntry.triggerReason }),
      rpmAtActivation: activationEntry.rpmAtEvent,
      peakRpm,
      levelTimeline: timeline,
      requests,
      weightRescues: Math.max(0, weightRescues),
      policyRescues: Math.max(0, policyRescues),
    };
  }
}
