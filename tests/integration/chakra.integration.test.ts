// CHAKRA Integration Tests
//
// Boots the full CHAKRA stack against a real Express app.
// Sends actual HTTP requests through supertest.
// No mocks for CHAKRA internals — tests the real system end-to-end.

import express from 'express';
import request from 'supertest';
import { chakra, type ChakraInstance } from '../../src/index';
import type { SessionContext } from '../../src/types';
import type { PolicyRule } from '../../src/core/policy-engine';
import type { RingMapper } from '../../src/core/ring-mapper';

// ─── Test config path ─────────────────────────────────────────────────────────

const CONFIG_PATH = './chakra.config.yaml';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    callCount: 1,
    hasCartItems: false,
    cartItemCount: 0,
    matchesMomentOfValue: false,
    momentOfValueStrength: 'none',
    recentEndpoints: [],
    userTier: null,
    sessionAgeSeconds: 60,
    lastSeenTime: Date.now(),
    ...overrides,
  };
}

/** Inject session into session cache using raw session ID (matches X-Session-ID header) */
function injectSession(
  instance: ChakraInstance,
  sessionId: string,
  context: SessionContext,
): void {
  (instance as any).sessionCache.set(sessionId, context);
}

/** Clear all sessions from the session cache */
function clearSessions(instance: ChakraInstance): void {
  const store: Map<string, unknown> = (instance as any).sessionCache.store;
  store.clear();
}

/** Set policy rules on the policy engine */
function setPolicyRules(instance: ChakraInstance, rules: PolicyRule[]): void {
  (instance as any).policyEngine.updateRules(rules);
}

/** Reset policy rules to empty */
function clearPolicies(instance: ChakraInstance): void {
  (instance as any).policyEngine.updateRules([]);
}

/**
 * Pre-register test blocks with correct minLevel + weightBase.
 * Must be called before blocks are needed in tests.
 * Uses applySuggestion so the ring map compiles atomically.
 */
function setupTestBlocks(instance: ChakraInstance): void {
  const rm = (instance as any).ringMapper as RingMapper;
  rm.applySuggestion({
    blocks: {
      'browse-block': {
        endpoints: ['GET /api/products'],
        minLevel: 2,
        weightBase: 30,
      },
      'recs-block': {
        endpoints: ['GET /api/recommendations'],
        minLevel: 3,
        weightBase: 10,
      },
      'cart-block': {
        endpoints: ['POST /api/cart/add'],
        minLevel: 1,
        weightBase: 60,
      },
      'payment-block': {
        endpoints: ['POST /api/checkout', 'POST /api/payment/process'],
        minLevel: 0,
        weightBase: 90,
      },
    },
  });
}

/** Create the test Express app with handler-call tracking */
function createTestApp(instance: ChakraInstance): {
  app: express.Application;
  calls: Record<string, number>;
} {
  const app = express();
  const calls: Record<string, number> = {};

  app.use(instance.middleware());

  const handler =
    (key: string) =>
    (_req: express.Request, res: express.Response): void => {
      calls[key] = (calls[key] ?? 0) + 1;
      res.json({ endpoint: key, served: true });
    };

  app.get('/api/products', handler('/api/products'));
  app.get('/api/recommendations', handler('/api/recommendations'));
  app.post('/api/cart/add', handler('/api/cart/add'));
  app.post('/api/checkout', handler('/api/checkout'));
  app.post('/api/payment/process', handler('/api/payment/process'));
  app.get('/api/unknown-endpoint', handler('/api/unknown-endpoint'));

  return { app, calls };
}

// ─── Shared state ─────────────────────────────────────────────────────────────

let instance: ChakraInstance;
let app: express.Application;
let calls: Record<string, number>;

beforeAll(() => {
  instance = chakra(CONFIG_PATH);
  setupTestBlocks(instance);
  ({ app, calls } = createTestApp(instance));
});

afterAll(() => {
  instance.shutdown();
});

