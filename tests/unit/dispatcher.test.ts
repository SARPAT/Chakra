import { describe, it, expect, vi } from 'vitest';
import { Dispatcher } from '../../src/core/dispatcher';
import type {
  WeightProvider, PolicyProvider, SessionProvider, DispatcherConfig,
} from '../../src/core/dispatcher';
import type { RouteInfo, SessionContext, DispatchOutcome, BlockState, SuspendedBlockConfig } from '../../src/types';

// --- Mock factories ---

function createMockRingMapper(overrides: Record<string, unknown> = {}) {
  return {
    lookup: vi.fn<(m: string, p: string) => RouteInfo>().mockReturnValue({
      block: 'test-block', minLevel: 1, weightBase: 50,
    }),
    getBlockState: vi.fn<(b: string, l: number) => BlockState>().mockReturnValue({
      block: 'test-block', currentLevel: 0, isActive: true, isSuspended: false,
    }),
    getSuspendedBlockConfig: vi.fn<(b: string) => SuspendedBlockConfig | undefined>().mockReturnValue(undefined),
    ...overrides,
  } as unknown as DispatcherConfig['ringMapper'];
}

function createMockWeightProvider(weight: number): WeightProvider {
  return { calculateWeight: vi.fn().mockReturnValue(weight) };
}

function createMockPolicyProvider(outcome: DispatchOutcome | null): PolicyProvider {
  return { evaluate: vi.fn().mockReturnValue(outcome) };
}

function createMockSessionProvider(session: SessionContext | null): SessionProvider {
  return { getSession: vi.fn().mockReturnValue(session) };
}

const mockSession: SessionContext = {
  callCount: 5,
  hasCartItems: true,
  cartItemCount: 2,
  matchesMomentOfValue: false,
  momentOfValueStrength: 'none',
  recentEndpoints: [],
  userTier: 'premium',
  sessionAgeSeconds: 300,
  lastSeenTime: Date.now(),
};

function createActiveDispatcher(config: Partial<DispatcherConfig> = {}) {
  const ringMapper = config.ringMapper ?? createMockRingMapper();
  const d = new Dispatcher({ ringMapper, ...config });
  d.setActivationState({ active: true, currentLevel: 2 });
  return d;
}

function createSuspendedBlockMapper(overrides: Record<string, unknown> = {}) {
  return createMockRingMapper({
    getBlockState: vi.fn().mockReturnValue({
      block: 'test-block', currentLevel: 2, isActive: false, isSuspended: true,
    }),
    ...overrides,
  });
}

// --- Tests ---

