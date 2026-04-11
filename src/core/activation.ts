// Activation Modes — Manual/Auto mode control (CP2.5)
//
// Owns the activate/deactivate lifecycle:
//   - Manual Mode: human-initiated via activate() / initiateSleep()
//   - Auto Mode:   RPM Engine signal-driven with company-configured thresholds
//
// Gradual restoration steps down one level at a time, checking abort conditions
// between steps. Maintains a full audit log of every state change.

import type { Dispatcher } from './dispatcher';
import type RPMEngine from '../background/rpm-engine';
import type { ChakraConfig } from '../config/loader';
import type { AdapterManager } from '../integrations/container-bridge/adapter-manager';
import {
  DEFAULT_RPM_ACTIVATE_THRESHOLD,
  DEFAULT_RPM_DEACTIVATE_THRESHOLD,
  DEFAULT_ACTIVATE_SUSTAINED_SECONDS,
  DEFAULT_DEACTIVATE_SUSTAINED_SECONDS,
} from '../config/defaults';

// ─── Public types ─────────────────────────────────────────────────────────────

export type RestoreSequence = 'gradual' | 'immediate';

export type LogEntryKind =
  | 'activated'
  | 'sleep_initiated'
  | 'restore_step'
  | 'fully_restored'
  | 'restore_paused'
  | 'restore_resumed';

export interface ActivationLogEntry {
  timestamp: number;
  kind: LogEntryKind;
  mode: 'manual' | 'auto';
  level: number;
  rpmAtEvent: number;
  initiatedBy?: string;           // for manual activations
  triggerReason?: string;         // for auto activations — what condition fired
  note?: string;                  // for restore steps
}

export interface ActivationControllerConfig {
  dispatcher: Dispatcher;
  rpmEngine: RPMEngine;
  chakraConfig: ChakraConfig;
  /** Max log entries to retain in memory (default: 500) */
  maxLogEntries?: number;
  /** Override restore step interval — ms between level steps (default: from config) */
  restoreStepIntervalMs?: number;
  /** Override the auto-mode poll interval ms (default: 5000) */
  autoPollIntervalMs?: number;
  /** Optional Container Bridge adapter manager — enables hold-for-scaling logic */
  adapterManager?: AdapterManager;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_RESTORE_STEP_WAIT_SECONDS = 30;
const DEFAULT_MAX_LOG_ENTRIES = 500;
const AUTO_POLL_INTERVAL_MS = 5_000;
const MAX_LEVEL = 3;

// ─── ActivationController ──────────────────────────────────────────────────────

export class ActivationController {
  private readonly dispatcher: Dispatcher;
  private readonly rpmEngine: RPMEngine;
  private chakraConfig: ChakraConfig;
  private readonly maxLogEntries: number;
  private readonly restoreStepIntervalMs: number;
  private readonly autoPollIntervalMs: number;

  // Audit log
  private readonly log: ActivationLogEntry[] = [];

  // Container Bridge
  private readonly adapterManager: AdapterManager | null;

  // Auto mode state
  private thresholdExceededSince: number | null = null;
  private thresholdBelowSince: number | null = null;
  private autoPollInterval: ReturnType<typeof setInterval> | null = null;
  /** Timestamp when CHAKRA began holding activation for infrastructure scaling */
  private holdingSince: number | null = null;

