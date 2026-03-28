import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PolicyEngine } from '../../src/core/policy-engine';
import type { PolicyRule, PolicyConditions, PolicyAction, PolicyEngineConfig } from '../../src/core/policy-engine';
import type { RouteInfo, SessionContext, RPMState } from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRoute(overrides: Partial<RouteInfo> = {}): RouteInfo {
  return { block: 'test-block', minLevel: 2, weightBase: 30, ...overrides };
}

function makeSession(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    callCount: 5,
    hasCartItems: false,
    cartItemCount: 0,
    matchesMomentOfValue: false,
    momentOfValueStrength: 'none',
    recentEndpoints: [],
    userTier: null,
    sessionAgeSeconds: 300,
    lastSeenTime: Date.now(),
    ...overrides,
  };
}

function makeRPMState(overrides: Partial<RPMState> = {}): RPMState {
  return {
    global: 50,
    perBlock: {},
    updatedAt: Date.now(),
    phase: 3,
    ...overrides,
  };
}

function makeRule(
  name: string,
  conditions: PolicyConditions,
  action: PolicyAction,
  priority = 50,
): PolicyRule {
  return { name, if: conditions, then: action, priority };
}

function makeEngine(rules: PolicyRule[]): PolicyEngine {
  return new PolicyEngine({ rules });
}

const SERVE_FULLY_ACTION: PolicyAction = { action: 'serve_fully' };
const SUSPEND_EMPTY_ACTION: PolicyAction = { action: 'suspend', response: 'empty' };
const SERVE_LIMITED_ACTION: PolicyAction = { action: 'serve_limited', hint: 'use-cache' };

// ─── Core evaluation behaviour ────────────────────────────────────────────────