describe('Dispatcher', () => {
  // ─── Pass-through when sleeping ───────────────────────────────

  describe('sleeping (not active)', () => {
    it('returns SERVE_FULLY when not active', () => {
      const d = new Dispatcher({ ringMapper: createMockRingMapper() });
      const result = d.dispatch('GET', '/api/products');
      expect(result.type).toBe('SERVE_FULLY');
    });

    it('does not call ringMapper.lookup when sleeping', () => {
      const rm = createMockRingMapper();
      const d = new Dispatcher({ ringMapper: rm });
      d.dispatch('GET', '/api/products');
      expect((rm as any).lookup).not.toHaveBeenCalled();
    });

    it('returns the same frozen SERVE_FULLY reference for each sleeping call', () => {
      const d = new Dispatcher({ ringMapper: createMockRingMapper() });
      const r1 = d.dispatch('GET', '/a');
      const r2 = d.dispatch('POST', '/b');
      expect(r1).toBe(r2);
      expect(Object.isFrozen(r1)).toBe(true);
    });

    it('still increments totalRequests when sleeping', () => {
      const d = new Dispatcher({ ringMapper: createMockRingMapper() });
      d.dispatch('GET', '/a');
      d.dispatch('GET', '/b');
      expect(d.getMetrics().totalRequests).toBe(2);
    });
  });

  // ─── Active — block is active ─────────────────────────────────

  describe('active — block is active', () => {
    it('returns SERVE_FULLY when block is active', () => {
      const d = createActiveDispatcher();
      expect(d.dispatch('GET', '/api/products').type).toBe('SERVE_FULLY');
    });

    it('calls ringMapper.lookup with method and path', () => {
      const rm = createMockRingMapper();
      const d = createActiveDispatcher({ ringMapper: rm });
      d.dispatch('POST', '/api/cart');
      expect((rm as any).lookup).toHaveBeenCalledWith('POST', '/api/cart');
    });

    it('calls getBlockState with block name and current level', () => {
      const rm = createMockRingMapper();
      const d = createActiveDispatcher({ ringMapper: rm });
      d.dispatch('GET', '/api/products');
      expect((rm as any).getBlockState).toHaveBeenCalledWith('test-block', 2);
    });

    it('does not call weight provider when block is active', () => {
      const wp = createMockWeightProvider(80);
      const d = createActiveDispatcher({
        weightProvider: wp,
      });
      d.dispatch('GET', '/api/products');
      expect(wp.calculateWeight).not.toHaveBeenCalled();
    });
  });

  // ─── Active — block suspended — weight thresholds ─────────────

  describe('active — block suspended — weight decisions', () => {
    it('SERVE_FULLY when weight >= 65 (default high)', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(65),
      });
      expect(d.dispatch('GET', '/api/recs').type).toBe('SERVE_FULLY');
    });

    it('SERVE_FULLY when weight > 65', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(90),
      });
      expect(d.dispatch('GET', '/api/recs').type).toBe('SERVE_FULLY');
    });

    it('SERVE_LIMITED when weight >= 40 and < 65', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(50),
      });
      const result = d.dispatch('GET', '/api/recs');
      expect(result.type).toBe('SERVE_LIMITED');
    });

    it('SERVE_LIMITED includes hint', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(40),
      });
      const result = d.dispatch('GET', '/api/recs');
      expect(result.type).toBe('SERVE_LIMITED');
      expect((result as { hint: string }).hint).toBe('reduce-payload');
    });

    it('SUSPEND when weight < 40', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(10),
      });
      expect(d.dispatch('GET', '/api/recs').type).toBe('SUSPEND');
    });

    it('SUSPEND when no weight provider (defaults to 0)', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
      });
      expect(d.dispatch('GET', '/api/recs').type).toBe('SUSPEND');
    });

    it('boundary: weight exactly 40 → SERVE_LIMITED', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(40),
      });
      expect(d.dispatch('GET', '/').type).toBe('SERVE_LIMITED');
    });

    it('boundary: weight 39 → SUSPEND', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(39),
      });
      expect(d.dispatch('GET', '/').type).toBe('SUSPEND');
    });

    it('boundary: weight exactly 65 → SERVE_FULLY', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(65),
      });
      expect(d.dispatch('GET', '/').type).toBe('SERVE_FULLY');
    });

    it('boundary: weight 64 → SERVE_LIMITED', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(64),
      });
      expect(d.dispatch('GET', '/').type).toBe('SERVE_LIMITED');
    });
  });

  // ─── Custom weight thresholds ─────────────────────────────────

  describe('custom weight thresholds', () => {
    it('uses custom high threshold', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(75),
        weightOverrideHigh: 80,
      });
      // 75 < 80 → not high enough
      expect(d.dispatch('GET', '/').type).not.toBe('SERVE_FULLY');
    });

    it('uses custom low threshold', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(45),
        weightOverrideLow: 50,
      });
      // 45 < 50 → SUSPEND, not LIMITED
      expect(d.dispatch('GET', '/').type).toBe('SUSPEND');
    });
  });

  // ─── Policy Engine integration ────────────────────────────────

  describe('policy engine', () => {
    it('policy SERVE_FULLY overrides suspended block', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(10),
        policyProvider: createMockPolicyProvider({ type: 'SERVE_FULLY' }),
      });
      expect(d.dispatch('GET', '/api/recs').type).toBe('SERVE_FULLY');
    });

    it('policy SERVE_LIMITED returns policy outcome', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(10),
        policyProvider: createMockPolicyProvider({ type: 'SERVE_LIMITED', hint: 'custom-hint' }),
      });
      const result = d.dispatch('GET', '/api/recs');
      expect(result.type).toBe('SERVE_LIMITED');
      expect((result as { hint: string }).hint).toBe('custom-hint');
    });

    it('policy null → falls through to weight thresholds', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(50),
        policyProvider: createMockPolicyProvider(null),
      });
      expect(d.dispatch('GET', '/api/recs').type).toBe('SERVE_LIMITED');
    });

    it('no policy provider → skips policy step', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(50),
      });
      // Should go straight to weight threshold check
      expect(d.dispatch('GET', '/api/recs').type).toBe('SERVE_LIMITED');
    });

    it('policy is checked after weight (weight >= high skips policy)', () => {
      const pp = createMockPolicyProvider({ type: 'SUSPEND', response: { status: 503, body: '' } });
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(65),
        policyProvider: pp,
      });
      d.dispatch('GET', '/api/recs');
      expect(pp.evaluate).not.toHaveBeenCalled();
    });

    it('policy receives correct arguments', () => {
      const pp = createMockPolicyProvider(null);
      const sp = createMockSessionProvider(mockSession);
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(10),
        policyProvider: pp,
        sessionProvider: sp,
      });
      d.dispatch('GET', '/api/recs', 'sess-123');
      expect(pp.evaluate).toHaveBeenCalledWith(
        'GET', '/api/recs',
        { block: 'test-block', minLevel: 1, weightBase: 50 },
        mockSession,
        2,
      );
    });
  });

  // ─── Session context ──────────────────────────────────────────

  describe('session context', () => {
    it('passes session to weight provider when available', () => {
      const wp = createMockWeightProvider(10);
      const sp = createMockSessionProvider(mockSession);
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: wp,
        sessionProvider: sp,
      });
      d.dispatch('GET', '/api/recs', 'sess-123');
      expect(wp.calculateWeight).toHaveBeenCalledWith(
        expect.objectContaining({ block: 'test-block' }),
        mockSession,
        2,
      );
    });

    it('passes null when no sessionId provided', () => {
      const wp = createMockWeightProvider(10);
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: wp,
      });
      d.dispatch('GET', '/api/recs');
      expect(wp.calculateWeight).toHaveBeenCalledWith(
        expect.anything(), null, 2,
      );
    });

    it('passes null when sessionProvider not configured', () => {
      const wp = createMockWeightProvider(10);
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: wp,
      });
      d.dispatch('GET', '/api/recs', 'sess-123');
      expect(wp.calculateWeight).toHaveBeenCalledWith(
        expect.anything(), null, 2,
      );
    });

    it('passes null when sessionProvider returns null', () => {
      const wp = createMockWeightProvider(10);
      const sp = createMockSessionProvider(null);
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: wp,
        sessionProvider: sp,
      });
      d.dispatch('GET', '/api/recs', 'sess-123');
      expect(wp.calculateWeight).toHaveBeenCalledWith(
        expect.anything(), null, 2,
      );
    });
  });

  // ─── Suspended response building ─────────────────────────────

  describe('suspended response', () => {
    it('default response when no whenSuspended config', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
      });
      const result = d.dispatch('GET', '/api/recs');
      expect(result.type).toBe('SUSPEND');
      const resp = (result as { response: any }).response;
      expect(resp.status).toBe(200);
      expect(resp.body._chakra_suspended).toBe(true);
      expect(resp.headers['X-Chakra-Suspended']).toBe('test-block');
      expect(resp.headers['X-Chakra-Active']).toBe('true');
    });

    it('503 response type', () => {
      const rm = createSuspendedBlockMapper({
        getSuspendedBlockConfig: vi.fn().mockReturnValue({ responseType: '503' }),
      });
      const d = createActiveDispatcher({ ringMapper: rm });
      const result = d.dispatch('GET', '/api/recs');
      const resp = (result as { response: any }).response;
      expect(resp.status).toBe(503);
      expect(resp.body).toBe('Service temporarily unavailable');
      expect(resp.headers['Retry-After']).toBe('30');
    });

    it('static response type', () => {
      const rm = createSuspendedBlockMapper({
        getSuspendedBlockConfig: vi.fn().mockReturnValue({
          responseType: 'static',
          staticResponse: '{"message":"Come back later"}',
        }),
      });
      const d = createActiveDispatcher({ ringMapper: rm });
      const result = d.dispatch('GET', '/api/recs');
      const resp = (result as { response: any }).response;
      expect(resp.status).toBe(200);
      expect(resp.body).toBe('{"message":"Come back later"}');
    });

    it('static response with no staticResponse defaults to empty string', () => {
      const rm = createSuspendedBlockMapper({
        getSuspendedBlockConfig: vi.fn().mockReturnValue({ responseType: 'static' }),
      });
      const d = createActiveDispatcher({ ringMapper: rm });
      const result = d.dispatch('GET', '/api/recs');
      const resp = (result as { response: any }).response;
      expect(resp.body).toBe('');
    });

    it('cached response type (falls back with _chakra_cached flag)', () => {
      const rm = createSuspendedBlockMapper({
        getSuspendedBlockConfig: vi.fn().mockReturnValue({ responseType: 'cached' }),
      });
      const d = createActiveDispatcher({ ringMapper: rm });
      const result = d.dispatch('GET', '/api/recs');
      const resp = (result as { response: any }).response;
      expect(resp.status).toBe(200);
      expect(resp.body._chakra_cached).toBe(false);
    });

    it('empty response type', () => {
      const rm = createSuspendedBlockMapper({
        getSuspendedBlockConfig: vi.fn().mockReturnValue({ responseType: 'empty' }),
      });
      const d = createActiveDispatcher({ ringMapper: rm });
      const result = d.dispatch('GET', '/api/recs');
      const resp = (result as { response: any }).response;
      expect(resp.status).toBe(200);
      expect(resp.body._chakra_suspended).toBe(true);
    });

    it('all suspended responses include X-Chakra headers', () => {
      for (const responseType of ['503', 'static', 'cached', 'empty'] as const) {
        const rm = createSuspendedBlockMapper({
          getSuspendedBlockConfig: vi.fn().mockReturnValue({ responseType }),
        });
        const d = createActiveDispatcher({ ringMapper: rm });
        const result = d.dispatch('GET', '/');
        const resp = (result as { response: any }).response;
        expect(resp.headers['X-Chakra-Suspended']).toBe('test-block');
        expect(resp.headers['X-Chakra-Active']).toBe('true');
      }
    });
  });

  // ─── Metrics ──────────────────────────────────────────────────

  describe('metrics', () => {
    it('tracks totalRequests', () => {
      const d = new Dispatcher({ ringMapper: createMockRingMapper() });
      d.dispatch('GET', '/a');
      d.dispatch('GET', '/b');
      d.dispatch('GET', '/c');
      expect(d.getMetrics().totalRequests).toBe(3);
    });

    it('tracks serveFully outcome', () => {
      const d = createActiveDispatcher();
      d.dispatch('GET', '/api/products');
      expect(d.getMetrics().outcomes.serveFully).toBe(1);
    });

    it('tracks serveLimited outcome', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(50),
      });
      d.dispatch('GET', '/');
      expect(d.getMetrics().outcomes.serveLimited).toBe(1);
    });

    it('tracks suspended outcome', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
      });
      d.dispatch('GET', '/');
      expect(d.getMetrics().outcomes.suspended).toBe(1);
    });

    it('tracks weightOverrides', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(80),
      });
      d.dispatch('GET', '/');
      expect(d.getMetrics().weightOverrides).toBe(1);
    });

    it('tracks policyOverrides', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(10),
        policyProvider: createMockPolicyProvider({ type: 'SERVE_FULLY' }),
      });
      d.dispatch('GET', '/');
      expect(d.getMetrics().policyOverrides).toBe(1);
    });

    it('tracks perBlock served', () => {
      const d = createActiveDispatcher();
      d.dispatch('GET', '/');
      expect(d.getMetrics().perBlock['test-block']?.served).toBe(1);
    });

    it('tracks perBlock limited', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(50),
      });
      d.dispatch('GET', '/');
      expect(d.getMetrics().perBlock['test-block']?.limited).toBe(1);
    });

    it('tracks perBlock suspended', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
      });
      d.dispatch('GET', '/');
      expect(d.getMetrics().perBlock['test-block']?.suspended).toBe(1);
    });

    it('getMetrics returns deep copy', () => {
      const d = createActiveDispatcher();
      d.dispatch('GET', '/');
      const m = d.getMetrics();
      m.totalRequests = 999;
      m.outcomes.serveFully = 999;
      expect(d.getMetrics().totalRequests).toBe(1);
      expect(d.getMetrics().outcomes.serveFully).toBe(1);
    });

    it('getMetrics perBlock is a deep copy', () => {
      const d = createActiveDispatcher();
      d.dispatch('GET', '/');
      const m = d.getMetrics();
      m.perBlock['test-block'].served = 999;
      expect(d.getMetrics().perBlock['test-block'].served).toBe(1);
    });

    it('resetMetrics clears all counters', () => {
      const d = createActiveDispatcher();
      d.dispatch('GET', '/');
      d.dispatch('GET', '/');
      d.resetMetrics();
      const m = d.getMetrics();
      expect(m.totalRequests).toBe(0);
      expect(m.outcomes.serveFully).toBe(0);
      expect(Object.keys(m.perBlock)).toHaveLength(0);
    });
  });

  // ─── State management ─────────────────────────────────────────

  describe('state management', () => {
    it('setActivationState changes dispatch behavior', () => {
      const d = new Dispatcher({ ringMapper: createMockRingMapper() });
      expect(d.dispatch('GET', '/').type).toBe('SERVE_FULLY');

      d.setActivationState({ active: true, currentLevel: 0 });
      // Now active, block is active → still SERVE_FULLY but through different path
      expect(d.isActive()).toBe(true);
    });

    it('activation state is frozen', () => {
      const d = new Dispatcher({ ringMapper: createMockRingMapper() });
      d.setActivationState({ active: true, currentLevel: 2 });
      const state = d.getActivationState();
      expect(Object.isFrozen(state)).toBe(true);
    });

    it('isActive reflects current state', () => {
      const d = new Dispatcher({ ringMapper: createMockRingMapper() });
      expect(d.isActive()).toBe(false);
      d.setActivationState({ active: true, currentLevel: 0 });
      expect(d.isActive()).toBe(true);
      d.setActivationState({ active: false, currentLevel: 0 });
      expect(d.isActive()).toBe(false);
    });

    it('setWeightProvider swaps provider at runtime', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
      });
      // No weight provider → SUSPEND
      expect(d.dispatch('GET', '/').type).toBe('SUSPEND');

      d.setWeightProvider(createMockWeightProvider(80));
      // Now high weight → SERVE_FULLY
      expect(d.dispatch('GET', '/').type).toBe('SERVE_FULLY');
    });

    it('setPolicyProvider swaps provider at runtime', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
      });
      expect(d.dispatch('GET', '/').type).toBe('SUSPEND');

      d.setPolicyProvider(createMockPolicyProvider({ type: 'SERVE_FULLY' }));
      expect(d.dispatch('GET', '/').type).toBe('SERVE_FULLY');
    });

    it('setSessionProvider swaps provider at runtime', () => {
      const wp = createMockWeightProvider(10);
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: wp,
      });
      d.dispatch('GET', '/', 'sess-1');
      expect(wp.calculateWeight).toHaveBeenCalledWith(expect.anything(), null, 2);

      d.setSessionProvider(createMockSessionProvider(mockSession));
      d.dispatch('GET', '/', 'sess-1');
      expect(wp.calculateWeight).toHaveBeenLastCalledWith(expect.anything(), mockSession, 2);
    });

    it('getActivationState returns snapshot', () => {
      const d = new Dispatcher({ ringMapper: createMockRingMapper() });
      d.setActivationState({ active: true, currentLevel: 2 });
      const state = d.getActivationState();
      expect(state.active).toBe(true);
      expect(state.currentLevel).toBe(2);
    });
  });

  // ─── Error resilience (CHAKRA Rule #1) ────────────────────────

  describe('error resilience', () => {
    it('returns SERVE_FULLY when weight provider throws', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: { calculateWeight: () => { throw new Error('boom'); } },
      });
      expect(d.dispatch('GET', '/').type).toBe('SERVE_FULLY');
    });

    it('returns SERVE_FULLY when policy provider throws', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(50),
        policyProvider: { evaluate: () => { throw new Error('boom'); } },
      });
      expect(d.dispatch('GET', '/').type).toBe('SERVE_FULLY');
    });

    it('returns SERVE_FULLY when session provider throws', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(50),
        sessionProvider: { getSession: () => { throw new Error('boom'); } },
      });
      expect(d.dispatch('GET', '/', 'sess-1').type).toBe('SERVE_FULLY');
    });

    it('returns SERVE_FULLY when ringMapper.lookup throws', () => {
      const rm = createMockRingMapper({
        lookup: vi.fn().mockImplementation(() => { throw new Error('lookup fail'); }),
      });
      const d = createActiveDispatcher({ ringMapper: rm });
      expect(d.dispatch('GET', '/').type).toBe('SERVE_FULLY');
    });

    it('returns SERVE_FULLY when getBlockState throws', () => {
      const rm = createMockRingMapper({
        getBlockState: vi.fn().mockImplementation(() => { throw new Error('state fail'); }),
      });
      const d = createActiveDispatcher({ ringMapper: rm });
      expect(d.dispatch('GET', '/').type).toBe('SERVE_FULLY');
    });

    it('never throws regardless of input', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
      });
      // Unusual inputs should not throw
      expect(() => d.dispatch('', '')).not.toThrow();
      expect(() => d.dispatch(null as any, undefined as any)).not.toThrow();
    });
  });

  // ─── Immutability ─────────────────────────────────────────────

  describe('immutability', () => {
    it('SERVE_LIMITED outcome is frozen', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(50),
      });
      const result = d.dispatch('GET', '/');
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('SUSPEND outcome is frozen', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
      });
      const result = d.dispatch('GET', '/');
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('policy outcome is frozen', () => {
      const d = createActiveDispatcher({
        ringMapper: createSuspendedBlockMapper(),
        weightProvider: createMockWeightProvider(10),
        policyProvider: createMockPolicyProvider({ type: 'SERVE_FULLY' }),
      });
      const result = d.dispatch('GET', '/');
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  // ─── Multi-block scenario ─────────────────────────────────────

  describe('multi-block routing', () => {
    it('routes different endpoints to different outcomes', () => {
      const rm = createMockRingMapper({
        lookup: vi.fn().mockImplementation((m: string, p: string) => {
          if (p.startsWith('/api/payment')) {
            return { block: 'payment', minLevel: 0, weightBase: 90 };
          }
          return { block: 'browse', minLevel: 3, weightBase: 20 };
        }),
        getBlockState: vi.fn().mockImplementation((block: string) => {
          if (block === 'payment') {
            return { block: 'payment', currentLevel: 2, isActive: true, isSuspended: false };
          }
          return { block: 'browse', currentLevel: 2, isActive: false, isSuspended: true };
        }),
      });

      const d = createActiveDispatcher({ ringMapper: rm });

      // Payment block is active → SERVE_FULLY
      expect(d.dispatch('POST', '/api/payment/charge').type).toBe('SERVE_FULLY');

      // Browse block is suspended, no weight provider → SUSPEND
      expect(d.dispatch('GET', '/api/browse/catalog').type).toBe('SUSPEND');

      const metrics = d.getMetrics();
      expect(metrics.perBlock['payment']?.served).toBe(1);
      expect(metrics.perBlock['browse']?.suspended).toBe(1);
    });
  });
});
