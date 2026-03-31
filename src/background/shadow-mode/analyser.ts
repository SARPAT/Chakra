// Shadow Mode Analyser — Pattern analysis jobs
//
// Processes raw observations from the SQLite store and produces:
//   - Endpoint inventory (Layer 1 — hours)
//   - Traffic patterns + RPM baselines (Layer 2 — days)
//   - Moment of Value session signatures (Layer 3 — weeks)
//   - Failure signatures (Layer 4 — requires stress event)
//
// Runs on a schedule: hourly jobs and daily jobs.
// Never touches the request path. Pure analysis.

import type { ShadowModeObserver, ObservationRecord } from './observer';
import { logger } from '../../utils/logger';

// ─── Learning layer state ─────────────────────────────────────────────────────

export type LayerStatus = 'waiting' | 'in_progress' | 'complete';

export interface LearningProgress {
  layer1AppStructure: LayerStatus;
  layer2TrafficPatterns: LayerStatus;
  layer3UserBehaviour: LayerStatus;
  layer4FailureSignatures: LayerStatus;
  /** Total unique requests observed */
  totalObservations: number;
  /** Days of traffic observed (approximate) */
  daysObserved: number;
  /** Number of completed conversion journeys detected */
  conversionJourneysObserved: number;
  /** Whether a stress event (RPM spike) has been observed */
  stressEventObserved: boolean;
}

// ─── Analysis outputs ─────────────────────────────────────────────────────────

export interface EndpointStats {
  endpoint: string;
  callCount: number;
  avgResponseTimeMs: number;
  p95ResponseTimeMs: number;
  errorRate: number;           // 0.0–1.0
  isWriteHeavy: boolean;       // majority of calls are POST/PUT/DELETE
  isAuthenticated: boolean;    // majority of calls require auth
  deviceClasses: Record<string, number>;
}

export interface BlockSuggestion {
  blockName: string;
  endpoints: string[];
  suggestedMinLevel: number;   // 0–3 (higher = suspended first)
  suggestedWeightBase: number; // 0–100
  reason: string;
}

export interface TrafficPattern {
  /** Hour of day (0–23) → average call rate (relative, 0–100) */
  hourlyDistribution: number[];
  /** Day of week (0=Sun…6=Sat) → average call rate (relative, 0–100) */
  dailyDistribution: number[];
  /** Observed baseline RPM (requests per 5-second window) */
  baselineRpm: number;
  /** Peak RPM observed */
  peakRpm: number;
  /** Suggested activation threshold (RPM) */
  suggestedActivationThreshold: number;
}

export interface MomentOfValueSignature {
  id: string;
  name: string;
  /** Ordered endpoint sequence that precedes a conversion */
  endpointSequence: string[];
  /** Confidence score 0–1 */
  confidence: number;
  /** How many times this sequence was observed leading to conversion */
  observedCount: number;
}

// ─── Thresholds for layer graduation ─────────────────────────────────────────

const LAYER1_MIN_OBSERVATIONS = 500;
const LAYER2_MIN_DAYS = 7;
const LAYER3_MIN_CONVERSIONS = 50;
const STRESS_EVENT_RPM_SPIKE_FACTOR = 1.5;    // 50% above baseline = stress
const STRESS_EVENT_MIN_ERROR_RATE = 0.05;     // 5% error rate during spike

// ─── ShadowModeAnalyser ───────────────────────────────────────────────────────

export class ShadowModeAnalyser {
  private readonly observer: ShadowModeObserver;

  // Computed outputs
  private endpointStats: Map<string, EndpointStats> = new Map();
  private blockSuggestions: BlockSuggestion[] = [];
  private trafficPattern: TrafficPattern | null = null;
  private momentOfValueSignatures: MomentOfValueSignature[] = [];
  private learningProgress: LearningProgress = {
    layer1AppStructure: 'waiting',
    layer2TrafficPatterns: 'waiting',
    layer3UserBehaviour: 'waiting',
    layer4FailureSignatures: 'waiting',
    totalObservations: 0,
    daysObserved: 0,
    conversionJourneysObserved: 0,
    stressEventObserved: false,
  };

  private hourlyInterval: ReturnType<typeof setInterval> | null = null;
  private dailyInterval: ReturnType<typeof setInterval> | null = null;

