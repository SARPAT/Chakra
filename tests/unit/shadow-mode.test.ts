// Shadow Mode unit tests — Observer, Analyser, Suggester
//
// Observer SQLite tests use a temp file. Analyser and Suggester are tested
// with in-memory data to avoid needing a real DB.

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { normalizeEndpoint, classifyDevice, ShadowModeObserver } from '../../src/background/shadow-mode/observer';
import { ShadowModeAnalyser } from '../../src/background/shadow-mode/analyser';
import { ShadowModeSuggester } from '../../src/background/shadow-mode/suggester';
import { sha256, hashId } from '../../src/utils/hasher';

// ─── Hasher ───────────────────────────────────────────────────────────────────

describe('sha256 / hashId', () => {
  it('produces 64-character hex string', () => {
    expect(sha256('hello')).toHaveLength(64);
    expect(sha256('hello')).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic', () => {
    expect(sha256('test')).toBe(sha256('test'));
  });

  it('different inputs produce different hashes', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });

  it('hashId returns null for null/undefined/empty', () => {
    expect(hashId(null)).toBeNull();
    expect(hashId(undefined)).toBeNull();
    expect(hashId('')).toBeNull();
  });

  it('hashId returns hashed string for non-empty value', () => {
    const result = hashId('user-123');
    expect(result).toHaveLength(64);
    expect(result).not.toBe('user-123');
  });
});

// ─── normalizeEndpoint ────────────────────────────────────────────────────────

describe('normalizeEndpoint', () => {
  it('strips query string', () => {
    expect(normalizeEndpoint('/api/users?page=1')).toBe('/api/users');
  });

  it('replaces numeric IDs', () => {
    expect(normalizeEndpoint('/api/users/42')).toBe('/api/users/:id');
  });

  it('replaces long numeric snowflake IDs', () => {
    expect(normalizeEndpoint('/api/items/1234567890')).toBe('/api/items/:id');
  });

  it('replaces UUID paths', () => {
    const result = normalizeEndpoint('/api/orders/550e8400-e29b-41d4-a716-446655440000');
    expect(result).toBe('/api/orders/:uuid');
  });

  it('replaces MongoDB ObjectIds', () => {
    expect(normalizeEndpoint('/api/posts/507f1f77bcf86cd799439011')).toBe('/api/posts/:objectid');
  });

  it('leaves non-parametric paths unchanged', () => {
    expect(normalizeEndpoint('/api/health')).toBe('/api/health');
  });

  it('handles root path', () => {
    expect(normalizeEndpoint('/')).toBe('/');
  });
});

// ─── classifyDevice ───────────────────────────────────────────────────────────

