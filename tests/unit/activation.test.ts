// Tests for CP2.5: ActivationController
// Covers: manual activate/deactivate, gradual restore, abort-sleep,
//         auto-mode threshold logic, audit log, config live-update, lifecycle.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ActivationController } from '../../src/core/activation';
import type { ActivationControllerConfig } from '../../src/core/activation';
import type { Dispatcher } from '../../src/core/dispatcher';
import type RPMEngine from '../../src/background/rpm-engine';
import type { ChakraConfig } from '../../src/config/loader';
import type { RPMState } from '../../src/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRPMState(global: number): RPMState {
  return { global, perBlock: {}, updatedAt: Date.now(), phase: 1 };
}

function createMockDispatcher(initialLevel = 0): {
  dispatch: ReturnType<typeof vi.fn>;
  setActivationState: ReturnType<typeof vi.fn>;
  getActivationState: ReturnType<typeof vi.fn>;
  isActive: ReturnType<typeof vi.fn>;
  active: boolean;
  currentLevel: number;
} {
  const state = { active: false, currentLevel: initialLevel };

  const mock = {
    dispatch: vi.fn(),
    setActivationState: vi.fn((s: { active: boolean; currentLevel: number }) => {
      state.active = s.active;
      state.currentLevel = s.currentLevel;
    }),
    getActivationState: vi.fn(() => ({ ...state })),
    isActive: vi.fn(() => state.active),
    get active() { return state.active; },
    get currentLevel() { return state.currentLevel; },
  };
  return mock;
}

function createMockRPMEngine(initialRpm = 0): {
  getState: ReturnType<typeof vi.fn>;
  recordRequest: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  setRPM(value: number): void;
  _rpm: number;
} {
  const engine = {
    _rpm: initialRpm,
    getState: vi.fn(() => makeRPMState(engine._rpm)),
    recordRequest: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    setRPM(value: number) { engine._rpm = value; },
  };
  return engine;
}

function createConfig(overrides: Partial<ChakraConfig> = {}): ChakraConfig {
  return {
    mode: 'manual',
    activate_when: { rpm_threshold: 72, sustained_seconds: 90 },
    deactivate_when: { rpm_below: 55, sustained_seconds: 60, restore_sequence: 'gradual', restore_step_wait_seconds: 30 },
    ...overrides,
  };
}

function createController(
  overrides: Partial<ActivationControllerConfig> & {
    dispatcherOverride?: ReturnType<typeof createMockDispatcher>;
    rpmEngineOverride?: ReturnType<typeof createMockRPMEngine>;
    configOverride?: ChakraConfig;
  } = {},
): {
  controller: ActivationController;
  dispatcher: ReturnType<typeof createMockDispatcher>;
  rpmEngine: ReturnType<typeof createMockRPMEngine>;
} {
  const dispatcher = overrides.dispatcherOverride ?? createMockDispatcher();
  const rpmEngine = overrides.rpmEngineOverride ?? createMockRPMEngine();
  const config = overrides.configOverride ?? createConfig();

  const controller = new ActivationController({
    dispatcher: dispatcher as unknown as Dispatcher,
    rpmEngine: rpmEngine as unknown as RPMEngine,
    chakraConfig: config,
    maxLogEntries: overrides.maxLogEntries,
    restoreStepIntervalMs: overrides.restoreStepIntervalMs,
    autoPollIntervalMs: overrides.autoPollIntervalMs,
  });

  return { controller, dispatcher, rpmEngine };
}

// ─── Manual activation ────────────────────────────────────────────────────────