  constructor(observer: ShadowModeObserver) {
    this.observer = observer;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  start(hourlyIntervalMs = 60 * 60 * 1_000, dailyIntervalMs = 24 * 60 * 60 * 1_000): void {
    if (this.hourlyInterval !== null) return;   // idempotent

    // Run once immediately, then on schedule
    try { this.runHourlyJobs(); } catch { /* never propagate */ }

    this.hourlyInterval = setInterval(() => {
      try { this.runHourlyJobs(); } catch { /* never propagate */ }
    }, hourlyIntervalMs);

    this.dailyInterval = setInterval(() => {
      try { this.runDailyJobs(); } catch { /* never propagate */ }
    }, dailyIntervalMs);

    if (typeof this.hourlyInterval.unref === 'function') {
      this.hourlyInterval.unref();
    }
    if (typeof this.dailyInterval.unref === 'function') {
      this.dailyInterval.unref();
    }
  }

  stop(): void {
    if (this.hourlyInterval !== null) {
      clearInterval(this.hourlyInterval);
      this.hourlyInterval = null;
    }
    if (this.dailyInterval !== null) {
      clearInterval(this.dailyInterval);
      this.dailyInterval = null;
    }
  }

  // ─── Outputs ──────────────────────────────────────────────────────────────────

  getLearningProgress(): LearningProgress {
    return { ...this.learningProgress };
  }

  getEndpointStats(): EndpointStats[] {
    return Array.from(this.endpointStats.values());
  }

  getBlockSuggestions(): BlockSuggestion[] {
    return [...this.blockSuggestions];
  }

  getTrafficPattern(): TrafficPattern | null {
    return this.trafficPattern ? { ...this.trafficPattern } : null;
  }

  getMomentOfValueSignatures(): MomentOfValueSignature[] {
    return [...this.momentOfValueSignatures];
  }

  // ─── Hourly jobs ──────────────────────────────────────────────────────────────

  runHourlyJobs(): void {
    const observations = this.observer.getRecentObservations(50_000);
    if (observations.length === 0) return;

    this.updateEndpointStats(observations);
    this.updateLearningProgress(observations);
    this.detectStressEvents(observations);
  }

  // ─── Daily jobs ───────────────────────────────────────────────────────────────

  runDailyJobs(): void {
    const observations = this.observer.getRecentObservations(500_000);
    if (observations.length === 0) return;

    this.computeTrafficPatterns(observations);
    this.clusterEndpointsIntoBlocks();
    this.detectMomentOfValueSignatures(observations);
  }

  // ─── Endpoint stats ───────────────────────────────────────────────────────────

  private updateEndpointStats(observations: ObservationRecord[]): void {
    const groups = new Map<string, ObservationRecord[]>();

    for (const obs of observations) {
      const list = groups.get(obs.endpoint) ?? [];
      list.push(obs);
      groups.set(obs.endpoint, list);
    }

    for (const [endpoint, records] of groups) {
      const responseTimes = records.map(r => r.responseTimeMs).sort((a, b) => a - b);
      const errorCount = records.filter(r => r.statusCode >= 500).length;
      const writeMethods = records.filter(r => ['POST', 'PUT', 'DELETE', 'PATCH'].includes(r.method));
      const authCount = records.filter(r => r.isAuthenticated).length;

      const deviceClasses: Record<string, number> = {};
      for (const r of records) {
        deviceClasses[r.deviceClass] = (deviceClasses[r.deviceClass] ?? 0) + 1;
      }

      this.endpointStats.set(endpoint, {
        endpoint,
        callCount: records.length,
        avgResponseTimeMs: Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length),
        p95ResponseTimeMs: responseTimes[Math.floor(responseTimes.length * 0.95)] ?? 0,
        errorRate: errorCount / records.length,
        isWriteHeavy: writeMethods.length > records.length * 0.5,
        isAuthenticated: authCount > records.length * 0.5,
        deviceClasses,
      });
    }
  }

  // ─── Traffic patterns ─────────────────────────────────────────────────────────