describe('classifyDevice', () => {
  it('returns unknown for missing user agent', () => {
    expect(classifyDevice(undefined)).toBe('unknown');
    expect(classifyDevice('')).toBe('unknown');
  });

  it('detects bots', () => {
    expect(classifyDevice('Googlebot/2.1')).toBe('bot');
    expect(classifyDevice('Mozilla/5.0 (compatible; spider)')).toBe('bot');
  });

  it('detects mobile', () => {
    expect(classifyDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 14)')).toBe('mobile');
    expect(classifyDevice('Android/8.1 Mobile')).toBe('mobile');
  });

  it('detects desktop', () => {
    expect(classifyDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('desktop');
    expect(classifyDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe('desktop');
  });
});

// ─── ShadowModeObserver ───────────────────────────────────────────────────────

describe('ShadowModeObserver', () => {
  let dbPath: string;
  let observer: ShadowModeObserver;

  afterEach(() => {
    observer?.stop();
    if (dbPath && fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    }
  });

  function makeObserver(): ShadowModeObserver {
    const dir = os.tmpdir();
    const file = `chakra-test-${Date.now()}.db`;
    dbPath = path.join(dir, file);
    return new ShadowModeObserver({ dbDir: dir, dbFile: file, purgeIntervalMs: 999999 });
  }

  it('initialises and reports isActive()', () => {
    observer = makeObserver();
    expect(observer.isActive()).toBe(true);
  });

  it('observe() stores a record asynchronously', async () => {
    observer = makeObserver();
    observer.observe(
      { method: 'GET', path: '/api/products', isAuthenticated: false },
      { statusCode: 200, responseTimeMs: 42 },
    );
    // Wait for setImmediate to flush
    await new Promise(r => setImmediate(r));
    expect(observer.getObservationCount()).toBe(1);
  });

  it('observe() normalises the endpoint', async () => {
    observer = makeObserver();
    observer.observe(
      { method: 'GET', path: '/api/users/123', isAuthenticated: true },
      { statusCode: 200, responseTimeMs: 10 },
    );
    await new Promise(r => setImmediate(r));
    const records = observer.getRecentObservations(1);
    expect(records[0]?.endpoint).toBe('/api/users/:id');
    expect(records[0]?.rawEndpoint).toBe('/api/users/123');
  });

  it('observe() hashes the session token', async () => {
    observer = makeObserver();
    observer.observe(
      { method: 'POST', path: '/api/cart', sessionToken: 'raw-token-abc', isAuthenticated: true },
      { statusCode: 201, responseTimeMs: 30 },
    );
    await new Promise(r => setImmediate(r));
    const records = observer.getRecentObservations(1);
    expect(records[0]?.sessionId).not.toBe('raw-token-abc');
    expect(records[0]?.sessionId).toHaveLength(64);
  });

  it('getObservationCount() returns 0 before any observations', () => {
    observer = makeObserver();
    expect(observer.getObservationCount()).toBe(0);
  });

  it('stop() closes DB cleanly', () => {
    observer = makeObserver();
    expect(() => observer.stop()).not.toThrow();
    expect(observer.isActive()).toBe(false);
  });

  it('observe() is a no-op after stop()', async () => {
    observer = makeObserver();
    observer.stop();
    observer.observe(
      { method: 'GET', path: '/api/test' },
      { statusCode: 200, responseTimeMs: 5 },
    );
    await new Promise(r => setImmediate(r));
    // Should not throw; count stays 0 (DB was closed)
    expect(observer.getObservationCount()).toBe(0);
  });
});

// ─── ShadowModeAnalyser (unit — no real DB needed) ────────────────────────────

describe('ShadowModeAnalyser', () => {
  function makeMockObserver(records: ReturnType<ShadowModeObserver['getRecentObservations']>) {
    return {
      getRecentObservations: vi.fn().mockReturnValue(records),
      getObservationCount: vi.fn().mockReturnValue(records.length),
      isActive: vi.fn().mockReturnValue(true),
      observe: vi.fn(),
      stop: vi.fn(),
    } as unknown as ShadowModeObserver;
  }

  it('getLearningProgress() returns waiting state with no data', () => {
    const analyser = new ShadowModeAnalyser(makeMockObserver([]));
    const progress = analyser.getLearningProgress();
    expect(progress.layer1AppStructure).toBe('waiting');
    expect(progress.totalObservations).toBe(0);
  });

  it('layer1 graduates to in_progress after first observations', () => {
    const obs = Array.from({ length: 10 }, (_, i) => ({
      timestamp: Date.now() - i * 1000,
      sessionId: null, userId: null,
      method: 'GET', endpoint: '/api/products', rawEndpoint: '/api/products',
      responseTimeMs: 50, statusCode: 200,
      requestSize: 0, responseSize: 100,
      deviceClass: 'desktop', isAuthenticated: false, sessionDepth: 1,
    }));
    const analyser = new ShadowModeAnalyser(makeMockObserver(obs));
    analyser.runHourlyJobs();
    expect(analyser.getLearningProgress().layer1AppStructure).toBe('in_progress');
  });

  it('layer1 completes when 500+ observations seen', () => {
    const obs = Array.from({ length: 600 }, (_, i) => ({
      timestamp: Date.now() - i * 1000,
      sessionId: null, userId: null,
      method: 'GET', endpoint: `/api/ep${i % 10}`, rawEndpoint: `/api/ep${i % 10}`,
      responseTimeMs: 50, statusCode: 200,
      requestSize: 0, responseSize: 100,
      deviceClass: 'desktop', isAuthenticated: false, sessionDepth: 1,
    }));
    const analyser = new ShadowModeAnalyser(makeMockObserver(obs));
    analyser.runHourlyJobs();
    expect(analyser.getLearningProgress().layer1AppStructure).toBe('complete');
  });

  it('getEndpointStats() returns stats per endpoint', () => {
    const obs = Array.from({ length: 20 }, (_, i) => ({
      timestamp: Date.now() - i * 1000,
      sessionId: null, userId: null,
      method: i % 2 === 0 ? 'GET' : 'POST',
      endpoint: '/api/products', rawEndpoint: '/api/products',
      responseTimeMs: 100 + i, statusCode: i === 5 ? 500 : 200,
      requestSize: 0, responseSize: 100,
      deviceClass: 'desktop', isAuthenticated: false, sessionDepth: 1,
    }));
    const analyser = new ShadowModeAnalyser(makeMockObserver(obs));
    analyser.runHourlyJobs();
    const stats = analyser.getEndpointStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]?.callCount).toBe(20);
    expect(stats[0]?.errorRate).toBe(0.05);
  });

  it('start() and stop() run without error', () => {
    const analyser = new ShadowModeAnalyser(makeMockObserver([]));
    expect(() => {
      analyser.start(999999, 999999);
      analyser.stop();
    }).not.toThrow();
  });
});