describe('manual activation — activate()', () => {
  it('sets dispatcher to active at level 1 by default', () => {
    const { controller, dispatcher } = createController();
    controller.activate();
    expect(dispatcher.setActivationState).toHaveBeenCalledWith({ active: true, currentLevel: 1 });
  });

  it('sets dispatcher to active at specified level', () => {
    const { controller, dispatcher } = createController();
    controller.activate(2);
    expect(dispatcher.setActivationState).toHaveBeenCalledWith({ active: true, currentLevel: 2 });
  });

  it('clamps level below 1 to 1', () => {
    const { controller, dispatcher } = createController();
    controller.activate(0);
    expect(dispatcher.setActivationState).toHaveBeenCalledWith({ active: true, currentLevel: 1 });
  });

  it('clamps level above 3 to 3', () => {
    const { controller, dispatcher } = createController();
    controller.activate(5);
    expect(dispatcher.setActivationState).toHaveBeenCalledWith({ active: true, currentLevel: 3 });
  });

  it('appends an activated log entry', () => {
    const { controller } = createController();
    controller.activate(1, 'ops-engineer');
    const log = controller.getLog();
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe('activated');
    expect(log[0].level).toBe(1);
    expect(log[0].initiatedBy).toBe('ops-engineer');
  });

  it('log entry includes RPM at event time', () => {
    const { controller, rpmEngine } = createController();
    rpmEngine.setRPM(45);
    controller.activate();
    expect(controller.getLog()[0].rpmAtEvent).toBe(45);
  });

  it('cancels any in-progress restoration on re-activate', () => {
    vi.useFakeTimers();
    const dispatcher = createMockDispatcher(2);
    dispatcher.isActive.mockReturnValue(true);
    dispatcher.getActivationState.mockReturnValue({ active: true, currentLevel: 2 });

    const { controller } = createController({ dispatcherOverride: dispatcher, restoreStepIntervalMs: 1000 });

    // Start gradual restore then immediately re-activate
    controller.initiateSleep('gradual');
    expect(controller.isRestoring()).toBe(true);

    controller.activate(3);
    expect(controller.isRestoring()).toBe(false);

    vi.useRealTimers();
  });
});

// ─── initiateSleep — immediate ────────────────────────────────────────────────

describe('initiateSleep("immediate")', () => {
  it('sets dispatcher to inactive immediately', () => {
    const dispatcher = createMockDispatcher(2);
    dispatcher.isActive.mockReturnValue(true);
    dispatcher.getActivationState.mockReturnValue({ active: true, currentLevel: 2 });

    const { controller } = createController({ dispatcherOverride: dispatcher });
    controller.initiateSleep('immediate');

    expect(dispatcher.setActivationState).toHaveBeenCalledWith({ active: false, currentLevel: 0 });
  });

  it('appends sleep_initiated and fully_restored log entries', () => {
    const dispatcher = createMockDispatcher(2);
    dispatcher.isActive.mockReturnValue(true);
    dispatcher.getActivationState.mockReturnValue({ active: true, currentLevel: 2 });

    const { controller } = createController({ dispatcherOverride: dispatcher });
    controller.initiateSleep('immediate');

    const log = controller.getLog();
    expect(log.some(e => e.kind === 'sleep_initiated')).toBe(true);
    expect(log.some(e => e.kind === 'fully_restored')).toBe(true);
  });

  it('does nothing when CHAKRA is already inactive', () => {
    const { controller, dispatcher } = createController();
    // Dispatcher starts inactive by default
    controller.initiateSleep('immediate');
    // setActivationState not called (already inactive)
    expect(dispatcher.setActivationState).not.toHaveBeenCalled();
  });
});

// ─── Gradual restore ──────────────────────────────────────────────────────────

