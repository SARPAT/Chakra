// Session Cache unit tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionCache } from '../../src/background/session-cache';
import type { SessionContext } from '../../src/types';

function makeContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    callCount: 1,
    hasCartItems: false,
    cartItemCount: 0,
    matchesMomentOfValue: false,
    momentOfValueStrength: 'none',
    recentEndpoints: [],
    userTier: null,
    sessionAgeSeconds: 0,
    lastSeenTime: Date.now(),
    ...overrides,
  };
}

describe('SessionCache', () => {

  describe('get() / set()', () => {
    it('returns null for unknown session', () => {
      const cache = new SessionCache({ cleanupIntervalMs: 999999 });
      expect(cache.get('unknown')).toBeNull();
      cache.stop();
    });

    it('returns stored context', () => {
      const cache = new SessionCache({ cleanupIntervalMs: 999999 });
      const ctx = makeContext({ callCount: 5 });
      cache.set('session1', ctx);
      expect(cache.get('session1')).toEqual(ctx);
      cache.stop();
    });

    it('overwrites existing context on second set()', () => {
      const cache = new SessionCache({ cleanupIntervalMs: 999999 });
      cache.set('s1', makeContext({ callCount: 1 }));
      cache.set('s1', makeContext({ callCount: 2 }));
      expect(cache.get('s1')?.callCount).toBe(2);
      cache.stop();
    });
  });

  describe('TTL expiry', () => {
    it('returns null after session TTL expires', () => {
      vi.useFakeTimers();
      const cache = new SessionCache({ sessionTtlMs: 1000, cleanupIntervalMs: 999999 });
      cache.set('s1', makeContext());
      vi.advanceTimersByTime(1001);
      expect(cache.get('s1')).toBeNull();
      cache.stop();
      vi.useRealTimers();
    });

    it('returns context before TTL expires', () => {
      vi.useFakeTimers();
      const cache = new SessionCache({ sessionTtlMs: 5000, cleanupIntervalMs: 999999 });
      cache.set('s1', makeContext());
      vi.advanceTimersByTime(4000);
      expect(cache.get('s1')).not.toBeNull();
      cache.stop();
      vi.useRealTimers();
    });
  });

  describe('size cap', () => {
    it('evicts oldest when maxEntries is reached', () => {
      const cache = new SessionCache({ maxEntries: 3, cleanupIntervalMs: 999999 });
      cache.set('s1', makeContext());
      cache.set('s2', makeContext());
      cache.set('s3', makeContext());
      cache.set('s4', makeContext());   // triggers eviction of s1

      expect(cache.size()).toBe(3);
      expect(cache.get('s1')).toBeNull();
      expect(cache.get('s4')).not.toBeNull();
      cache.stop();
    });
  });

  describe('delete()', () => {
    it('removes a session', () => {
      const cache = new SessionCache({ cleanupIntervalMs: 999999 });
      cache.set('s1', makeContext());
      cache.delete('s1');
      expect(cache.get('s1')).toBeNull();
      cache.stop();
    });

    it('is safe to call for non-existent session', () => {
      const cache = new SessionCache({ cleanupIntervalMs: 999999 });
      expect(() => cache.delete('nonexistent')).not.toThrow();
      cache.stop();
    });
  });

  describe('sweep()', () => {
    it('removes expired entries on sweep', () => {
      vi.useFakeTimers();
      const cache = new SessionCache({ sessionTtlMs: 1000, cleanupIntervalMs: 999999 });
      cache.set('s1', makeContext());
      cache.set('s2', makeContext());
      vi.advanceTimersByTime(1001);
      cache.sweep();
      expect(cache.size()).toBe(0);
      cache.stop();
      vi.useRealTimers();
    });
  });

  describe('stop()', () => {
    it('can be called multiple times without error', () => {
      const cache = new SessionCache({ cleanupIntervalMs: 999999 });
      expect(() => { cache.stop(); cache.stop(); }).not.toThrow();
    });
  });
});