beforeEach(() => {
  // Reset CHAKRA to sleeping state before each test
  instance.deactivate();
  clearSessions(instance);
  clearPolicies(instance);
  // Reset handler call counters
  for (const key of Object.keys(calls)) delete calls[key];
});

// ─── Scenario 1: Pass-through when sleeping ───────────────────────────────────

describe('Scenario 1 — pass-through when sleeping', () => {
  it('all routes return 200 with served:true when CHAKRA is sleeping', async () => {
    expect(instance.status().active).toBe(false);

    const endpoints: Array<{ method: 'get' | 'post'; path: string }> = [
      { method: 'get', path: '/api/products' },
      { method: 'get', path: '/api/recommendations' },
      { method: 'post', path: '/api/cart/add' },
      { method: 'post', path: '/api/checkout' },
      { method: 'post', path: '/api/payment/process' },
    ];

    for (const { method, path } of endpoints) {
      const res = await request(app)[method](path);
      expect(res.status).toBe(200);
      expect(res.body.served).toBe(true);
      expect(res.headers['x-chakra-mode']).toBeUndefined();
      expect(res.headers['x-chakra-suspended']).toBeUndefined();
    }
  });

  it('adds under 5ms latency per request when sleeping', async () => {
    const ITERATIONS = 20;
    const latencies: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = Date.now();
      await request(app).get('/api/products');
      latencies.push(Date.now() - t0);
    }

    // Remove top 2 outliers (first request + one random spike)
    latencies.sort((a, b) => a - b);
    const trimmed = latencies.slice(0, -2);
    const avg = trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
    expect(avg).toBeLessThan(5);
  });
});

// ─── Scenario 2: Manual activation ───────────────────────────────────────────

describe('Scenario 2 — manual activation', () => {
  it('marks CHAKRA as active after activate()', () => {
    instance.activate(1, 'integration-test');
    expect(instance.status().active).toBe(true);
    expect(instance.status().currentLevel).toBe(1);
  });

  it('records activation in audit log', () => {
    instance.activate(1, 'integration-test');
    const log = instance.getActivationLog();
    expect(log.length).toBeGreaterThan(0);

    const entry = log[log.length - 1];
    expect(entry.kind).toBe('activated');
    expect(entry.level).toBe(1);
    expect(entry.timestamp).toBeGreaterThan(0);
    expect(entry.rpmAtEvent).toBeGreaterThanOrEqual(0);
  });

  it('status() reflects deactivated after deactivate()', () => {
    instance.activate(2, 'integration-test');
    expect(instance.status().active).toBe(true);
    instance.deactivate();
    expect(instance.status().active).toBe(false);
    expect(instance.status().currentLevel).toBe(0);
  });
});

// ─── Scenario 3: Block suspension under load ─────────────────────────────────

describe('Scenario 3 — block suspension under load', () => {
  it('suspends recs-block at level 2 (minLevel=3: suspended at any active level)', async () => {
    instance.activate(2, 'integration-test');

    const res = await request(app).get('/api/recommendations');

    // Backend handler must NOT have been called
    expect(calls['/api/recommendations']).toBeUndefined();

    // CHAKRA returns its fallback response
    expect(res.headers['x-chakra-suspended']).toBe('recs-block');
    expect(res.headers['x-chakra-active']).toBe('true');
    expect(res.body._chakra_suspended).toBe(true);
  });

  it('suspends browse-block at level 2 (minLevel=2: suspended at levels 2-3)', async () => {
    instance.activate(2, 'integration-test');

    const res = await request(app).get('/api/products');

    // Anonymous request — weight too low to rescue
    expect(calls['/api/products']).toBeUndefined();
    expect(res.headers['x-chakra-suspended']).toBe('browse-block');
  });

  it('does NOT suspend browse-block at level 1 (minLevel=2: safe at level 1)', async () => {
    instance.activate(1, 'integration-test');

    const res = await request(app).get('/api/products');
    expect(res.status).toBe(200);
    expect(res.body.served).toBe(true);
  });
});