  private computeTrafficPatterns(observations: ObservationRecord[]): void {
    if (observations.length < 100) return;

    const hourBuckets = new Array<number>(24).fill(0);
    const dayBuckets = new Array<number>(7).fill(0);

    for (const obs of observations) {
      const d = new Date(obs.timestamp);
      hourBuckets[d.getHours()]++;
      dayBuckets[d.getDay()]++;
    }

    const maxHour = Math.max(...hourBuckets) || 1;
    const maxDay = Math.max(...dayBuckets) || 1;

    // Compute per-5-second windows for baseline RPM
    const windowMs = 5_000;
    const windowCounts = new Map<number, number>();
    for (const obs of observations) {
      const w = Math.floor(obs.timestamp / windowMs);
      windowCounts.set(w, (windowCounts.get(w) ?? 0) + 1);
    }
    const windowValues = Array.from(windowCounts.values()).sort((a, b) => a - b);
    const baselineRpm = windowValues[Math.floor(windowValues.length * 0.5)] ?? 0;
    const peakRpm = windowValues[windowValues.length - 1] ?? 0;

    // Check how many days of data we have
    const oldest = observations[observations.length - 1]?.timestamp ?? Date.now();
    const daysObserved = Math.ceil((Date.now() - oldest) / (24 * 60 * 60 * 1_000));

    this.trafficPattern = {
      hourlyDistribution: hourBuckets.map(v => Math.round((v / maxHour) * 100)),
      dailyDistribution: dayBuckets.map(v => Math.round((v / maxDay) * 100)),
      baselineRpm,
      peakRpm,
      suggestedActivationThreshold: Math.round(baselineRpm * 1.5),
    };

    // Update learning progress
    this.learningProgress.daysObserved = daysObserved;
    if (
      daysObserved >= LAYER2_MIN_DAYS &&
      this.learningProgress.layer1AppStructure === 'complete'
    ) {
      this.learningProgress.layer2TrafficPatterns = 'complete';
      logger.info('Shadow Mode: Layer 2 (Traffic Patterns) complete');
    } else if (this.learningProgress.layer2TrafficPatterns === 'waiting') {
      this.learningProgress.layer2TrafficPatterns = 'in_progress';
    }
  }

  // ─── Block clustering ─────────────────────────────────────────────────────────

  private clusterEndpointsIntoBlocks(): void {
    if (this.endpointStats.size === 0) return;

    const suggestions: BlockSuggestion[] = [];
    const endpoints = Array.from(this.endpointStats.values());

    // Simple path-prefix grouping: group by first two path segments
    const prefixGroups = new Map<string, EndpointStats[]>();
    for (const stat of endpoints) {
      const parts = stat.endpoint.split('/').filter(Boolean);
      const prefix = parts.slice(0, 2).join('/') || 'root';
      const group = prefixGroups.get(prefix) ?? [];
      group.push(stat);
      prefixGroups.set(prefix, group);
    }

    for (const [prefix, group] of prefixGroups) {
      const totalCalls = group.reduce((s, e) => s + e.callCount, 0);
      const avgErrorRate = group.reduce((s, e) => s + e.errorRate, 0) / group.length;
      const isWriteHeavy = group.filter(e => e.isWriteHeavy).length > group.length * 0.5;
      const avgResponseTime = group.reduce((s, e) => s + e.avgResponseTimeMs, 0) / group.length;

      // minLevel: write-heavy or high call frequency → inner (level 1 or 2)
      //           read-only + low frequency → outer (level 3)
      let minLevel: number;
      let weightBase: number;
      let reason: string;

      if (isWriteHeavy || totalCalls > 1000) {
        minLevel = 1;
        weightBase = 70;
        reason = 'High-frequency or write-heavy endpoints — protect first';
      } else if (avgResponseTime < 100 && !isWriteHeavy) {
        minLevel = 3;
        weightBase = 30;
        reason = 'Fast read-only endpoints — suspend first under load';
      } else {
        minLevel = 2;
        weightBase = 50;
        reason = 'Mixed-use endpoints — mid-priority';
      }

      if (avgErrorRate > 0.1) {
        minLevel = Math.max(minLevel - 1, 0) as 0 | 1 | 2 | 3;
        reason += ' (error-prone — moved to inner ring for protection)';
      }

      suggestions.push({
        blockName: `${prefix.replace('/', '-')}-block`,
        endpoints: group.map(e => e.endpoint),
        suggestedMinLevel: minLevel,
        suggestedWeightBase: weightBase,
        reason,
      });
    }

    this.blockSuggestions = suggestions;
  }

  // ─── Moment of Value detection ────────────────────────────────────────────────

