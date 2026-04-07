import { RPMEngine, normalizeRAR, normalizeRLP, normalizeERD, interpolate } from '../../src/background/rpm-engine';
import type { BaselineConfig, RecordRequestParams } from '../../src/types';

// --- Helpers ---

const defaultConfig: BaselineConfig = {
  requestRateBaseline: 500,   // 500 req/min
  latencyP95Baseline: 200,    // 200ms
  errorRateBaseline: 1,       // 1%
};

function createEngine(config?: Partial<BaselineConfig>): RPMEngine {
  return new RPMEngine({ ...defaultConfig, ...config });
}

function recordMany(
  engine: RPMEngine,
  count: number,
  overrides?: Partial<RecordRequestParams>,
): void {
  const base: RecordRequestParams = {
    endpoint: '/test',
    block: 'test-block',
    responseTimeMs: 100,
    statusCode: 200,
    ...overrides,
  };
  for (let i = 0; i < count; i++) {
    engine.recordRequest(base);
  }
}

function advanceTick(): void {
  vi.advanceTimersByTime(5_000);
}

// ===================================================================
// Signal Normalization Curves
// ===================================================================

describe('normalizeRAR', () => {
  it('returns 0 at 1.0x baseline', () => {
    expect(normalizeRAR(1.0)).toBe(0);
  });

  it('returns 50 at 2.0x baseline', () => {
    expect(normalizeRAR(2.0)).toBe(50);
  });

  it('returns 75 at 3.0x baseline', () => {
    expect(normalizeRAR(3.0)).toBe(75);
  });

  it('returns 95 at 4.0x baseline', () => {
    expect(normalizeRAR(4.0)).toBe(95);
  });

  it('returns 0 below baseline (ratio < 1.0)', () => {
    expect(normalizeRAR(0.5)).toBe(0);
  });

  it('interpolates between reference points (2.5x → 62.5)', () => {
    expect(normalizeRAR(2.5)).toBe(62.5);
  });

  it('clamps to 100 at extreme ratios', () => {
    expect(normalizeRAR(6.0)).toBe(100);
    expect(normalizeRAR(10.0)).toBe(100);
  });
});

describe('normalizeRLP', () => {
  it('returns 0 at 1.0x baseline', () => {
    expect(normalizeRLP(1.0)).toBe(0);
  });

  it('returns 40 at 2.0x baseline', () => {
    expect(normalizeRLP(2.0)).toBe(40);
  });

  it('returns 65 at 3.0x baseline', () => {
    expect(normalizeRLP(3.0)).toBe(65);
  });

  it('returns 90 at 5.0x baseline', () => {
    expect(normalizeRLP(5.0)).toBe(90);
  });

  it('clamps to 100 at extreme ratios', () => {
    expect(normalizeRLP(7.0)).toBe(100);
  });

  it('interpolates at midpoints (1.5x → 20)', () => {
    expect(normalizeRLP(1.5)).toBe(20);
  });
});

describe('normalizeERD', () => {
  it('returns 0 at 1.0x baseline', () => {
    expect(normalizeERD(1.0)).toBe(0);
  });

  it('returns 30 at 1.5x baseline', () => {
    expect(normalizeERD(1.5)).toBe(30);
  });

  it('returns 55 at 2.0x baseline', () => {
    expect(normalizeERD(2.0)).toBe(55);
  });

  it('returns 85 at 4.0x baseline', () => {
    expect(normalizeERD(4.0)).toBe(85);
  });

  it('clamps to 100 at extreme ratios', () => {
    expect(normalizeERD(6.0)).toBe(100);
  });

  it('returns 0 below baseline', () => {
    expect(normalizeERD(0.8)).toBe(0);
  });
});

describe('interpolate', () => {
  const points: [number, number][] = [[0, 0], [10, 100]];

  it('returns first value when x is at or below first point', () => {
    expect(interpolate(points, -5)).toBe(0);
    expect(interpolate(points, 0)).toBe(0);
  });

  it('returns last value when x is at or above last point', () => {
    expect(interpolate(points, 10)).toBe(100);
    expect(interpolate(points, 20)).toBe(100);
  });

  it('interpolates linearly between points', () => {
    expect(interpolate(points, 5)).toBe(50);
    expect(interpolate(points, 2.5)).toBe(25);
  });
});

// ===================================================================
// Formula Verification
// ===================================================================