// ─── Scenario 4: Payment block always protected ───────────────────────────────

describe('Scenario 4 — payment block always protected', () => {
  it('payment/process passes through at level 3 (minLevel=0: never suspended)', async () => {
    instance.activate(3, 'integration-test');

    const res = await request(app).post('/api/payment/process');
    expect(res.status).toBe(200);
    expect(res.body.served).toBe(true);
    expect(calls['/api/payment/process']).toBe(1);
  });

  it('checkout passes through at level 3', async () => {
    instance.activate(3, 'integration-test');

    const res = await request(app).post('/api/checkout');
    expect(res.status).toBe(200);
    expect(res.body.served).toBe(true);
    expect(calls['/api/checkout']).toBe(1);
  });
});

// ─── Scenario 5: Weight Engine rescue ────────────────────────────────────────

describe('Scenario 5 — Weight Engine rescue', () => {
  it('rescues browse-block for high-value session at level 2', async () => {
    instance.activate(2, 'integration-test');

    const SESSION_ID = 'rich-session-001';
    injectSession(
      instance,
      SESSION_ID,
      makeSession({
        callCount: 8,           // +10 session depth
        hasCartItems: true,
        cartItemCount: 3,       // +25 cart signal
        matchesMomentOfValue: true,
        momentOfValueStrength: 'full',  // +30 MoV
        lastSeenTime: Date.now(),
      }),
    );
    // Weight = 30(base) + 0(GET) + 10(auth proxy) + 10(depth) + 25(cart) + 30(MoV) = 105 → capped 100 → SERVE_FULLY

    const res = await request(app)
      .get('/api/products')
      .set('X-Session-ID', SESSION_ID);

    expect(res.status).toBe(200);
    expect(res.body.served).toBe(true);
    expect(calls['/api/products']).toBe(1);
    expect(res.headers['x-chakra-suspended']).toBeUndefined();
  });
});

// ─── Scenario 6: Anonymous user gets suspended ───────────────────────────────

describe('Scenario 6 — anonymous user suspended', () => {
  it('suspends browse-block for anonymous request at level 2', async () => {
    instance.activate(2, 'integration-test');

    // No session injected, no X-Session-ID header
    const res = await request(app).get('/api/products');

    // Weight = 30(base) + 0(GET) + 0(no session) = 30 → SUSPEND (< 40)
    expect(calls['/api/products']).toBeUndefined();
    expect(res.headers['x-chakra-suspended']).toBe('browse-block');
    expect(res.body._chakra_suspended).toBe(true);
  });
});

// ─── Scenario 7: Policy Engine override ──────────────────────────────────────

describe('Scenario 7 — Policy Engine override', () => {
  it('serves premium users despite suspension via policy rule', async () => {
    instance.activate(3, 'integration-test');

    // Add policy: premium users always served
    setPolicyRules(instance, [
      {
        name: 'premium-serve-fully',
        priority: 100,
        if: { user_tier: 'premium' },
        then: { action: 'serve_fully' },
      },
    ]);

    const SESSION_ID = 'premium-session-001';
    injectSession(
      instance,
      SESSION_ID,
      makeSession({
        userTier: 'premium',
        callCount: 2,
        lastSeenTime: Date.now(),
      }),
    );

    const res = await request(app)
      .get('/api/products')
      .set('X-Session-ID', SESSION_ID);

    expect(res.status).toBe(200);
    expect(res.body.served).toBe(true);
    expect(calls['/api/products']).toBe(1);
  });

  it('non-premium users are still suspended at level 3', async () => {
    instance.activate(3, 'integration-test');

    setPolicyRules(instance, [
      {
        name: 'premium-serve-fully',
        priority: 100,
        if: { user_tier: 'premium' },
        then: { action: 'serve_fully' },
      },
    ]);

    // No session — standard anonymous user
    const res = await request(app).get('/api/products');
    expect(calls['/api/products']).toBeUndefined();
    expect(res.headers['x-chakra-suspended']).toBe('browse-block');
  });

  it('policy override appears in dispatcher metrics', async () => {
    instance.activate(3, 'integration-test');
    (instance as any).dispatcher.resetMetrics();

    setPolicyRules(instance, [
      {
        name: 'premium-serve-fully',
        priority: 100,
        if: { user_tier: 'premium' },
        then: { action: 'serve_fully' },
      },
    ]);

    const SESSION_ID = 'premium-metrics-session';
    injectSession(
      instance,
      SESSION_ID,
      makeSession({ userTier: 'premium', callCount: 1, lastSeenTime: Date.now() }),
    );

    await request(app)
      .get('/api/products')
      .set('X-Session-ID', SESSION_ID);

    const metrics = instance.getMetrics();
    expect(metrics.policyOverrides).toBe(1);
  });
});