describe('PolicyEngine', () => {

  describe('no-match behaviour', () => {
    it('returns null when no rules configured', () => {
      const engine = makeEngine([]);
      expect(engine.evaluate('GET', '/api/products', makeRoute(), null, 2)).toBeNull();
    });

    it('returns null when no rule conditions match', () => {
      const engine = makeEngine([
        makeRule('premium-only', { user_tier: 'premium' }, SERVE_FULLY_ACTION),
      ]);
      const result = engine.evaluate('GET', '/', makeRoute(), makeSession({ userTier: 'standard' }), 2);
      expect(result).toBeNull();
    });

    it('returns null when no session and rule requires session', () => {
      const engine = makeEngine([
        makeRule('cart-rule', { has_cart_items: true }, SERVE_FULLY_ACTION),
      ]);
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)).toBeNull();
    });
  });

  // ─── Priority ordering ────────────────────────────────────────────────────

  describe('priority ordering', () => {
    it('evaluates higher priority rule first', () => {
      const engine = makeEngine([
        makeRule('low', { block: 'test-block' }, SUSPEND_EMPTY_ACTION, 10),
        makeRule('high', { block: 'test-block' }, SERVE_FULLY_ACTION, 100),
      ]);
      const result = engine.evaluate('GET', '/', makeRoute(), null, 2);
      expect(result?.type).toBe('SERVE_FULLY');
    });

    it('first rule in config wins on equal priority', () => {
      const engine = makeEngine([
        makeRule('first', { block: 'test-block' }, SERVE_FULLY_ACTION, 50),
        makeRule('second', { block: 'test-block' }, SUSPEND_EMPTY_ACTION, 50),
      ]);
      const result = engine.evaluate('GET', '/', makeRoute(), null, 2);
      expect(result?.type).toBe('SERVE_FULLY');
    });

    it('stops at first matching rule', () => {
      const engine = makeEngine([
        makeRule('first-match', { block: 'test-block' }, SERVE_FULLY_ACTION, 100),
        makeRule('would-also-match', { block: 'test-block' }, SUSPEND_EMPTY_ACTION, 50),
      ]);
      const result = engine.evaluate('GET', '/', makeRoute(), null, 2);
      expect(result?.type).toBe('SERVE_FULLY');
    });
  });

  // ─── Action types ─────────────────────────────────────────────────────────

  describe('actions', () => {
    it('serve_fully returns SERVE_FULLY outcome', () => {
      const engine = makeEngine([makeRule('r', {}, SERVE_FULLY_ACTION)]);
      const result = engine.evaluate('GET', '/', makeRoute(), null, 2);
      expect(result?.type).toBe('SERVE_FULLY');
    });

    it('serve_limited returns SERVE_LIMITED with hint', () => {
      const engine = makeEngine([
        makeRule('r', {}, { action: 'serve_limited', hint: 'use-cache' }),
      ]);
      const result = engine.evaluate('GET', '/', makeRoute(), null, 2);
      expect(result?.type).toBe('SERVE_LIMITED');
      if (result?.type === 'SERVE_LIMITED') expect(result.hint).toBe('use-cache');
    });

    it('serve_limited defaults hint to reduce-payload', () => {
      const engine = makeEngine([
        makeRule('r', {}, { action: 'serve_limited' }),
      ]);
      const result = engine.evaluate('GET', '/', makeRoute(), null, 2);
      expect(result?.type).toBe('SERVE_LIMITED');
      if (result?.type === 'SERVE_LIMITED') expect(result.hint).toBe('reduce-payload');
    });

    it('suspend with empty returns SUSPEND with 200 empty body', () => {
      const engine = makeEngine([
        makeRule('r', {}, { action: 'suspend', response: 'empty' }),
      ]);
      const result = engine.evaluate('GET', '/', makeRoute(), null, 2);
      expect(result?.type).toBe('SUSPEND');
      if (result?.type === 'SUSPEND') {
        expect(result.response.status).toBe(200);
        expect(result.response.body).toEqual({});
      }
    });

    it('suspend with 503 returns SUSPEND with 503 status', () => {
      const engine = makeEngine([
        makeRule('r', {}, { action: 'suspend', response: '503' }),
      ]);
      const result = engine.evaluate('GET', '/', makeRoute(), null, 2);
      expect(result?.type).toBe('SUSPEND');
      if (result?.type === 'SUSPEND') expect(result.response.status).toBe(503);
    });

    it('suspend with static returns custom body and status', () => {
      const engine = makeEngine([
        makeRule('r', {}, {
          action: 'suspend',
          response: 'static',
          static_body: '{"message":"limited"}',
          static_status: 200,
        }),
      ]);
      const result = engine.evaluate('GET', '/', makeRoute(), null, 2);
      expect(result?.type).toBe('SUSPEND');
      if (result?.type === 'SUSPEND') {
        expect(result.response.body).toBe('{"message":"limited"}');
        expect(result.response.status).toBe(200);
      }
    });

    it('suspend static defaults to 200 when no static_status', () => {
      const engine = makeEngine([
        makeRule('r', {}, {
          action: 'suspend',
          response: 'static',
          static_body: '{"ok":false}',
        }),
      ]);
      const result = engine.evaluate('GET', '/', makeRoute(), null, 2);
      if (result?.type === 'SUSPEND') expect(result.response.status).toBe(200);
    });

    it('suspend with cached falls through to empty (cache not yet implemented)', () => {
      const engine = makeEngine([
        makeRule('r', {}, { action: 'suspend', response: 'cached' }),
      ]);
      const result = engine.evaluate('GET', '/', makeRoute(), null, 2);
      expect(result?.type).toBe('SUSPEND');
      if (result?.type === 'SUSPEND') expect(result.response.status).toBe(200);
    });

    it('redirect returns null (not yet implemented — falls through)', () => {
      const engine = makeEngine([
        makeRule('redirect', {}, { action: 'redirect', to: '/fallback' }),
        makeRule('fallback', { block: 'test-block' }, SERVE_FULLY_ACTION, 1),
      ]);
      // redirect doesn't produce outcome, falls to next rule
      const result = engine.evaluate('GET', '/', makeRoute(), null, 2);
      expect(result?.type).toBe('SERVE_FULLY');
    });

    it('rate_limit returns null (not yet implemented — falls through)', () => {
      const engine = makeEngine([
        makeRule('rl', {}, { action: 'rate_limit', max_per_minute: 10 }),
        makeRule('fallback', { block: 'test-block' }, SUSPEND_EMPTY_ACTION, 1),
      ]);
      const result = engine.evaluate('GET', '/', makeRoute(), null, 2);
      expect(result?.type).toBe('SUSPEND');
    });
  });

  // ─── User / session conditions ────────────────────────────────────────────

  describe('user_tier condition', () => {
    it('matches when tier equals', () => {
      const engine = makeEngine([makeRule('r', { user_tier: 'premium' }, SERVE_FULLY_ACTION)]);
      const result = engine.evaluate('GET', '/', makeRoute(), makeSession({ userTier: 'premium' }), 2);
      expect(result?.type).toBe('SERVE_FULLY');
    });

    it('does not match different tier', () => {
      const engine = makeEngine([makeRule('r', { user_tier: 'premium' }, SERVE_FULLY_ACTION)]);
      const result = engine.evaluate('GET', '/', makeRoute(), makeSession({ userTier: 'standard' }), 2);
      expect(result).toBeNull();
    });

    it('does not match null tier', () => {
      const engine = makeEngine([makeRule('r', { user_tier: 'premium' }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('GET', '/', makeRoute(), makeSession({ userTier: null }), 2)).toBeNull();
    });

    it('does not match when no session', () => {
      const engine = makeEngine([makeRule('r', { user_tier: 'premium' }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)).toBeNull();
    });
  });

  describe('user_tier_in condition', () => {
    it('matches when tier is in list', () => {
      const engine = makeEngine([
        makeRule('r', { user_tier_in: ['premium', 'enterprise'] }, SERVE_FULLY_ACTION),
      ]);
      const result = engine.evaluate('GET', '/', makeRoute(), makeSession({ userTier: 'enterprise' }), 2);
      expect(result?.type).toBe('SERVE_FULLY');
    });

    it('does not match when tier not in list', () => {
      const engine = makeEngine([
        makeRule('r', { user_tier_in: ['premium', 'enterprise'] }, SERVE_FULLY_ACTION),
      ]);
      const result = engine.evaluate('GET', '/', makeRoute(), makeSession({ userTier: 'standard' }), 2);
      expect(result).toBeNull();
    });
  });

  describe('is_authenticated condition', () => {
    it('matches authenticated (callCount > 0)', () => {
      const engine = makeEngine([makeRule('r', { is_authenticated: true }, SERVE_FULLY_ACTION)]);
      const result = engine.evaluate('GET', '/', makeRoute(), makeSession({ callCount: 3 }), 2);
      expect(result?.type).toBe('SERVE_FULLY');
    });

    it('does not match anonymous (no session)', () => {
      const engine = makeEngine([makeRule('r', { is_authenticated: true }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)).toBeNull();
    });

    it('matches anonymous check correctly', () => {
      const engine = makeEngine([makeRule('r', { is_authenticated: false }, SUSPEND_EMPTY_ACTION)]);
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)?.type).toBe('SUSPEND');
    });
  });

  describe('session_depth_above condition', () => {
    it('matches when callCount is above threshold', () => {
      const engine = makeEngine([makeRule('r', { session_depth_above: 5 }, SERVE_FULLY_ACTION)]);
      const result = engine.evaluate('GET', '/', makeRoute(), makeSession({ callCount: 6 }), 2);
      expect(result?.type).toBe('SERVE_FULLY');
    });

    it('does not match when callCount equals threshold (strict greater-than)', () => {
      const engine = makeEngine([makeRule('r', { session_depth_above: 5 }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('GET', '/', makeRoute(), makeSession({ callCount: 5 }), 2)).toBeNull();
    });

    it('uses 0 for null session', () => {
      const engine = makeEngine([makeRule('r', { session_depth_above: 0 }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)).toBeNull();
    });
  });

  describe('session_depth_below condition', () => {
    it('matches when callCount is below threshold', () => {
      const engine = makeEngine([makeRule('r', { session_depth_below: 3 }, SUSPEND_EMPTY_ACTION)]);
      const result = engine.evaluate('GET', '/', makeRoute(), makeSession({ callCount: 2 }), 2);
      expect(result?.type).toBe('SUSPEND');
    });

    it('does not match when callCount equals threshold', () => {
      const engine = makeEngine([makeRule('r', { session_depth_below: 3 }, SUSPEND_EMPTY_ACTION)]);
      expect(engine.evaluate('GET', '/', makeRoute(), makeSession({ callCount: 3 }), 2)).toBeNull();
    });
  });

  describe('has_cart_items condition', () => {
    it('matches when cart has items', () => {
      const engine = makeEngine([makeRule('r', { has_cart_items: true }, SERVE_FULLY_ACTION)]);
      const result = engine.evaluate('GET', '/', makeRoute(), makeSession({ hasCartItems: true }), 2);
      expect(result?.type).toBe('SERVE_FULLY');
    });

    it('does not match when cart empty', () => {
      const engine = makeEngine([makeRule('r', { has_cart_items: true }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('GET', '/', makeRoute(), makeSession({ hasCartItems: false }), 2)).toBeNull();
    });

    it('matches empty cart check', () => {
      const engine = makeEngine([makeRule('r', { has_cart_items: false }, SUSPEND_EMPTY_ACTION)]);
      const result = engine.evaluate('GET', '/', makeRoute(), makeSession({ hasCartItems: false }), 2);
      expect(result?.type).toBe('SUSPEND');
    });
  });

  describe('cart_items_above condition', () => {
    it('matches when cartItemCount is above threshold', () => {
      const engine = makeEngine([makeRule('r', { cart_items_above: 2 }, SERVE_FULLY_ACTION)]);
      const result = engine.evaluate('GET', '/', makeRoute(), makeSession({ cartItemCount: 3 }), 2);
      expect(result?.type).toBe('SERVE_FULLY');
    });

    it('does not match at exactly threshold', () => {
      const engine = makeEngine([makeRule('r', { cart_items_above: 2 }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('GET', '/', makeRoute(), makeSession({ cartItemCount: 2 }), 2)).toBeNull();
    });
  });

  describe('moment_of_value condition', () => {
    it('matches exact strength', () => {
      const engine = makeEngine([makeRule('r', { moment_of_value: 'full' }, SERVE_FULLY_ACTION)]);
      const result = engine.evaluate('GET', '/', makeRoute(), makeSession({ momentOfValueStrength: 'full' }), 2);
      expect(result?.type).toBe('SERVE_FULLY');
    });

    it('does not match different strength', () => {
      const engine = makeEngine([makeRule('r', { moment_of_value: 'full' }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('GET', '/', makeRoute(), makeSession({ momentOfValueStrength: 'partial' }), 2)).toBeNull();
    });
  });

  describe('moment_of_value_any condition', () => {
    it('matches partial strength', () => {
      const engine = makeEngine([makeRule('r', { moment_of_value_any: true }, SERVE_FULLY_ACTION)]);
      const result = engine.evaluate('GET', '/', makeRoute(), makeSession({ momentOfValueStrength: 'partial' }), 2);
      expect(result?.type).toBe('SERVE_FULLY');
    });

    it('matches full strength', () => {
      const engine = makeEngine([makeRule('r', { moment_of_value_any: true }, SERVE_FULLY_ACTION)]);
      const result = engine.evaluate('GET', '/', makeRoute(), makeSession({ momentOfValueStrength: 'full' }), 2);
      expect(result?.type).toBe('SERVE_FULLY');
    });

    it('does not match none strength', () => {
      const engine = makeEngine([makeRule('r', { moment_of_value_any: true }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('GET', '/', makeRoute(), makeSession({ momentOfValueStrength: 'none' }), 2)).toBeNull();
    });

    it('does not match null session', () => {
      const engine = makeEngine([makeRule('r', { moment_of_value_any: true }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)).toBeNull();
    });
  });

  // ─── Request conditions ───────────────────────────────────────────────────

  describe('method condition', () => {
    it('matches when method equals', () => {
      const engine = makeEngine([makeRule('r', { method: 'POST' }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('POST', '/api/cart', makeRoute(), null, 2)?.type).toBe('SERVE_FULLY');
    });

    it('is case-insensitive', () => {
      const engine = makeEngine([makeRule('r', { method: 'post' }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('POST', '/', makeRoute(), null, 2)?.type).toBe('SERVE_FULLY');
    });

    it('does not match different method', () => {
      const engine = makeEngine([makeRule('r', { method: 'POST' }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)).toBeNull();
    });
  });

  describe('method_in condition', () => {
    it('matches when method is in list', () => {
      const engine = makeEngine([
        makeRule('r', { method_in: ['POST', 'PUT', 'PATCH'] }, SERVE_FULLY_ACTION),
      ]);
      expect(engine.evaluate('PUT', '/api/update', makeRoute(), null, 2)?.type).toBe('SERVE_FULLY');
    });

    it('does not match when not in list', () => {
      const engine = makeEngine([
        makeRule('r', { method_in: ['POST', 'PUT'] }, SERVE_FULLY_ACTION),
      ]);
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)).toBeNull();
    });
  });

  describe('path_exact condition', () => {
    it('matches exact path', () => {
      const engine = makeEngine([makeRule('r', { path_exact: '/api/payment/process' }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('POST', '/api/payment/process', makeRoute(), null, 2)?.type).toBe('SERVE_FULLY');
    });

    it('does not match different path', () => {
      const engine = makeEngine([makeRule('r', { path_exact: '/api/payment/process' }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('POST', '/api/payment/other', makeRoute(), null, 2)).toBeNull();
    });
  });

  describe('path_matches glob condition', () => {
    it('matches with * wildcard', () => {
      const engine = makeEngine([makeRule('r', { path_matches: '/api/checkout/*' }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('GET', '/api/checkout/summary', makeRoute(), null, 2)?.type).toBe('SERVE_FULLY');
    });

    it('does not match across segments with *', () => {
      const engine = makeEngine([makeRule('r', { path_matches: '/api/checkout/*' }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('GET', '/api/checkout/nested/path', makeRoute(), null, 2)).toBeNull();
    });

    it('matches across segments with **', () => {
      const engine = makeEngine([makeRule('r', { path_matches: '/api/**' }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('GET', '/api/checkout/summary', makeRoute(), null, 2)?.type).toBe('SERVE_FULLY');
    });

    it('does not match unrelated path', () => {
      const engine = makeEngine([makeRule('r', { path_matches: '/api/checkout/*' }, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('GET', '/public/home', makeRoute(), null, 2)).toBeNull();
    });
  });

  describe('block condition', () => {
    it('matches when block equals', () => {
      const engine = makeEngine([makeRule('r', { block: 'payment-block' }, SERVE_FULLY_ACTION)]);
      const route = makeRoute({ block: 'payment-block' });
      expect(engine.evaluate('GET', '/', route, null, 2)?.type).toBe('SERVE_FULLY');
    });

    it('does not match different block', () => {
      const engine = makeEngine([makeRule('r', { block: 'payment-block' }, SERVE_FULLY_ACTION)]);
      const route = makeRoute({ block: 'browse-block' });
      expect(engine.evaluate('GET', '/', route, null, 2)).toBeNull();
    });
  });

  describe('block_in condition', () => {
    it('matches when block is in list', () => {
      const engine = makeEngine([
        makeRule('r', { block_in: ['payment-block', 'auth-block'] }, SERVE_FULLY_ACTION),
      ]);
      const route = makeRoute({ block: 'auth-block' });
      expect(engine.evaluate('GET', '/', route, null, 2)?.type).toBe('SERVE_FULLY');
    });

    it('does not match when block not in list', () => {
      const engine = makeEngine([
        makeRule('r', { block_in: ['payment-block', 'auth-block'] }, SERVE_FULLY_ACTION),
      ]);
      const route = makeRoute({ block: 'browse-block' });
      expect(engine.evaluate('GET', '/', route, null, 2)).toBeNull();
    });
  });

  describe('block_not condition', () => {
    it('matches when block is NOT in excluded list', () => {
      const engine = makeEngine([
        makeRule('r', { block_not: ['payment-block', 'auth-block'] }, SUSPEND_EMPTY_ACTION),
      ]);
      const route = makeRoute({ block: 'browse-block' });
      expect(engine.evaluate('GET', '/', route, null, 2)?.type).toBe('SUSPEND');
    });

    it('does not match when block IS in excluded list', () => {
      const engine = makeEngine([
        makeRule('r', { block_not: ['payment-block', 'auth-block'] }, SUSPEND_EMPTY_ACTION),
      ]);
      const route = makeRoute({ block: 'payment-block' });
      expect(engine.evaluate('GET', '/', route, null, 2)).toBeNull();
    });
  });

  // ─── Load conditions ──────────────────────────────────────────────────────

  describe('rpm_above condition', () => {
    it('matches when global RPM is above threshold', () => {
      const engine = makeEngine([makeRule('r', { rpm_above: 65 }, SUSPEND_EMPTY_ACTION)]);
      engine.setRPMState(makeRPMState({ global: 70 }));
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)?.type).toBe('SUSPEND');
    });

    it('does not match at exactly threshold (strict greater-than)', () => {
      const engine = makeEngine([makeRule('r', { rpm_above: 65 }, SUSPEND_EMPTY_ACTION)]);
      engine.setRPMState(makeRPMState({ global: 65 }));
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)).toBeNull();
    });

    it('treats missing RPM state as 0', () => {
      const engine = makeEngine([makeRule('r', { rpm_above: 0 }, SUSPEND_EMPTY_ACTION)]);
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)).toBeNull();
    });
  });

  describe('rpm_below condition', () => {
    it('matches when global RPM is below threshold', () => {
      const engine = makeEngine([makeRule('r', { rpm_below: 40 }, SERVE_FULLY_ACTION)]);
      engine.setRPMState(makeRPMState({ global: 30 }));
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)?.type).toBe('SERVE_FULLY');
    });

    it('does not match at exactly threshold', () => {
      const engine = makeEngine([makeRule('r', { rpm_below: 40 }, SERVE_FULLY_ACTION)]);
      engine.setRPMState(makeRPMState({ global: 40 }));
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)).toBeNull();
    });
  });

  describe('rpm_between condition', () => {
    it('matches when RPM is within range', () => {
      const engine = makeEngine([makeRule('r', { rpm_between: [55, 80] }, SERVE_LIMITED_ACTION)]);
      engine.setRPMState(makeRPMState({ global: 70 }));
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)?.type).toBe('SERVE_LIMITED');
    });

    it('matches at lower bound (inclusive)', () => {
      const engine = makeEngine([makeRule('r', { rpm_between: [55, 80] }, SERVE_LIMITED_ACTION)]);
      engine.setRPMState(makeRPMState({ global: 55 }));
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)?.type).toBe('SERVE_LIMITED');
    });

    it('matches at upper bound (inclusive)', () => {
      const engine = makeEngine([makeRule('r', { rpm_between: [55, 80] }, SERVE_LIMITED_ACTION)]);
      engine.setRPMState(makeRPMState({ global: 80 }));
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)?.type).toBe('SERVE_LIMITED');
    });

    it('does not match outside range', () => {
      const engine = makeEngine([makeRule('r', { rpm_between: [55, 80] }, SERVE_LIMITED_ACTION)]);
      engine.setRPMState(makeRPMState({ global: 90 }));
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)).toBeNull();
    });
  });

  describe('block_rpm_above condition', () => {
    it('matches when per-block RPM is above threshold', () => {
      const engine = makeEngine([makeRule('r', { block_rpm_above: 70 }, SUSPEND_EMPTY_ACTION)]);
      engine.setRPMState(makeRPMState({ perBlock: { 'test-block': 75 } }));
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)?.type).toBe('SUSPEND');
    });

    it('does not match when per-block RPM is missing (defaults to 0)', () => {
      const engine = makeEngine([makeRule('r', { block_rpm_above: 70 }, SUSPEND_EMPTY_ACTION)]);
      engine.setRPMState(makeRPMState({ perBlock: {} }));
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)).toBeNull();
    });
  });

  describe('block_rpm_below condition', () => {
    it('matches when per-block RPM is below threshold', () => {
      const engine = makeEngine([makeRule('r', { block_rpm_below: 50 }, SERVE_FULLY_ACTION)]);
      engine.setRPMState(makeRPMState({ perBlock: { 'test-block': 40 } }));
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)?.type).toBe('SERVE_FULLY');
    });
  });

  // ─── AND logic (multiple conditions) ─────────────────────────────────────

  describe('AND logic — multiple conditions', () => {
    it('requires all conditions to be true', () => {
      const engine = makeEngine([
        makeRule('r', {
          user_tier: 'premium',
          has_cart_items: true,
        }, SERVE_FULLY_ACTION),
      ]);
      // Only tier matches, no cart
      expect(engine.evaluate('GET', '/', makeRoute(), makeSession({ userTier: 'premium', hasCartItems: false }), 2)).toBeNull();
      // Both match
      const result = engine.evaluate('GET', '/', makeRoute(), makeSession({ userTier: 'premium', hasCartItems: true }), 2);
      expect(result?.type).toBe('SERVE_FULLY');
    });

    it('empty conditions = always match', () => {
      const engine = makeEngine([makeRule('r', {}, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)?.type).toBe('SERVE_FULLY');
    });
  });

  // ─── Live rule updates ────────────────────────────────────────────────────

  describe('live rule updates', () => {
    it('updateRules replaces rules atomically', () => {
      const engine = makeEngine([makeRule('original', { block: 'old-block' }, SERVE_FULLY_ACTION)]);
      const oldRoute = makeRoute({ block: 'old-block' });
      expect(engine.evaluate('GET', '/', oldRoute, null, 2)?.type).toBe('SERVE_FULLY');

      engine.updateRules([makeRule('new', { block: 'new-block' }, SUSPEND_EMPTY_ACTION)]);
      expect(engine.evaluate('GET', '/', oldRoute, null, 2)).toBeNull();

      const newRoute = makeRoute({ block: 'new-block' });
      expect(engine.evaluate('GET', '/', newRoute, null, 2)?.type).toBe('SUSPEND');
    });

    it('updateRules with empty array clears all rules', () => {
      const engine = makeEngine([makeRule('r', {}, SERVE_FULLY_ACTION)]);
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)?.type).toBe('SERVE_FULLY');
      engine.updateRules([]);
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)).toBeNull();
    });

    it('new rules are priority-sorted after updateRules', () => {
      const engine = makeEngine([]);
      engine.updateRules([
        makeRule('low', { block: 'test-block' }, SUSPEND_EMPTY_ACTION, 10),
        makeRule('high', { block: 'test-block' }, SERVE_FULLY_ACTION, 100),
      ]);
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)?.type).toBe('SERVE_FULLY');
    });
  });

  // ─── RPM state management ─────────────────────────────────────────────────

  describe('setRPMState', () => {
    it('updates RPM snapshot used in subsequent evaluations', () => {
      const engine = makeEngine([makeRule('r', { rpm_above: 60 }, SUSPEND_EMPTY_ACTION)]);
      engine.setRPMState(makeRPMState({ global: 50 }));
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)).toBeNull();
      engine.setRPMState(makeRPMState({ global: 70 }));
      expect(engine.evaluate('GET', '/', makeRoute(), null, 2)?.type).toBe('SUSPEND');
    });
  });

  // ─── Pre-frozen outcomes ──────────────────────────────────────────────────

  describe('outcome immutability', () => {
    it('returned outcomes are frozen', () => {
      const engine = makeEngine([makeRule('r', {}, SERVE_FULLY_ACTION)]);
      const result = engine.evaluate('GET', '/', makeRoute(), null, 2);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('serve_fully returns same frozen reference each time', () => {
      const engine = makeEngine([makeRule('r', {}, SERVE_FULLY_ACTION)]);
      const r1 = engine.evaluate('GET', '/', makeRoute(), null, 2);
      const r2 = engine.evaluate('GET', '/', makeRoute(), null, 2);
      expect(r1).toBe(r2);  // same object reference
    });
  });

  // ─── Error resilience ─────────────────────────────────────────────────────

  describe('error resilience', () => {
    it('returns null on evaluation error', () => {
      // Use a session-dependent condition so the proxy's property access triggers
      const engine = makeEngine([makeRule('r', { has_cart_items: true }, SERVE_FULLY_ACTION)]);
      const badSession = new Proxy({} as SessionContext, {
        get() { throw new Error('boom'); },
      });
      // Engine should not throw — catch block returns null
      const result = engine.evaluate('GET', '/', makeRoute(), badSession, 2);
      expect(result).toBeNull();
    });
  });

  // ─── Metadata methods ─────────────────────────────────────────────────────

  describe('getRuleCount and getRuleNames', () => {
    it('returns correct rule count', () => {
      const engine = makeEngine([
        makeRule('a', {}, SERVE_FULLY_ACTION, 10),
        makeRule('b', {}, SUSPEND_EMPTY_ACTION, 20),
      ]);
      expect(engine.getRuleCount()).toBe(2);
    });

    it('returns rule names in priority order (highest first)', () => {
      const engine = makeEngine([
        makeRule('low', {}, SERVE_FULLY_ACTION, 10),
        makeRule('high', {}, SUSPEND_EMPTY_ACTION, 100),
      ]);
      expect(engine.getRuleNames()).toEqual(['high', 'low']);
    });

    it('returns empty array when no rules', () => {
      const engine = makeEngine([]);
      expect(engine.getRuleNames()).toEqual([]);
      expect(engine.getRuleCount()).toBe(0);
    });
  });

  // ─── CP7 spec examples ────────────────────────────────────────────────────

  describe('CP7 e-commerce config example', () => {
    let engine: PolicyEngine;

    beforeEach(() => {
      engine = makeEngine([
        makeRule('premier-users-always-served', { user_tier: 'premium' }, SERVE_FULLY_ACTION, 100),
        makeRule('protect-mid-checkout', { moment_of_value: 'full' }, SERVE_FULLY_ACTION, 95),
        makeRule('protect-cart-with-items', { cart_items_above: 2, session_depth_above: 4 }, SERVE_FULLY_ACTION, 90),
        makeRule('cache-search-on-moderate-load', { block: 'search-block', rpm_above: 65 }, SERVE_LIMITED_ACTION, 70),
        makeRule('suspend-ads-early', { block: 'ads-block', rpm_above: 45 }, SUSPEND_EMPTY_ACTION, 60),
        makeRule('emergency-checkout-only', {
          rpm_above: 92,
          block_not: ['payment-block', 'cart-block', 'auth-block'],
        }, {
          action: 'suspend',
          response: 'static',
          static_body: '{"message":"High traffic — some features temporarily limited"}',
        }, 50),
      ]);
      engine.setRPMState(makeRPMState({ global: 70 }));
    });

    it('premier user is always served fully regardless of RPM', () => {
      const result = engine.evaluate('GET', '/api/products', makeRoute({ block: 'search-block' }), makeSession({ userTier: 'premium' }), 2);
      expect(result?.type).toBe('SERVE_FULLY');
    });

    it('full MoV match is served fully', () => {
      const result = engine.evaluate('GET', '/api/checkout', makeRoute(), makeSession({ momentOfValueStrength: 'full' }), 2);
      expect(result?.type).toBe('SERVE_FULLY');
    });

    it('search block gets serve_limited on moderate load (rpm=70)', () => {
      const result = engine.evaluate('GET', '/api/search', makeRoute({ block: 'search-block' }), makeSession({ userTier: 'standard' }), 2);
      expect(result?.type).toBe('SERVE_LIMITED');
    });

    it('ads block gets suspended when rpm > 45', () => {
      const result = engine.evaluate('GET', '/api/ads', makeRoute({ block: 'ads-block' }), null, 2);
      expect(result?.type).toBe('SUSPEND');
    });

    it('payment block is NOT suspended by emergency rule', () => {
      engine.setRPMState(makeRPMState({ global: 95 }));
      const result = engine.evaluate('POST', '/api/payment', makeRoute({ block: 'payment-block' }), null, 2);
      // No rule matches payment-block
      expect(result).toBeNull();
    });

    it('non-essential block gets static suspend during emergency rpm > 92', () => {
      engine.setRPMState(makeRPMState({ global: 95 }));
      const result = engine.evaluate('GET', '/api/recs', makeRoute({ block: 'recommendations-block' }), null, 2);
      expect(result?.type).toBe('SUSPEND');
    });
  });
});