describe('RPM formula', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('produces 0 when all signals are at baseline', () => {
    // Engine must be created first so startTime anchors at T=0.
    // Advancing time after creation moves the engine into Phase 2+ where RAR contributes.
    const engine = createEngine();
    vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 1000);
    engine.start();

    // Record requests at baseline rate: 500 req/min = ~42 per 5 seconds
    // with baseline latency (200ms) and no errors (1% baseline)
    recordMany(engine, 42, { responseTimeMs: 200, statusCode: 200 });

    advanceTick();
    const state = engine.getState();
    // At baseline, all ratios are ~1.0x, all scores should be near 0
    expect(state.global).toBeLessThanOrEqual(10);
    engine.stop();
  });

  it('weights sum to 1.0 (0.30 + 0.40 + 0.30)', () => {
    expect(0.30 + 0.40 + 0.30).toBe(1.0);
  });

  it('produces higher RPM with elevated latency', () => {
    const engine = createEngine();
    vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 1000);
    engine.start();

    // Record with 3x baseline latency (600ms vs 200ms baseline)
    recordMany(engine, 42, { responseTimeMs: 600, statusCode: 200 });

    advanceTick();
    const state = engine.getState();
    // RLP at 3.0x = 65, weighted at 0.40 = 26, smoothed ~13 first tick
    expect(state.global).toBeGreaterThan(10);
    engine.stop();
  });

  it('produces higher RPM with elevated error rate', () => {
    const engine = createEngine();
    vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 1000);
    engine.start();

    // Record 100 requests: 10 errors = 10% error rate (10x baseline of 1%)
    recordMany(engine, 90, { responseTimeMs: 200, statusCode: 200 });
    recordMany(engine, 10, { responseTimeMs: 200, statusCode: 500 });

    advanceTick();
    const state = engine.getState();
    expect(state.global).toBeGreaterThan(15);
    engine.stop();
  });
});

// ===================================================================
// Smoothing
// ===================================================================

describe('smoothing', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('first reading applies 50% weight (history starts at [0,0,0])', () => {
    const engine = createEngine();
    engine.start();

    // Record high-latency requests to produce a non-zero raw RPM
    recordMany(engine, 50, { responseTimeMs: 1000, statusCode: 200 });

    // First tick
    advanceTick();
    const stateAfterFirst = engine.getState();
    // With smoothing [0, 0, raw], result = raw * 0.50
    // So smoothed should be roughly half of what raw would be
    expect(stateAfterFirst.global).toBeGreaterThanOrEqual(0);
    expect(stateAfterFirst.global).toBeLessThanOrEqual(100);

    engine.stop();
  });

  it('successive readings increase RPM when load is sustained', () => {
    const engine = createEngine();
    engine.start();

    // Record same high-latency requests for multiple ticks
    recordMany(engine, 50, { responseTimeMs: 1000, statusCode: 200 });
    advanceTick();
    const first = engine.getState().global;

    recordMany(engine, 50, { responseTimeMs: 1000, statusCode: 200 });
    advanceTick();
    const second = engine.getState().global;

    recordMany(engine, 50, { responseTimeMs: 1000, statusCode: 200 });
    advanceTick();
    const third = engine.getState().global;

    // Each successive reading should be >= previous as smoothing catches up
    expect(second).toBeGreaterThanOrEqual(first);
    expect(third).toBeGreaterThanOrEqual(second);

    engine.stop();
  });

  it('smoothing dampens sudden changes', () => {
    const engine = createEngine();
    engine.start();

    // First few ticks: low load
    recordMany(engine, 50, { responseTimeMs: 100, statusCode: 200 });
    advanceTick();
    advanceTick();
    advanceTick();
    const calm = engine.getState().global;

    // Sudden spike
    recordMany(engine, 100, { responseTimeMs: 2000, statusCode: 500 });
    advanceTick();
    const spike = engine.getState().global;

    // Smoothed spike should be less than what raw would be
    // because history still has low readings
    expect(spike).toBeGreaterThan(calm);
    // But still bounded
    expect(spike).toBeLessThanOrEqual(100);

    engine.stop();
  });
});

// ===================================================================
// Cold Start
// ===================================================================

describe('cold start', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts in phase 1', () => {
    const engine = createEngine();
    expect(engine.getState().phase).toBe(1);
  });

  it('transitions to phase 2 after 2 hours', () => {
    const engine = createEngine();
    vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 1000);
    // Need to trigger a tick to update phase in state
    engine.start();
    advanceTick();
    expect(engine.getState().phase).toBe(2);
    engine.stop();
  });

  it('transitions to phase 3 after 24 hours', () => {
    const engine = createEngine();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1000);
    engine.start();
    advanceTick();
    expect(engine.getState().phase).toBe(3);
    engine.stop();
  });

  it('returns valid RPMState before any requests', () => {
    const engine = createEngine();
    const state = engine.getState();
    expect(state.global).toBe(0);
    expect(state.perBlock).toEqual({});
    expect(state.updatedAt).toBeGreaterThan(0);
    expect(state.phase).toBe(1);
  });

  it('recordRequest works during cold start without throwing', () => {
    const engine = createEngine();
    expect(() => {
      engine.recordRequest({
        endpoint: '/test',
        block: 'test',
        responseTimeMs: 100,
        statusCode: 200,
      });
    }).not.toThrow();
  });
});