describe('gradual restore', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function makeActiveDispatcher(level = 2) {
    const d = createMockDispatcher(level);
    // Initialize state to active so gradualRestoreStep doesn't immediately cancel
    d.setActivationState({ active: true, currentLevel: level });
    // Override mocks to read from live internal state
    d.getActivationState.mockImplementation(() => ({ active: d.active, currentLevel: d.currentLevel }));
    d.isActive.mockImplementation(() => d.active);
    return d;
  }

  it('isRestoring() returns true after initiateSleep("gradual")', () => {
    const dispatcher = makeActiveDispatcher(2);
    const { controller } = createController({ dispatcherOverride: dispatcher, restoreStepIntervalMs: 500 });
    controller.initiateSleep('gradual');
    expect(controller.isRestoring()).toBe(true);
  });

  it('steps down level after first interval tick', () => {
    const dispatcher = makeActiveDispatcher(2);
    const { controller } = createController({ dispatcherOverride: dispatcher, restoreStepIntervalMs: 500 });
    controller.initiateSleep('gradual');

    vi.advanceTimersByTime(500);
    expect(dispatcher.setActivationState).toHaveBeenCalledWith({ active: true, currentLevel: 1 });
  });

  it('fully deactivates after stepping through all levels', () => {
    const dispatcher = makeActiveDispatcher(2);
    const { controller } = createController({ dispatcherOverride: dispatcher, restoreStepIntervalMs: 500 });
    controller.initiateSleep('gradual');

    vi.advanceTimersByTime(500);  // level 2 → 1
    vi.advanceTimersByTime(500);  // level 1 → 0 (deactivate)

    expect(dispatcher.setActivationState).toHaveBeenLastCalledWith({ active: false, currentLevel: 0 });
    expect(controller.isRestoring()).toBe(false);
  });

  it('appends restore_step log entries during restoration', () => {
    const dispatcher = makeActiveDispatcher(2);
    const { controller } = createController({ dispatcherOverride: dispatcher, restoreStepIntervalMs: 500 });
    controller.initiateSleep('gradual');

    vi.advanceTimersByTime(500);
    const log = controller.getLog();
    expect(log.some(e => e.kind === 'restore_step')).toBe(true);
  });

  it('appends fully_restored log entry on completion', () => {
    const dispatcher = makeActiveDispatcher(1);
    const { controller } = createController({ dispatcherOverride: dispatcher, restoreStepIntervalMs: 500 });
    controller.initiateSleep('gradual');

    vi.advanceTimersByTime(500);  // level 1 → 0
    expect(controller.getLog().some(e => e.kind === 'fully_restored')).toBe(true);
  });

  it('isRestoring() returns false after full restoration', () => {
    const dispatcher = makeActiveDispatcher(1);
    const { controller } = createController({ dispatcherOverride: dispatcher, restoreStepIntervalMs: 500 });
    controller.initiateSleep('gradual');

    vi.advanceTimersByTime(500);
    expect(controller.isRestoring()).toBe(false);
  });
});

// ─── Abort sleep ──────────────────────────────────────────────────────────────

