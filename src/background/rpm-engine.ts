import type { RPMState, RecordRequestParams, BaselineConfig } from '../types';

// --- Internal types ---

interface RingBufferEntry {
  timestamp: number;
  responseTimeMs: number;
  statusCode: number;
  block: string;
  endpoint: string;
}

// --- Normalization helpers (exported for direct unit testing) ---

/** Piecewise linear interpolation between reference points */
export function interpolate(points: readonly [number, number][], x: number): number {
  if (x <= points[0][0]) return points[0][1];
  if (x >= points[points.length - 1][0]) return points[points.length - 1][1];

  for (let i = 1; i < points.length; i++) {
    if (x <= points[i][0]) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

/** Normalize Request Arrival Rate ratio to 0-100 score */
export function normalizeRAR(ratio: number): number {
  const points: [number, number][] = [
    [1.0, 0], [2.0, 50], [3.0, 75], [4.0, 95], [5.0, 100],
  ];
  return interpolate(points, ratio);
}

/** Normalize Response Latency P95 ratio to 0-100 score */
export function normalizeRLP(ratio: number): number {
  const points: [number, number][] = [
    [1.0, 0], [2.0, 40], [3.0, 65], [5.0, 90], [6.0, 100],
  ];
  return interpolate(points, ratio);
}

/** Normalize Error Rate Delta ratio to 0-100 score */
export function normalizeERD(ratio: number): number {
  const points: [number, number][] = [
    [1.0, 0], [1.5, 30], [2.0, 55], [4.0, 85], [5.0, 100],
  ];
  return interpolate(points, ratio);
}

// Note: Hysteresis on level transitions (CP2 §3) is owned by the Activation
// component (src/core/activation.ts), not the RPM Engine. The RPM Engine
// produces the raw smoothed score; Activation decides when to change levels.

// --- Signal Collector (ring buffer) ---

const DEFAULT_CAPACITY = 10_000;
const WINDOW_MS = 60_000;       // 60-second sliding window
const UPDATE_INTERVAL_MS = 5_000;

// Cold start defaults
const COLD_START_LATENCY_BASELINE = 500;  // ms
const COLD_START_ERROR_BASELINE = 2;      // percent

// Auto-baseline warmup: after this many ms of data, compute baselines from observed traffic
const AUTO_BASELINE_WARMUP_MS = 30_000;   // 30 seconds
// Minimum samples required before auto-baseline is considered reliable
const AUTO_BASELINE_MIN_SAMPLES = 50;

// Phase boundaries (ms)
const PHASE_2_THRESHOLD = 2 * 60 * 60 * 1000;  // 2 hours
const PHASE_3_THRESHOLD = 24 * 60 * 60 * 1000;  // 24 hours

// Formula weights
const WEIGHT_RAR = 0.30;
const WEIGHT_RLP = 0.40;
const WEIGHT_ERD = 0.30;

// Smoothing weights
const SMOOTH_NOW = 0.50;
const SMOOTH_PREV = 0.30;
const SMOOTH_OLDEST = 0.20;

// Minimum samples for P95 calculation; below this, use max
const MIN_SAMPLES_FOR_P95 = 20;

class SignalCollector {
  private readonly buffer: RingBufferEntry[];
  private head = 0;
  private count = 0;
  private readonly capacity: number;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
    // Pre-allocate all slots to eliminate per-request heap allocation
    this.buffer = Array.from({ length: capacity }, () => ({
      timestamp: 0, responseTimeMs: 0, statusCode: 0, block: '', endpoint: '',
    }));
  }

  /** O(1) write — no allocation, writes fields in-place into pre-allocated slot */
  push(ts: number, rt: number, sc: number, block: string, endpoint: string): void {
    const slot = this.buffer[this.head % this.capacity];
    slot.timestamp = ts;
    slot.responseTimeMs = rt;
    slot.statusCode = sc;
    slot.block = block;
    slot.endpoint = endpoint;
    this.head++;
    if (this.count < this.capacity) this.count++;
  }

  /** Returns entries within window, partitioned by block in a single pass */
  getWindowPartitioned(sinceTimestamp: number): {
    all: RingBufferEntry[];
    byBlock: Map<string, RingBufferEntry[]>;
  } {
    const all: RingBufferEntry[] = [];
    const byBlock = new Map<string, RingBufferEntry[]>();
    const start = this.head - this.count;
    for (let i = start; i < this.head; i++) {
      const entry = this.buffer[i % this.capacity];
      if (entry.timestamp >= sinceTimestamp) {
        // Snapshot the entry so background calculations read stable values
        const snapshot: RingBufferEntry = {
          timestamp: entry.timestamp,
          responseTimeMs: entry.responseTimeMs,
          statusCode: entry.statusCode,
          block: entry.block,
          endpoint: entry.endpoint,
        };
        all.push(snapshot);
        if (snapshot.block) {
          let arr = byBlock.get(snapshot.block);
          if (!arr) { arr = []; byBlock.set(snapshot.block, arr); }
          arr.push(snapshot);
        }
      }
    }
    return { all, byBlock };
  }
}

// --- Default baseline config ---

const DEFAULT_BASELINE: BaselineConfig = {
  requestRateBaseline: 0,
  latencyP95Baseline: 0,
  errorRateBaseline: 0,
};

// --- RPM Engine ---

export class RPMEngine {
  private readonly collector: SignalCollector;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private state: Readonly<RPMState>;
  private history: [number, number, number] = [0, 0, 0];
  private readonly config: BaselineConfig;
  private readonly startTime: number;

  // Auto-baseline: learned from observed traffic during warmup
  private autoBaseline: { requestRate: number; latencyP95: number; errorRate: number } | null = null;
  private autoBaselineComputed = false;

  constructor(config?: Partial<BaselineConfig>) {
    this.config = { ...DEFAULT_BASELINE, ...config };
    this.collector = new SignalCollector();
    this.startTime = Date.now();

    const initial: RPMState = {
      global: 0,
      perBlock: {},
      updatedAt: Date.now(),
      phase: this.getPhase(),
    };
    this.state = Object.freeze(initial);
  }

  /** Begin the 5-second update interval. Idempotent. */
  start(): void {
    if (this.intervalId !== null) return;
    this.tick();
    this.intervalId = setInterval(() => this.tick(), UPDATE_INTERVAL_MS);
  }

  /** Stop the update interval. Safe to call if not running. */
  stop(): void {
    if (this.intervalId === null) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  /** Returns an immutable snapshot of the current RPM state. */
  getState(): Readonly<RPMState> {
    return this.state;
  }

  /** Record a request for signal collection. Hot path — must be <0.1ms, never throws. */
  recordRequest(params: RecordRequestParams): void {
    try {
      // Zero-allocation write: fields written in-place into pre-allocated ring buffer slot
      this.collector.push(
        Date.now(),
        params.responseTimeMs,
        params.statusCode,
        params.block,
        params.endpoint,
      );
    } catch {
      // swallow — never throw from hot path
    }
  }

  // --- Private methods ---

  private getPhase(): 1 | 2 | 3 {
    const elapsed = Date.now() - this.startTime;
    if (elapsed < PHASE_2_THRESHOLD) return 1;
    if (elapsed < PHASE_3_THRESHOLD) return 2;
    return 3;
  }

  private tick(): void {
    try {
      // Attempt auto-baseline calibration during warmup period
      if (!this.autoBaselineComputed) {
        this.tryComputeAutoBaseline();
      }
      const newState = this.calculate();
      this.state = Object.freeze(newState);
    } catch {
      // keep last known good state
    }
  }

  private calculate(): RPMState {
    const now = Date.now();
    const phase = this.getPhase();

    // Single-pass: get full window + per-block partitions simultaneously
    const { all: window, byBlock } = this.collector.getWindowPartitioned(now - WINDOW_MS);

    // Compute global RPM
    const globalRaw = this.computeRPMFromEntries(window, phase);

    // Apply smoothing
    this.history[0] = this.history[1];
    this.history[1] = this.history[2];
    this.history[2] = globalRaw;

    const globalSmoothed = Math.round(
      this.history[2] * SMOOTH_NOW +
      this.history[1] * SMOOTH_PREV +
      this.history[0] * SMOOTH_OLDEST
    );

    // Compute per-block RPM from pre-partitioned data (no extra scans)
    // Note: per-block scores are not smoothed individually — smoothing is applied
    // only to the global RPM. Per-block smoothing requires per-block history which
    // will be added when Shadow Mode provides per-block baselines.
    const perBlock: Record<string, number> = {};
    for (const [block, blockEntries] of byBlock) {
      const raw = Math.round(this.computeRPMFromEntries(blockEntries, phase));
      perBlock[block] = Math.max(0, Math.min(100, raw));
    }

    // Freeze perBlock to prevent mutation
    Object.freeze(perBlock);

    return {
      global: Math.max(0, Math.min(100, globalSmoothed)),
      perBlock,
      updatedAt: now,
      phase,
    };
  }

  /**
   * Auto-compute baselines from observed traffic after warmup period.
   * Called on each tick until baselines are established.
   */
  private tryComputeAutoBaseline(): void {
    const elapsed = Date.now() - this.startTime;
    if (elapsed < AUTO_BASELINE_WARMUP_MS) return;

    const now = Date.now();
    const { all: entries } = this.collector.getWindowPartitioned(now - WINDOW_MS);
    if (entries.length < AUTO_BASELINE_MIN_SAMPLES) return;

    // Compute request rate baseline (requests per minute)
    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const e of entries) {
      if (e.timestamp < minTs) minTs = e.timestamp;
      if (e.timestamp > maxTs) maxTs = e.timestamp;
    }
    const durationMs = maxTs - minTs;
    const requestRate = durationMs > 1000
      ? entries.length / (durationMs / 60_000)
      : entries.length * 12; // estimate from count if window too small

    // Compute P95 latency baseline
    const times = entries.map(e => e.responseTimeMs).sort((a, b) => a - b);
    const p95Idx = Math.ceil(0.95 * times.length) - 1;
    const latencyP95 = times[p95Idx];

    // Compute error rate baseline
    const errorCount = entries.filter(e => e.statusCode >= 400).length;
    const errorRate = (errorCount / entries.length) * 100;

    this.autoBaseline = {
      requestRate: Math.max(requestRate, 1),
      latencyP95: Math.max(latencyP95, 1),
      errorRate: Math.max(errorRate, 0.5), // minimum 0.5% to avoid zero-division amplification
    };
    this.autoBaselineComputed = true;
  }

  private computeRPMFromEntries(entries: RingBufferEntry[], phase: 1 | 2 | 3): number {
    if (entries.length === 0) return 0;

    const rarScore = this.computeRAR(entries, phase);
    const rlpScore = this.computeRLP(entries, phase);
    const erdScore = this.computeERD(entries, phase);

    return rarScore * WEIGHT_RAR + rlpScore * WEIGHT_RLP + erdScore * WEIGHT_ERD;
  }

  private computeRAR(entries: RingBufferEntry[], phase: 1 | 2 | 3): number {
    // Use external baseline, or auto-learned baseline, or skip if neither available
    let baseline = this.config.requestRateBaseline;
    if (baseline <= 0 && this.autoBaseline) {
      baseline = this.autoBaseline.requestRate;
    }
    if (baseline <= 0) return 0;

    // Calculate current request rate (requests per minute)
    // Single-pass min/max — no intermediate array or spread allocation
    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const e of entries) {
      if (e.timestamp < minTs) minTs = e.timestamp;
      if (e.timestamp > maxTs) maxTs = e.timestamp;
    }
    const durationMs = maxTs - minTs;

    // Need at least some time span to calculate a rate
    if (durationMs < 1000) {
      // If all entries are within 1 second, estimate from count
      // Assume the window represents ~5 seconds of data
      const estimatedRate = (entries.length / 5) * 60;
      const ratio = estimatedRate / baseline;
      return normalizeRAR(ratio);
    }

    const durationMinutes = durationMs / 60_000;
    const currentRate = entries.length / durationMinutes;
    const ratio = currentRate / baseline;

    return normalizeRAR(ratio);
  }

  private computeRLP(entries: RingBufferEntry[], phase: 1 | 2 | 3): number {
    // Get effective baseline: external config → auto-learned → cold start default
    let baseline = this.config.latencyP95Baseline;
    if (baseline <= 0 && this.autoBaseline) {
      baseline = this.autoBaseline.latencyP95;
    }
    if (baseline <= 0) {
      baseline = COLD_START_LATENCY_BASELINE;
    }

    const times = entries.map(e => e.responseTimeMs).sort((a, b) => a - b);
    let p95: number;

    if (times.length < MIN_SAMPLES_FOR_P95) {
      // Conservative: use max value
      p95 = times[times.length - 1];
    } else {
      const idx = Math.ceil(0.95 * times.length) - 1;
      p95 = times[idx];
    }

    const ratio = p95 / baseline;
    return normalizeRLP(ratio);
  }

  private computeERD(entries: RingBufferEntry[], phase: 1 | 2 | 3): number {
    // Get effective baseline: phase 1 uses cold start default
    let baseline = this.config.errorRateBaseline;
    if (phase === 1 || baseline <= 0) {
      baseline = COLD_START_ERROR_BASELINE;
    }

    const errorCount = entries.filter(e => e.statusCode >= 400).length;
    const errorRate = (errorCount / entries.length) * 100;
    const ratio = errorRate / baseline;

    return normalizeERD(ratio);
  }
}

export default RPMEngine;