// ─── ShadowModeSuggester ──────────────────────────────────────────────────────

describe('ShadowModeSuggester', () => {
  function makeMockAnalyser() {
    return {
      getLearningProgress: vi.fn().mockReturnValue({
        layer1AppStructure: 'waiting',
        layer2TrafficPatterns: 'waiting',
        layer3UserBehaviour: 'waiting',
        layer4FailureSignatures: 'waiting',
        totalObservations: 0,
        daysObserved: 0,
        conversionJourneysObserved: 0,
        stressEventObserved: false,
      }),
      getEndpointStats: vi.fn().mockReturnValue([]),
      getBlockSuggestions: vi.fn().mockReturnValue([]),
      getTrafficPattern: vi.fn().mockReturnValue(null),
      getMomentOfValueSignatures: vi.fn().mockReturnValue([]),
    } as unknown as ShadowModeAnalyser;
  }

  it('getSuggestions() returns not-ready suggestions when no data', () => {
    const analyser = makeMockAnalyser();
    const suggester = new ShadowModeSuggester(analyser);
    const suggestions = suggester.getSuggestions();
    expect(suggestions.ringMap.ready).toBe(false);
    expect(suggestions.rpmThresholds.ready).toBe(false);
    expect(suggestions.policies).toHaveLength(0);
  });

  it('getRingMapSuggestion() returns ready=true when layer1 complete and blocks exist', () => {
    const analyser = makeMockAnalyser();
    vi.spyOn(analyser, 'getLearningProgress').mockReturnValue({
      layer1AppStructure: 'complete',
      layer2TrafficPatterns: 'waiting',
      layer3UserBehaviour: 'waiting',
      layer4FailureSignatures: 'waiting',
      totalObservations: 600,
      daysObserved: 1,
      conversionJourneysObserved: 0,
      stressEventObserved: false,
    });
    vi.spyOn(analyser, 'getBlockSuggestions').mockReturnValue([
      { blockName: 'products-block', endpoints: ['/api/products'], suggestedMinLevel: 3, suggestedWeightBase: 30, reason: 'test' },
    ]);
    const suggester = new ShadowModeSuggester(analyser);
    const ringMap = suggester.getRingMapSuggestion();
    expect(ringMap.ready).toBe(true);
    expect(ringMap.blocks).toHaveLength(1);
  });

  it('getRPMThresholdSuggestion() returns ready=true when layer2 complete', () => {
    const analyser = makeMockAnalyser();
    vi.spyOn(analyser, 'getLearningProgress').mockReturnValue({
      layer1AppStructure: 'complete',
      layer2TrafficPatterns: 'complete',
      layer3UserBehaviour: 'waiting',
      layer4FailureSignatures: 'waiting',
      totalObservations: 1000,
      daysObserved: 8,
      conversionJourneysObserved: 0,
      stressEventObserved: false,
    });
    vi.spyOn(analyser, 'getTrafficPattern').mockReturnValue({
      hourlyDistribution: new Array(24).fill(50),
      dailyDistribution: new Array(7).fill(50),
      baselineRpm: 20,
      peakRpm: 60,
      suggestedActivationThreshold: 30,
    });
    const suggester = new ShadowModeSuggester(analyser);
    const thresholds = suggester.getRPMThresholdSuggestion();
    expect(thresholds.ready).toBe(true);
    expect(thresholds.activateLevel1At).toBe(30);  // 20 * 1.5
    expect(thresholds.activateLevel2At).toBe(40);  // 20 * 2.0
    expect(thresholds.activateLevel3At).toBe(50);  // 20 * 2.5
  });

  it('getSuggestions() generatedAt is a valid ISO string', () => {
    const analyser = makeMockAnalyser();
    const suggester = new ShadowModeSuggester(analyser);
    const suggestions = suggester.getSuggestions();
    expect(() => new Date(suggestions.ringMap.generatedAt)).not.toThrow();
    expect(new Date(suggestions.ringMap.generatedAt).getTime()).toBeGreaterThan(0);
  });
});
