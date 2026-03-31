// Session Cache — In-memory session store
//
// Shadow Mode Observer writes SessionContext here after each request.
// Dispatcher reads it on every request (hot path — must be O(1)).
//
// TTL-based expiry: sessions inactive longer than sessionTtlMs are pruned.
// Size cap: once maxEntries is reached, oldest entries are evicted.
// Never throws — all methods are safe to call from the hot path.

import type { SessionContext } from '../types';

// ─── Configuration ─────────────────────────────────────────────────────────────

export interface SessionCacheConfig {
  /** Max sessions to hold in memory. Default: 10_000 */
  maxEntries?: number;
  /** How long (ms) an inactive session is kept. Default: 30 min */
  sessionTtlMs?: number;
  /** How often (ms) the TTL cleanup sweep runs. Default: 60_000 */
  cleanupIntervalMs?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1_000;   // 30 minutes
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;         // 1 minute

// ─── Internal entry ───────────────────────────────────────────────────────────

interface CacheEntry {
  context: SessionContext;
  lastSeenAt: number;
}

// ─── SessionCache ─────────────────────────────────────────────────────────────

export class SessionCache {
  private readonly maxEntries: number;
  private readonly sessionTtlMs: number;
  private readonly store = new Map<string, CacheEntry>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: SessionCacheConfig = {}) {
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;

    const cleanupMs = config.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.cleanupInterval = setInterval(() => {
      try { this.sweep(); } catch { /* never propagate */ }
    }, cleanupMs);

    if (typeof this.cleanupInterval.unref === 'function') {
      this.cleanupInterval.unref();
    }
  }

  // ─── Hot-path reads ───────────────────────────────────────────────────────────

  /**
   * Get session context for the given hashed session ID.
   * Returns null if not found or expired.
   * O(1) Map lookup — safe on the hot path.
   */
  get(hashedSessionId: string): SessionContext | null {
    const entry = this.store.get(hashedSessionId);
    if (!entry) return null;

    if (Date.now() - entry.lastSeenAt > this.sessionTtlMs) {
      this.store.delete(hashedSessionId);
      return null;
    }

    return entry.context;
  }

  // ─── Background writes ────────────────────────────────────────────────────────

  /**
   * Write or update session context.
   * Called by Shadow Mode Observer after each observed request.
   * Evicts oldest entry if at capacity.
   */
  set(hashedSessionId: string, context: SessionContext): void {
    if (!this.store.has(hashedSessionId) && this.store.size >= this.maxEntries) {
      this.evictOldest();
    }

    this.store.set(hashedSessionId, { context, lastSeenAt: Date.now() });
  }

  /**
   * Remove a specific session from the cache.
   */
  delete(hashedSessionId: string): void {
    this.store.delete(hashedSessionId);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  /** Stop the background cleanup interval. Call on shutdown. */
  stop(): void {
    if (this.cleanupInterval !== null) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  // ─── Observability ────────────────────────────────────────────────────────────

  /** Current number of cached sessions. */
  size(): number {
    return this.store.size;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────────

  /** Remove all entries older than sessionTtlMs. */
  sweep(): void {
    const cutoff = Date.now() - this.sessionTtlMs;
    for (const [key, entry] of this.store) {
      if (entry.lastSeenAt < cutoff) {
        this.store.delete(key);
      }
    }
  }

  /** Evict the single oldest entry to make room for a new one. */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.store) {
      if (entry.lastSeenAt < oldestTime) {
        oldestTime = entry.lastSeenAt;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.store.delete(oldestKey);
    }
  }
}