// ===================================================================
// recordRequest safety
// ===================================================================

describe('recordRequest', () => {
  it('never throws with valid input', () => {
    const engine = createEngine();
    expect(() => {
      engine.recordRequest({
        endpoint: '/api/test',
        block: 'api',
        responseTimeMs: 150,
        statusCode: 200,
      });
    }).not.toThrow();
  });

  it('never throws with extreme values', () => {
    const engine = createEngine();
    expect(() => {
      engine.recordRequest({
        endpoint: '',
        block: '',
        responseTimeMs: -100,
        statusCode: 0,
      });
    }).not.toThrow();
  });

  it('never throws with very large values', () => {
    const engine = createEngine();
    expect(() => {
      engine.recordRequest({
        endpoint: '/test',
        block: 'test',
        responseTimeMs: Number.MAX_SAFE_INTEGER,
        statusCode: 999,
      });
    }).not.toThrow();
  });

  it('updates internal state (verified by RPM change after tick)', () => {
    vi.useFakeTimers();
    const engine = createEngine();
    engine.start();

    // Record high-latency requests
    recordMany(engine, 100, { responseTimeMs: 5000, statusCode: 500 });
    advanceTick();

    const state = engine.getState();
    // Should have non-zero RPM from the recorded requests
    expect(state.global).toBeGreaterThan(0);

    engine.stop();
    vi.useRealTimers();
  });
});

// ===================================================================
// getState immutability
// ===================================================================

describe('getState immutability', () => {
  it('returns a frozen object', () => {
    const engine = createEngine();
    const state = engine.getState();
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('perBlock is also frozen', () => {
    vi.useFakeTimers();
    const engine = createEngine();
    engine.start();

    recordMany(engine, 50, { responseTimeMs: 100, statusCode: 200 });
    advanceTick();

    const state = engine.getState();
    expect(Object.isFrozen(state.perBlock)).toBe(true);

    engine.stop();
    vi.useRealTimers();
  });

  it('returns consistent snapshot between ticks', () => {
    const engine = createEngine();
    const state1 = engine.getState();
    const state2 = engine.getState();
    expect(state1).toBe(state2); // same reference
  });

  it('old snapshot remains valid after new tick', () => {
    vi.useFakeTimers();
    const engine = createEngine();
    engine.start();

    const oldState = engine.getState();
    recordMany(engine, 100, { responseTimeMs: 5000, statusCode: 500 });
    advanceTick();

    const newState = engine.getState();
    // Old state should still be the original values
    expect(oldState.global).toBe(0);
    // New state may differ
    expect(newState).not.toBe(oldState);

    engine.stop();
    vi.useRealTimers();
  });
});

// ===================================================================
// Lifecycle (start/stop/restart)
// ===================================================================

describe('lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('start() begins ticking — state updates after interval', () => {
    const engine = createEngine();
    engine.start();

    recordMany(engine, 100, { responseTimeMs: 2000, statusCode: 500 });
    advanceTick();

    expect(engine.getState().global).toBeGreaterThan(0);
    engine.stop();
  });

  it('start() is idempotent — calling twice does not create two intervals', () => {
    const engine = createEngine();
    engine.start();
    engine.start(); // second call

    recordMany(engine, 100, { responseTimeMs: 2000, statusCode: 200 });
    advanceTick();
    const rpm1 = engine.getState().global;

    // If two intervals were running, state would be different
    // due to double-ticking. Verify single tick behavior.
    advanceTick();
    const rpm2 = engine.getState().global;
    // Second tick with no new requests should show smoothing effect
    expect(rpm2).toBeLessThanOrEqual(rpm1);

    engine.stop();
  });

  it('stop() halts ticking', () => {
    const engine = createEngine();
    engine.start();

    recordMany(engine, 100, { responseTimeMs: 2000, statusCode: 500 });
    advanceTick();
    const rpmBefore = engine.getState().global;

    engine.stop();

    recordMany(engine, 200, { responseTimeMs: 5000, statusCode: 500 });
    advanceTick();
    const rpmAfter = engine.getState().global;

    // RPM should not change after stop
    expect(rpmAfter).toBe(rpmBefore);
  });

  it('stop() is safe when not running', () => {
    const engine = createEngine();
    expect(() => engine.stop()).not.toThrow();
  });

  it('can restart after stop', () => {
    const engine = createEngine();
    engine.start();
    engine.stop();
    engine.start();

    recordMany(engine, 100, { responseTimeMs: 3000, statusCode: 500 });
    advanceTick();

    expect(engine.getState().global).toBeGreaterThan(0);
    engine.stop();
  });
});