  // Gradual restore state
  private restorationInterval: ReturnType<typeof setInterval> | null = null;
  private restorationPaused = false;
  constructor(config: ActivationControllerConfig) {
    this.dispatcher = config.dispatcher;
    this.rpmEngine = config.rpmEngine;
    this.chakraConfig = config.chakraConfig;
    this.maxLogEntries = config.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES;

    const configuredRestoreMs =
      (config.chakraConfig.deactivate_when?.restore_step_wait_seconds
        ?? DEFAULT_RESTORE_STEP_WAIT_SECONDS) * 1_000;

    this.restoreStepIntervalMs = config.restoreStepIntervalMs ?? configuredRestoreMs;
    this.autoPollIntervalMs = config.autoPollIntervalMs ?? AUTO_POLL_INTERVAL_MS;
    this.adapterManager = config.adapterManager ?? null;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start the Activation Controller.
   * In Auto Mode: begins the RPM polling interval.
   * In Manual Mode: no background work — waits for human calls.
   * Idempotent — safe to call multiple times.
   */
  start(): void {
    if (this.chakraConfig.mode === 'auto' && this.autoPollInterval === null) {
      this.autoPollInterval = setInterval(() => {
        try { this.autoModeTick(); } catch { /* never propagate */ }
      }, this.autoPollIntervalMs);

      if (typeof this.autoPollInterval.unref === 'function') {
        this.autoPollInterval.unref();
      }
    }
  }

  /** Stop all background intervals. Safe to call when already stopped. */
  stop(): void {
    if (this.autoPollInterval !== null) {
      clearInterval(this.autoPollInterval);
      this.autoPollInterval = null;
    }
    this.cancelRestoration();
  }

  // ─── Manual controls ───────────────────────────────────────────────────────

  /**
   * Activate CHAKRA at the given level.
   * Cancels any in-progress restoration.
   * @param level  1–3 (clamped). Default: 1.
   * @param initiatedBy  Optional identifier for audit log (e.g. user email).
   */
  activate(level = 1, initiatedBy?: string): void {
    const clamped = Math.min(Math.max(Math.round(level), 1), MAX_LEVEL);

    this.cancelRestoration();
    this.dispatcher.setActivationState({ active: true, currentLevel: clamped });

    this.appendLog({
      kind: 'activated',
      level: clamped,
      initiatedBy,
    });
  }

  /**
   * Initiate the sleep sequence.
   * @param sequence  'gradual' (default) or 'immediate'.
   * @param initiatedBy  Optional identifier for audit log.
   */
  initiateSleep(sequence?: RestoreSequence, initiatedBy?: string): void {
    const activation = this.dispatcher.getActivationState();
    if (!activation.active) return;  // already sleeping

    const resolvedSequence =
      sequence
      ?? (this.chakraConfig.deactivate_when?.restore_sequence ?? 'gradual');

    this.appendLog({
      kind: 'sleep_initiated',
      level: activation.currentLevel,
      initiatedBy,
      note: `restoration: ${resolvedSequence}`,
    });

    if (resolvedSequence === 'immediate') {
      this.dispatcher.setActivationState({ active: false, currentLevel: 0 });
      this.appendLog({ kind: 'fully_restored', level: 0 });
    } else {
      this.startGradualRestore();
    }
  }

  // ─── Live config update ────────────────────────────────────────────────────

  /**
   * Update the strategy config without restart.
   * Takes effect on the next auto-mode evaluation cycle.
   */
  updateConfig(config: ChakraConfig): void {
    this.chakraConfig = config;

    // If mode changed to auto and we're not polling, start
    if (config.mode === 'auto' && this.autoPollInterval === null) {
      this.start();
    }
    // If mode changed to manual, stop auto-polling
    if (config.mode === 'manual' && this.autoPollInterval !== null) {
      clearInterval(this.autoPollInterval);
      this.autoPollInterval = null;
    }
  }

  // ─── Observability ─────────────────────────────────────────────────────────

  /** Full audit log — most recent entry last. Returns a deep copy of entries. */
  getLog(): readonly ActivationLogEntry[] {
    return this.log.map(e => ({ ...e }));
  }

  /** Last N log entries. Returns deep copies. */
  getRecentLog(n = 20): readonly ActivationLogEntry[] {
    return this.log.slice(-n).map(e => ({ ...e }));
  }

  /** Whether a gradual restoration is currently in progress. */
  isRestoring(): boolean {
    return this.restorationInterval !== null;
  }

  /** Whether restoration is currently paused (abort-sleep condition detected). */
  isRestorationPaused(): boolean {
    return this.restorationPaused;
  }

  // ─── Gradual restore ───────────────────────────────────────────────────────

  private startGradualRestore(): void {
    this.cancelRestoration();
    this.restorationPaused = false;

    // We step down one level every restoreStepIntervalMs
    this.restorationInterval = setInterval(() => {
      try { this.gradualRestoreStep(); } catch { /* never propagate */ }
    }, this.restoreStepIntervalMs);

    if (typeof this.restorationInterval.unref === 'function') {
      this.restorationInterval.unref();
    }
  }

  private gradualRestoreStep(): void {
    const activation = this.dispatcher.getActivationState();

    // If CHAKRA was re-activated externally, abort restoration
    if (!activation.active) {
      this.cancelRestoration();
      return;
    }

    // Check abort condition
    if (this.shouldAbortRestore()) {
      if (!this.restorationPaused) {
        this.restorationPaused = true;
        this.appendLog({
          kind: 'restore_paused',
          level: activation.currentLevel,
          note: `RPM climbed above abort threshold`,
        });
      }
      return;  // stay paused — keep interval running, re-check next tick
    }

    // Resume from pause if conditions cleared
    if (this.restorationPaused) {
      this.restorationPaused = false;
      this.appendLog({
        kind: 'restore_resumed',
        level: activation.currentLevel,
        note: 'RPM returned below abort threshold',
      });
    }

    const currentLevel = activation.currentLevel;
    const nextLevel = currentLevel - 1;

    if (nextLevel <= 0) {
      // Final step: fully deactivate
      this.dispatcher.setActivationState({ active: false, currentLevel: 0 });
      this.appendLog({ kind: 'fully_restored', level: 0 });
      this.cancelRestoration();
    } else {
      // Step down one level
      this.dispatcher.setActivationState({ active: true, currentLevel: nextLevel });
      this.appendLog({
        kind: 'restore_step',
        level: nextLevel,
        note: `stepped down from level ${currentLevel} to ${nextLevel}`,
      });
    }
  }

  private cancelRestoration(): void {
    if (this.restorationInterval !== null) {
      clearInterval(this.restorationInterval);
      this.restorationInterval = null;
    }
    this.restorationPaused = false;
  }

  private shouldAbortRestore(): boolean {
    const abortThreshold = this.chakraConfig.abort_sleep_if?.rpm_climbs_above;
    if (abortThreshold === undefined) return false;

    const currentRpm = this.rpmEngine.getState().global;
    return currentRpm > abortThreshold;
  }

  // ─── Auto mode tick ────────────────────────────────────────────────────────

  private autoModeTick(): void {
    const rpmState = this.rpmEngine.getState();
    const globalRpm = rpmState.global;
    const isActive = this.dispatcher.isActive();
    const isRestoring = this.restorationInterval !== null;
    const now = Date.now();

    if (!isActive && !isRestoring) {
      // Check activation conditions
      const threshold = this.chakraConfig.activate_when?.rpm_threshold
        ?? DEFAULT_RPM_ACTIVATE_THRESHOLD;
      const sustainedMs = (this.chakraConfig.activate_when?.sustained_seconds
        ?? DEFAULT_ACTIVATE_SUSTAINED_SECONDS) * 1_000;

      if (globalRpm >= threshold) {
        if (this.thresholdExceededSince === null) {
          this.thresholdExceededSince = now;
        } else if (now - this.thresholdExceededSince >= sustainedMs) {
          // RPM threshold sustained — check Container Bridge before activating
          if (this.adapterManager !== null) {
            // Async hold evaluation — fire and forget with try/catch
            const exceededSince = this.thresholdExceededSince;
            this.adapterManager.evaluateHold(this.chakraConfig, this.holdingSince)
              .then(decision => {
                if (decision.hold) {
                  if (this.holdingSince === null) {
                    this.holdingSince = Date.now();
                  }
                  // Log hold only once per hold period (when holdingSince is newly set)
                } else {
                  this.holdingSince = null;
                  this.activate(1);
                  this.patchLastLogTrigger(
                    `RPM exceeded threshold ${threshold} for ${Math.round((Date.now() - exceededSince) / 1000)}s. ${decision.reason}`,
                  );
                  this.thresholdExceededSince = null;
                }
              })
              .catch(() => {
                // Adapter error — activate on RPM as fallback
                this.holdingSince = null;
                this.activate(1);
                this.patchLastLogTrigger(
                  `RPM exceeded threshold ${threshold} — infrastructure check failed, activating`,
                );
                this.thresholdExceededSince = null;
              });
          } else {
            this.activate(1);
            this.patchLastLogTrigger(
              `RPM exceeded threshold ${threshold} for ${Math.round((now - this.thresholdExceededSince) / 1000)}s`,
            );
            this.thresholdExceededSince = null;
          }
        }
      } else {
        this.thresholdExceededSince = null;
        this.holdingSince = null;  // RPM dropped — cancel any hold
      }

    } else if (isActive && !isRestoring) {
      // Check deactivation conditions
      const deactivateBelow = this.chakraConfig.deactivate_when?.rpm_below
        ?? DEFAULT_RPM_DEACTIVATE_THRESHOLD;
      const sustainedMs = (this.chakraConfig.deactivate_when?.sustained_seconds
        ?? DEFAULT_DEACTIVATE_SUSTAINED_SECONDS) * 1_000;

      if (globalRpm < deactivateBelow) {
        if (this.thresholdBelowSince === null) {
          this.thresholdBelowSince = now;
        } else if (now - this.thresholdBelowSince >= sustainedMs) {
          this.initiateSleep(undefined, 'auto');
          this.thresholdBelowSince = null;
        }
      } else {
        this.thresholdBelowSince = null;
      }
    }
  }

  // ─── Log helpers ───────────────────────────────────────────────────────────

  private appendLog(entry: Omit<ActivationLogEntry, 'timestamp' | 'mode' | 'rpmAtEvent'>): void {
    const rpmAtEvent = this.rpmEngine.getState().global;
    const full: ActivationLogEntry = {
      timestamp: Date.now(),
      kind: entry.kind,
      mode: this.chakraConfig.mode,
      level: entry.level,
      rpmAtEvent,
      ...(entry.initiatedBy !== undefined && { initiatedBy: entry.initiatedBy }),
      ...(entry.triggerReason !== undefined && { triggerReason: entry.triggerReason }),
      ...(entry.note !== undefined && { note: entry.note }),
    };

    this.log.push(full);

    // Cap log size — drop oldest entries
    if (this.log.length > this.maxLogEntries) {
      this.log.splice(0, this.log.length - this.maxLogEntries);
    }
  }

  /** Patch the trigger reason onto the most recent log entry (used by auto-activate). */
  private patchLastLogTrigger(reason: string): void {
    if (this.log.length > 0) {
      this.log[this.log.length - 1].triggerReason = reason;
    }
  }
}

export default ActivationController;