// ─── Scenario 8: Serve Limited with hints ────────────────────────────────────

describe('Scenario 8 — Serve Limited', () => {
  it('returns X-Chakra-Mode: limited for moderate-weight session', async () => {
    instance.activate(2, 'integration-test');

    const SESSION_ID = 'moderate-session-001';
    injectSession(
      instance,
      SESSION_ID,
      makeSession({
        callCount: 4,           // +5 session depth
        hasCartItems: true,
        cartItemCount: 2,       // +15 cart signal
        momentOfValueStrength: 'none',
        lastSeenTime: Date.now(),
      }),
    );
    // Weight = 30(base) + 0(GET) + 10(auth proxy) + 5(depth) + 15(cart) = 60 → SERVE_LIMITED (40-64)

    const res = await request(app)
      .get('/api/products')
      .set('X-Session-ID', SESSION_ID);

    expect(res.status).toBe(200);
    expect(res.body.served).toBe(true);
    expect(res.headers['x-chakra-mode']).toBe('limited');
    expect(res.headers['x-chakra-hint']).toBeDefined();
    expect(calls['/api/products']).toBe(1);
  });
});

// ─── Scenario 9: Gradual deactivation ────────────────────────────────────────

describe('Scenario 9 — gradual deactivation', () => {
  it('restores level by level and records audit log entries', () => {
    vi.useFakeTimers();
    try {
      instance.activate(2, 'integration-test');
      expect(instance.status().active).toBe(true);
      expect(instance.status().currentLevel).toBe(2);

      instance.initiateSleep('gradual', 'integration-test');

      // Immediately after initiating: still active, restoration in progress
      const ac = (instance as any).activationController;
      expect(ac.isRestoring()).toBe(true);

      const logAfterSleep = instance.getActivationLog();
      const sleepEntry = logAfterSleep[logAfterSleep.length - 1];
      expect(sleepEntry.kind).toBe('sleep_initiated');
      expect(sleepEntry.initiatedBy).toBe('integration-test');

      // Advance past the restore step interval (default 30s)
      vi.advanceTimersByTime(31_000);

      // Level should step down: 2 → 1
      expect(instance.status().currentLevel).toBe(1);
      expect(instance.status().active).toBe(true);

      // Advance past another step
      vi.advanceTimersByTime(31_000);

      // Level 1 → 0 → fully restored
      expect(instance.status().active).toBe(false);
      expect(instance.status().currentLevel).toBe(0);

      // Audit log must contain restore_step and fully_restored entries
      const finalLog = instance.getActivationLog();
      const kinds = finalLog.map((e) => e.kind);
      expect(kinds).toContain('restore_step');
      expect(kinds).toContain('fully_restored');
    } finally {
      vi.useRealTimers();
    }
  });

  it('immediate deactivation snaps to inactive in one call', () => {
    instance.activate(3, 'integration-test');
    expect(instance.status().active).toBe(true);

    instance.deactivate();
    expect(instance.status().active).toBe(false);
    expect(instance.status().currentLevel).toBe(0);

    // Audit log reflects deactivation
    const log = instance.getActivationLog();
    const lastEntry = log[log.length - 1];
    expect(['sleep_initiated', 'fully_restored']).toContain(lastEntry.kind);
  });
});