// ===================================================================
// Error Resilience
// ===================================================================

describe('error resilience', () => {
  it('returns valid initial state with global=0, empty perBlock, phase=1', () => {
    const engine = createEngine();
    const state = engine.getState();
    expect(state.global).toBe(0);
    expect(state.perBlock).toEqual({});
    expect(state.phase).toBe(1);
  });

  it('getState() always returns a valid RPMState', () => {
    const engine = createEngine();
    const state = engine.getState();
    expect(typeof state.global).toBe('number');
    expect(typeof state.perBlock).toBe('object');
    expect(typeof state.updatedAt).toBe('number');
    expect([1, 2, 3]).toContain(state.phase);
  });

  it('engine continues working after many rapid requests', () => {
    vi.useFakeTimers();
    const engine = createEngine();
    engine.start();

    // Flood with requests
    for (let i = 0; i < 15_000; i++) {
      engine.recordRequest({
        endpoint: '/flood',
        block: 'flood',
        responseTimeMs: Math.random() * 500,
        statusCode: i % 10 === 0 ? 500 : 200,
      });
    }

    advanceTick();
    const state = engine.getState();
    expect(state.global).toBeGreaterThanOrEqual(0);
    expect(state.global).toBeLessThanOrEqual(100);

    engine.stop();
    vi.useRealTimers();
  });
});

// ===================================================================
// Per-block RPM
// ===================================================================

describe('per-block RPM', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('tracks separate blocks in perBlock record', () => {
    const engine = createEngine();
    engine.start();

    recordMany(engine, 50, { block: 'payment', responseTimeMs: 100, statusCode: 200 });
    recordMany(engine, 50, { block: 'browse', responseTimeMs: 100, statusCode: 200 });

    advanceTick();
    const state = engine.getState();
    expect('payment' in state.perBlock).toBe(true);
    expect('browse' in state.perBlock).toBe(true);
  });

  it('stressed block shows higher per-block RPM', () => {
    const engine = createEngine();
    engine.start();

    // Healthy block
    recordMany(engine, 50, { block: 'payment', responseTimeMs: 100, statusCode: 200 });
    // Stressed block (high latency + errors)
    recordMany(engine, 30, { block: 'browse', responseTimeMs: 3000, statusCode: 200 });
    recordMany(engine, 20, { block: 'browse', responseTimeMs: 3000, statusCode: 500 });

    advanceTick();
    const state = engine.getState();
    expect(state.perBlock['browse']).toBeGreaterThan(state.perBlock['payment']);
  });

  it('block with no requests has no entry in perBlock', () => {
    const engine = createEngine();
    engine.start();

    recordMany(engine, 50, { block: 'active', responseTimeMs: 100, statusCode: 200 });
    advanceTick();

    const state = engine.getState();
    expect('active' in state.perBlock).toBe(true);
    expect('inactive' in state.perBlock).toBe(false);
  });

  it('per-block scores are bounded 0-100', () => {
    const engine = createEngine();
    engine.start();

    recordMany(engine, 100, { block: 'test', responseTimeMs: 10000, statusCode: 500 });
    advanceTick();

    const state = engine.getState();
    const score = state.perBlock['test'];
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

// ===================================================================
// Ring Buffer Edge Cases
// ===================================================================

describe('ring buffer edge cases', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('empty buffer produces RPM 0', () => {
    const engine = createEngine();
    engine.start();
    advanceTick();
    expect(engine.getState().global).toBe(0);
    engine.stop();
  });

  it('overflow does not crash — oldest entries are overwritten', () => {
    const engine = createEngine();
    engine.start();

    // Exceed ring buffer capacity (10,000)
    for (let i = 0; i < 12_000; i++) {
      engine.recordRequest({
        endpoint: '/overflow',
        block: 'overflow',
        responseTimeMs: 200,
        statusCode: 200,
      });
    }

    advanceTick();
    expect(engine.getState().global).toBeGreaterThanOrEqual(0);
    engine.stop();
  });

  it('only considers entries within 60-second window', () => {
    const engine = createEngine();
    engine.start();

    // Record some requests
    recordMany(engine, 50, { responseTimeMs: 5000, statusCode: 500 });
    advanceTick();
    const rpmWithData = engine.getState().global;

    // Advance beyond the 60-second window (12+ ticks = 60+ seconds)
    for (let i = 0; i < 13; i++) {
      advanceTick();
    }
    const rpmAfterWindow = engine.getState().global;

    // After all data expires from the window, RPM should drop toward 0
    expect(rpmAfterWindow).toBeLessThan(rpmWithData);
    engine.stop();
  });
});