describe('abort sleep (abort_sleep_if)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('pauses restoration when RPM climbs above abort threshold', () => {
    const dispatcher = createMockDispatcher(2);
    dispatcher.isActive.mockReturnValue(true);
    dispatcher.getActivationState.mockReturnValue({ active: true, currentLevel: 2 });

    const rpmEngine = createMockRPMEngine(30);
    const config = createConfig({ abort_sleep_if: { rpm_climbs_above: 65 } });
    const { controller } = createController({
      dispatcherOverride: dispatcher,
      rpmEngineOverride: rpmEngine,
      configOverride: config,
      restoreStepIntervalMs: 500,
    });

    controller.initiateSleep('gradual');

    // RPM climbs above abort threshold before first step
    rpmEngine.setRPM(70);
    vi.advanceTimersByTime(500);

    expect(controller.isRestorationPaused()).toBe(true);
    expect(controller.getLog().some(e => e.kind === 'restore_paused')).toBe(true);
    // Level should NOT have changed
    expect(dispatcher.setActivationState).not.toHaveBeenCalledWith({ active: true, currentLevel: 1 });
  });

  it('resumes restoration when RPM drops back below threshold', () => {
    const dispatcher = createMockDispatcher(2);
    dispatcher.isActive.mockReturnValue(true);
    dispatcher.getActivationState.mockReturnValue({ active: true, currentLevel: 2 });

    const rpmEngine = createMockRPMEngine(70);
    const config = createConfig({ abort_sleep_if: { rpm_climbs_above: 65 } });
    const { controller } = createController({
      dispatcherOverride: dispatcher,
      rpmEngineOverride: rpmEngine,
      configOverride: config,
      restoreStepIntervalMs: 500,
    });

    controller.initiateSleep('gradual');

    // Pause first
    vi.advanceTimersByTime(500);
    expect(controller.isRestorationPaused()).toBe(true);

    // RPM drops — next tick should resume and step down
    rpmEngine.setRPM(40);
    vi.advanceTimersByTime(500);

    expect(controller.isRestorationPaused()).toBe(false);
    expect(controller.getLog().some(e => e.kind === 'restore_resumed')).toBe(true);
    expect(dispatcher.setActivationState).toHaveBeenCalledWith({ active: true, currentLevel: 1 });
  });

  it('does not pause when abort_sleep_if is not configured', () => {
    const dispatcher = createMockDispatcher(2);
    dispatcher.isActive.mockReturnValue(true);
    dispatcher.getActivationState.mockReturnValue({ active: true, currentLevel: 2 });

    const rpmEngine = createMockRPMEngine(99);  // high RPM but no abort config
    const config = createConfig();  // no abort_sleep_if
    const { controller } = createController({
      dispatcherOverride: dispatcher,
      rpmEngineOverride: rpmEngine,
      configOverride: config,
      restoreStepIntervalMs: 500,
    });

    controller.initiateSleep('gradual');
    vi.advanceTimersByTime(500);

    expect(controller.isRestorationPaused()).toBe(false);
    // Should have stepped down normally
    expect(dispatcher.setActivationState).toHaveBeenCalledWith({ active: true, currentLevel: 1 });
  });
});

// ─── Auto mode ────────────────────────────────────────────────────────────────

describe('auto mode — activation', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('activates when RPM exceeds threshold for sustained duration', () => {
    const { controller, dispatcher, rpmEngine } = createController({
      configOverride: createConfig({
        mode: 'auto',
        activate_when: { rpm_threshold: 50, sustained_seconds: 10 },
      }),
      autoPollIntervalMs: 5000,
    });

    rpmEngine.setRPM(60);  // above threshold
    controller.start();

    // Tick 1 (t=5s): sets thresholdExceededSince = 5000
    vi.advanceTimersByTime(5000);
    expect(dispatcher.setActivationState).not.toHaveBeenCalled();

    // Tick 2 (t=10s): elapsed = 5s < 10s — not yet
    vi.advanceTimersByTime(5000);
    expect(dispatcher.setActivationState).not.toHaveBeenCalled();

    // Tick 3 (t=15s): elapsed = 10s >= 10s — should activate
    vi.advanceTimersByTime(5000);
    expect(dispatcher.setActivationState).toHaveBeenCalledWith({ active: true, currentLevel: 1 });

    controller.stop();
  });

  it('does NOT activate if RPM drops below threshold before sustained duration', () => {
    const { controller, dispatcher, rpmEngine } = createController({
      configOverride: createConfig({
        mode: 'auto',
        activate_when: { rpm_threshold: 50, sustained_seconds: 20 },
      }),
      autoPollIntervalMs: 5000,
    });

    rpmEngine.setRPM(60);
    controller.start();

    vi.advanceTimersByTime(5000);   // threshold exceeded for 5s
    rpmEngine.setRPM(30);           // drops below
    vi.advanceTimersByTime(5000);   // 10s total — but counter reset

    expect(dispatcher.setActivationState).not.toHaveBeenCalled();
    controller.stop();
  });

  it('appends triggerReason to log entry on auto-activation', () => {
    const { controller, rpmEngine } = createController({
      configOverride: createConfig({
        mode: 'auto',
        activate_when: { rpm_threshold: 50, sustained_seconds: 5 },
      }),
      autoPollIntervalMs: 5000,
    });

    rpmEngine.setRPM(60);
    controller.start();

    vi.advanceTimersByTime(5000);   // starts tracking
    vi.advanceTimersByTime(5000);   // sustained — activates

    const log = controller.getLog();
    const activatedEntry = log.find(e => e.kind === 'activated');
    expect(activatedEntry).toBeDefined();
    expect(activatedEntry?.triggerReason).toMatch(/RPM exceeded/);

    controller.stop();
  });
});