// ─── Scenario 10: Unmatched endpoint ─────────────────────────────────────────

describe('Scenario 10 — unmatched endpoint', () => {
  it('passes through unknown routes at level 3 (default-block, minLevel=0)', async () => {
    instance.activate(3, 'integration-test');

    const res = await request(app).get('/api/unknown-endpoint');
    expect(res.status).toBe(200);
    expect(res.body.served).toBe(true);
    expect(calls['/api/unknown-endpoint']).toBe(1);
    expect(res.headers['x-chakra-suspended']).toBeUndefined();
  });
});

// ─── Performance check ────────────────────────────────────────────────────────

describe('Performance — hot path latency budget', () => {
  const ITERATIONS = 20;

  async function measureAvgLatency(fn: () => Promise<void>): Promise<number> {
    const latencies: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = Date.now();
      await fn();
      latencies.push(Date.now() - t0);
    }
    // Drop top 2 outliers before averaging
    latencies.sort((a, b) => a - b);
    const trimmed = latencies.slice(0, -2);
    return trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
  }

  it('sleeping mode adds under 1ms average latency', async () => {
    expect(instance.status().active).toBe(false);
    const avg = await measureAvgLatency(() =>
      request(app).post('/api/checkout').then(() => {}),
    );
    console.log(`[Perf] Sleeping mode avg latency: ${avg.toFixed(2)}ms`);
    expect(avg).toBeLessThan(1);
  });

  it('active + SERVE_FULLY adds under 3ms average latency', async () => {
    instance.activate(1, 'integration-test');
    // At level 1: payment-block never suspended
    const avg = await measureAvgLatency(() =>
      request(app).post('/api/payment/process').then(() => {}),
    );
    console.log(`[Perf] Active SERVE_FULLY avg latency: ${avg.toFixed(2)}ms`);
    expect(avg).toBeLessThan(3);
  });
});

// ─── Audit log check ─────────────────────────────────────────────────────────

describe('Audit log — entry structure validation', () => {
  it('activation log entry has all required fields', () => {
    instance.activate(2, 'audit-test');
    const log = instance.getActivationLog();
    const entry = log[log.length - 1];

    expect(typeof entry.timestamp).toBe('number');
    expect(entry.timestamp).toBeGreaterThan(0);
    expect(entry.kind).toBe('activated');
    expect(entry.level).toBe(2);
    expect(typeof entry.rpmAtEvent).toBe('number');
    expect(entry.rpmAtEvent).toBeGreaterThanOrEqual(0);
    expect(entry.mode).toBe('manual');
  });

  it('deactivation log entry is recorded', () => {
    instance.activate(1, 'audit-test');
    const countBefore = instance.getActivationLog().length;
    instance.deactivate();
    const countAfter = instance.getActivationLog().length;
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});

// ─── Concurrency check ────────────────────────────────────────────────────────

describe('Concurrency — 50 simultaneous requests', () => {
  it('handles 50 concurrent requests without errors or hangs', async () => {
    instance.activate(1, 'concurrency-test');

    const endpoints: Array<{ method: 'get' | 'post'; path: string }> = [
      { method: 'get', path: '/api/products' },
      { method: 'get', path: '/api/recommendations' },
      { method: 'post', path: '/api/cart/add' },
      { method: 'post', path: '/api/checkout' },
      { method: 'post', path: '/api/payment/process' },
    ];

    const requests = Array.from({ length: 50 }, (_, i) => {
      const { method, path } = endpoints[i % endpoints.length];
      return request(app)[method](path);
    });

    const responses = await Promise.all(requests);

    for (const res of responses) {
      // All responses must be either a valid backend response or a CHAKRA fallback
      // Never a 5xx server error
      expect(res.status).toBeLessThan(500);
      // Response body must be parseable (not empty)
      expect(res.body).toBeDefined();
    }
  }, 10_000); // 10s timeout for concurrent test
});