  private detectMomentOfValueSignatures(observations: ObservationRecord[]): void {
    // Group observations by session
    const sessions = new Map<string, ObservationRecord[]>();
    for (const obs of observations) {
      if (!obs.sessionId) continue;
      const list = sessions.get(obs.sessionId) ?? [];
      list.push(obs);
      sessions.set(obs.sessionId, list);
    }

    // Identify "conversion" sessions: sessions ending with a POST to
    // a payment/checkout/confirm/order endpoint
    const conversionKeywords = /payment|checkout|confirm|order|purchase|buy/i;
    const conversionSessions: ObservationRecord[][] = [];

    for (const sessionObs of sessions.values()) {
      const sorted = sessionObs.sort((a, b) => a.timestamp - b.timestamp);
      const lastObs = sorted[sorted.length - 1];
      if (
        lastObs &&
        ['POST', 'PUT'].includes(lastObs.method) &&
        conversionKeywords.test(lastObs.endpoint)
      ) {
        conversionSessions.push(sorted);
      }
    }

    this.learningProgress.conversionJourneysObserved = conversionSessions.length;

    if (conversionSessions.length < LAYER3_MIN_CONVERSIONS) {
      if (this.learningProgress.layer3UserBehaviour === 'waiting') {
        this.learningProgress.layer3UserBehaviour = 'in_progress';
      }
      return;
    }

    // Find common prefix sequences in conversion sessions
    const sequenceCounts = new Map<string, number>();
    for (const session of conversionSessions) {
      const endpoints = session.map(o => o.endpoint);
      // Use sliding window of 3–5 endpoints as a "signature fragment"
      for (let len = 3; len <= Math.min(5, endpoints.length); len++) {
        for (let i = 0; i <= endpoints.length - len; i++) {
          const key = endpoints.slice(i, i + len).join(' → ');
          sequenceCounts.set(key, (sequenceCounts.get(key) ?? 0) + 1);
        }
      }
    }

    // Keep sequences that appear in at least 20% of conversion sessions
    const minCount = Math.max(3, Math.floor(conversionSessions.length * 0.2));
    const signatures: MomentOfValueSignature[] = [];
    let sigIndex = 0;

    for (const [key, count] of sequenceCounts) {
      if (count < minCount) continue;
      signatures.push({
        id: `mov-${sigIndex++}`,
        name: `Conversion pattern ${sigIndex}`,
        endpointSequence: key.split(' → '),
        confidence: Math.min(count / conversionSessions.length, 1),
        observedCount: count,
      });
    }

    // Keep top 5 most-observed signatures
    this.momentOfValueSignatures = signatures
      .sort((a, b) => b.observedCount - a.observedCount)
      .slice(0, 5);

    this.learningProgress.layer3UserBehaviour = 'complete';
    logger.info(`Shadow Mode: Layer 3 complete. ${this.momentOfValueSignatures.length} MoV signatures identified.`);
  }

  // ─── Stress event detection ───────────────────────────────────────────────────

  private detectStressEvents(observations: ObservationRecord[]): void {
    if (this.trafficPattern === null || observations.length < 100) return;
    if (this.learningProgress.stressEventObserved) return;

    const baseline = this.trafficPattern.baselineRpm;
    if (baseline === 0) return;

    // Look at recent 5-minute windows for RPM spikes + elevated error rates
    const windowMs = 5_000;
    const recentCutoff = Date.now() - 5 * 60 * 1_000;
    const recent = observations.filter(o => o.timestamp > recentCutoff);

    const windowCounts = new Map<number, { total: number; errors: number }>();
    for (const obs of recent) {
      const w = Math.floor(obs.timestamp / windowMs);
      const entry = windowCounts.get(w) ?? { total: 0, errors: 0 };
      entry.total++;
      if (obs.statusCode >= 500) entry.errors++;
      windowCounts.set(w, entry);
    }

    for (const { total, errors } of windowCounts.values()) {
      const errorRate = errors / total;
      if (total > baseline * STRESS_EVENT_RPM_SPIKE_FACTOR && errorRate > STRESS_EVENT_MIN_ERROR_RATE) {
        this.learningProgress.stressEventObserved = true;
        this.learningProgress.layer4FailureSignatures = 'complete';
        logger.info('Shadow Mode: Layer 4 stress event detected. Failure signature captured.');
        break;
      }
    }
  }

  // ─── Learning progress tracking ───────────────────────────────────────────────

  private updateLearningProgress(observations: ObservationRecord[]): void {
    this.learningProgress.totalObservations = observations.length;

    if (
      observations.length >= LAYER1_MIN_OBSERVATIONS &&
      this.learningProgress.layer1AppStructure !== 'complete'
    ) {
      this.learningProgress.layer1AppStructure = 'complete';
      logger.info('Shadow Mode: Layer 1 (App Structure) complete');
    } else if (
      observations.length > 0 &&
      this.learningProgress.layer1AppStructure === 'waiting'
    ) {
      this.learningProgress.layer1AppStructure = 'in_progress';
    }
  }
}