describe('auto mode — deactivation', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('initiates sleep when RPM is below threshold for sustained duration', () => {
    const dispatcher = createMockDispatcher(1);
    dispatcher.isActive.mockReturnValue(true);
    dispatcher.getActivationState.mockReturnValue({ active: true, currentLevel: 1 });

    const rpmEngine = createMockRPMEngine(30);

    const { controller } = createController({
      dispatcherOverride: dispatcher,
      rpmEngineOverride: rpmEngine,
      configOverride: createConfig({
        mode: 'auto',
        deactivate_when: { rpm_below: 55, sustained_seconds: 10, restore_sequence: 'immediate' },
      }),
      autoPollIntervalMs: 5000,
    });

    controller.start();

    // Tick 1 (t=5s): sets thresholdBelowSince = 5000
    vi.advanceTimersByTime(5000);
    expect(dispatcher.setActivationState).not.toHaveBeenCalled();

    // Tick 2 (t=10s): elapsed = 5s < 10s — not yet
    vi.advanceTimersByTime(5000);
    expect(dispatcher.setActivationState).not.toHaveBeenCalled();

    // Tick 3 (t=15s): elapsed = 10s >= 10s — should initiate sleep
    vi.advanceTimersByTime(5000);
    expect(dispatcher.setActivationState).toHaveBeenCalledWith({ active: false, currentLevel: 0 });

    controller.stop();
  });

  it('does not deactivate if RPM rises before sustained duration', () => {
    const dispatcher = createMockDispatcher(1);
    dispatcher.isActive.mockReturnValue(true);
    dispatcher.getActivationState.mockReturnValue({ active: true, currentLevel: 1 });

    const rpmEngine = createMockRPMEngine(30);

    const { controller } = createController({
      dispatcherOverride: dispatcher,
      rpmEngineOverride: rpmEngine,
      configOverride: createConfig({
        mode: 'auto',
        deactivate_when: { rpm_below: 55, sustained_seconds: 20, restore_sequence: 'immediate' },
      }),
      autoPollIntervalMs: 5000,
    });

    controller.start();

    vi.advanceTimersByTime(5000);   // starts tracking
    rpmEngine.setRPM(70);           // rises above deactivate threshold
    vi.advanceTimersByTime(5000);   // counter resets — no deactivation

    expect(dispatcher.setActivationState).not.toHaveBeenCalled();

    controller.stop();
  });
});

// ─── Manual mode — no auto polling ───────────────────────────────────────────

describe('manual mode — no auto polling', () => {
  it('start() does not create a poll interval in manual mode', () => {
    const { controller, dispatcher } = createController({
      configOverride: createConfig({ mode: 'manual' }),
      autoPollIntervalMs: 100,
    });

    controller.start();

    vi.useFakeTimers();
    vi.advanceTimersByTime(10_000);
    // Dispatcher should never be auto-activated
    expect(dispatcher.setActivationState).not.toHaveBeenCalled();
    vi.useRealTimers();

    controller.stop();
  });
});

// ─── Audit log ────────────────────────────────────────────────────────────────

describe('audit log', () => {
  it('getLog() returns an empty array initially', () => {
    const { controller } = createController();
    expect(controller.getLog()).toEqual([]);
  });

  it('getRecentLog(n) returns last n entries', () => {
    const { controller } = createController();
    controller.activate(1);
    controller.activate(2);
    controller.activate(3);

    expect(controller.getRecentLog(2)).toHaveLength(2);
    expect(controller.getRecentLog(2)[1].level).toBe(3);
  });

  it('getLog() returns a copy — mutations do not affect internal state', () => {
    const { controller } = createController();
    controller.activate();
    const log = controller.getLog() as { level: number }[];
    log[0].level = 99;
    expect(controller.getLog()[0].level).not.toBe(99);
  });

  it('log entries include timestamp as a number', () => {
    const { controller } = createController();
    controller.activate();
    expect(typeof controller.getLog()[0].timestamp).toBe('number');
  });

  it('log entries include correct mode', () => {
    const { controller } = createController({ configOverride: createConfig({ mode: 'manual' }) });
    controller.activate();
    expect(controller.getLog()[0].mode).toBe('manual');
  });

  it('caps log entries at maxLogEntries', () => {
    const { controller } = createController({ maxLogEntries: 3 });
    controller.activate(1);
    controller.activate(2);
    controller.activate(3);
    controller.activate(1);  // 4th entry — oldest should be dropped
    expect(controller.getLog()).toHaveLength(3);
  });
});

// ─── Live config update ───────────────────────────────────────────────────────

describe('updateConfig()', () => {
  it('switches from auto to manual — stops polling', () => {
    const { controller } = createController({
      configOverride: createConfig({ mode: 'auto' }),
      autoPollIntervalMs: 100,
    });

    controller.start();
    controller.updateConfig(createConfig({ mode: 'manual' }));

    // No more auto-mode behavior expected after switch
    // (verifying stop via no-throw and isRestoring state)
    expect(controller.isRestoring()).toBe(false);
    controller.stop();
  });

  it('switches from manual to auto — starts polling', () => {
    vi.useFakeTimers();
    const { controller, dispatcher, rpmEngine } = createController({
      configOverride: createConfig({ mode: 'manual' }),
      autoPollIntervalMs: 5000,
    });

    controller.start();
    // Update to auto mode with low threshold
    controller.updateConfig(createConfig({
      mode: 'auto',
      activate_when: { rpm_threshold: 10, sustained_seconds: 5 },
    }));

    rpmEngine.setRPM(50);

    // sustained_seconds: 5 → sustainedMs = 5000ms
    // Tick 1 (t=5s): thresholdExceededSince = 5000
    vi.advanceTimersByTime(5000);
    // Tick 2 (t=10s): elapsed = 5s >= 5s → should activate
    vi.advanceTimersByTime(5000);

    expect(dispatcher.setActivationState).toHaveBeenCalledWith({ active: true, currentLevel: 1 });
    vi.useRealTimers();
    controller.stop();
  });
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────

describe('lifecycle — start() / stop()', () => {
  it('start() is idempotent', () => {
    const { controller } = createController({ configOverride: createConfig({ mode: 'auto' }) });
    expect(() => {
      controller.start();
      controller.start();
      controller.start();
    }).not.toThrow();
    controller.stop();
  });

  it('stop() is idempotent', () => {
    const { controller } = createController();
    expect(() => {
      controller.stop();
      controller.stop();
    }).not.toThrow();
  });

  it('stop() cancels in-progress restoration', () => {
    vi.useFakeTimers();
    const dispatcher = createMockDispatcher(2);
    dispatcher.isActive.mockReturnValue(true);
    dispatcher.getActivationState.mockReturnValue({ active: true, currentLevel: 2 });

    const { controller } = createController({ dispatcherOverride: dispatcher, restoreStepIntervalMs: 1000 });
    controller.initiateSleep('gradual');
    expect(controller.isRestoring()).toBe(true);

    controller.stop();
    expect(controller.isRestoring()).toBe(false);

    vi.useRealTimers();
  });
});

// ─── isRestoring / isRestorationPaused ───────────────────────────────────────

describe('state queries', () => {
  it('isRestoring() is false by default', () => {
    const { controller } = createController();
    expect(controller.isRestoring()).toBe(false);
  });

  it('isRestorationPaused() is false by default', () => {
    const { controller } = createController();
    expect(controller.isRestorationPaused()).toBe(false);
  });
});
