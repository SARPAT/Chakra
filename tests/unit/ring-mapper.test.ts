import { RingMapper } from '../../src/core/ring-mapper';
import type { RingMapConfig, BlockDefinition } from '../../src/types';

// --- Helpers ---

const ecommerceConfig: RingMapConfig = {
  blocks: {
    'payment-block': {
      endpoints: ['POST /api/payment/process', 'POST /api/payment/refund'],
      minLevel: 0,
      weightBase: 95,
      whenSuspended: { responseType: '503' },
    },
    'cart-block': {
      endpoints: ['POST /api/cart', 'GET /api/cart', 'DELETE /api/cart/item/:id'],
      minLevel: 1,
      weightBase: 70,
      whenSuspended: { responseType: 'static', staticResponse: '{"error":"Service temporarily limited"}' },
    },
    'browse-block': {
      endpoints: ['GET /api/products', 'GET /api/products/:id', 'GET /api/search'],
      minLevel: 2,
      weightBase: 40,
      whenSuspended: { responseType: 'cached', cacheMaxAgeSeconds: 300 },
    },
    'recommendations-block': {
      endpoints: ['GET /api/recommendations/*'],
      minLevel: 3,
      weightBase: 10,
      whenSuspended: { responseType: 'empty' },
    },
  },
};

function createMapper(config?: RingMapConfig): RingMapper {
  return new RingMapper(config ?? ecommerceConfig);
}

// ===================================================================
// Exact match lookup
// ===================================================================

describe('exact match lookup', () => {
  it('matches a registered exact route', () => {
    const mapper = createMapper();
    const info = mapper.lookup('POST', '/api/payment/process');
    expect(info.block).toBe('payment-block');
    expect(info.minLevel).toBe(0);
    expect(info.weightBase).toBe(95);
  });

  it('matches multiple exact routes in same block', () => {
    const mapper = createMapper();
    expect(mapper.lookup('POST', '/api/payment/refund').block).toBe('payment-block');
  });

  it('matches exact routes across blocks', () => {
    const mapper = createMapper();
    expect(mapper.lookup('GET', '/api/cart').block).toBe('cart-block');
    expect(mapper.lookup('GET', '/api/search').block).toBe('browse-block');
  });

  it('is case-insensitive on method', () => {
    const mapper = createMapper();
    expect(mapper.lookup('post', '/api/payment/process').block).toBe('payment-block');
    expect(mapper.lookup('Post', '/api/payment/process').block).toBe('payment-block');
  });

  it('strips trailing slash for matching', () => {
    const mapper = createMapper();
    expect(mapper.lookup('GET', '/api/products/').block).toBe('browse-block');
  });
});

// ===================================================================
// Prefix/wildcard match lookup
// ===================================================================

describe('prefix/wildcard match lookup', () => {
  it('matches wildcard routes', () => {
    const mapper = createMapper();
    const info = mapper.lookup('GET', '/api/recommendations/trending');
    expect(info.block).toBe('recommendations-block');
  });

  it('matches nested paths under wildcard', () => {
    const mapper = createMapper();
    const info = mapper.lookup('GET', '/api/recommendations/user/123/items');
    expect(info.block).toBe('recommendations-block');
  });

  it('sorts longest prefix first for correct matching', () => {
    const config: RingMapConfig = {
      blocks: {
        'specific': {
          endpoints: ['GET /api/payment/recurring/*'],
          minLevel: 0,
          weightBase: 90,
        },
        'general': {
          endpoints: ['GET /api/payment/*'],
          minLevel: 1,
          weightBase: 70,
        },
      },
    };
    const mapper = new RingMapper(config);
    expect(mapper.lookup('GET', '/api/payment/recurring/setup').block).toBe('specific');
    expect(mapper.lookup('GET', '/api/payment/one-time').block).toBe('general');
  });
});

// ===================================================================
// Parameterized route lookup
// ===================================================================

describe('parameterized route lookup', () => {
  it('matches :id parameter routes', () => {
    const mapper = createMapper();
    expect(mapper.lookup('GET', '/api/products/123').block).toBe('browse-block');
    expect(mapper.lookup('GET', '/api/products/abc-def').block).toBe('browse-block');
  });

  it('matches DELETE with :id parameter', () => {
    const mapper = createMapper();
    expect(mapper.lookup('DELETE', '/api/cart/item/42').block).toBe('cart-block');
  });

  it('handles multiple parameters', () => {
    const config: RingMapConfig = {
      blocks: {
        'orders': {
          endpoints: ['GET /api/orders/:orderId/items/:itemId'],
          minLevel: 1,
          weightBase: 60,
        },
      },
    };
    const mapper = new RingMapper(config);
    expect(mapper.lookup('GET', '/api/orders/ord-1/items/itm-2').block).toBe('orders');
  });
});

// ===================================================================
// Lookup priority
// ===================================================================

describe('lookup priority', () => {
  it('exact match wins over prefix', () => {
    const config: RingMapConfig = {
      blocks: {
        'exact-block': {
          endpoints: ['GET /api/data/special'],
          minLevel: 0,
          weightBase: 90,
        },
        'prefix-block': {
          endpoints: ['GET /api/data/*'],
          minLevel: 2,
          weightBase: 30,
        },
      },
    };
    const mapper = new RingMapper(config);
    expect(mapper.lookup('GET', '/api/data/special').block).toBe('exact-block');
    expect(mapper.lookup('GET', '/api/data/other').block).toBe('prefix-block');
  });

  it('prefix match wins over parameterized', () => {
    const config: RingMapConfig = {
      blocks: {
        'prefix-block': {
          endpoints: ['GET /api/items/*'],
          minLevel: 1,
          weightBase: 60,
        },
        'param-block': {
          endpoints: ['GET /api/items/:id'],
          minLevel: 2,
          weightBase: 40,
        },
      },
    };
    const mapper = new RingMapper(config);
    // Both could match /api/items/123, but prefix wins
    expect(mapper.lookup('GET', '/api/items/123').block).toBe('prefix-block');
  });

  it('catch-all is used for unmatched routes', () => {
    const mapper = createMapper();
    const info = mapper.lookup('GET', '/totally/unknown/path');
    expect(info.block).toBe('default-block');
  });
});

// ===================================================================
// Catch-all / unmatched endpoint handling
// ===================================================================

describe('catch-all behavior', () => {
  it('default-block mode: unmatched routes get minLevel 0 (never degraded)', () => {
    const mapper = new RingMapper({ blocks: {}, unmatchedEndpointHandling: 'default-block' });
    const info = mapper.lookup('GET', '/unknown');
    expect(info.block).toBe('default-block');
    expect(info.minLevel).toBe(0);
  });

  it('outermost-level mode: unmatched routes get minLevel 3 (lowest priority)', () => {
    const mapper = new RingMapper({ blocks: {}, unmatchedEndpointHandling: 'outermost-level' });
    const info = mapper.lookup('GET', '/unknown');
    expect(info.block).toBe('default-block');
    expect(info.minLevel).toBe(3);
    expect(info.weightBase).toBe(10);
  });

  it('alert-only mode: unmatched routes pass through but are tracked', () => {
    const mapper = new RingMapper({ blocks: {}, unmatchedEndpointHandling: 'alert-only' });
    const info = mapper.lookup('GET', '/unknown');
    expect(info.block).toBe('default-block');
    expect(info.minLevel).toBe(0);
  });
});

// ===================================================================
// Level Map generation
// ===================================================================

describe('level map', () => {
  it('level 0: all blocks active, none suspended', () => {
    const mapper = createMapper();
    expect(mapper.getActiveBlocks(0)).toEqual(expect.arrayContaining([
      'payment-block', 'cart-block', 'browse-block', 'recommendations-block',
    ]));
    expect(mapper.getSuspendedBlocks(0)).toEqual([]);
  });

  it('level 1: recommendations suspended', () => {
    const mapper = createMapper();
    expect(mapper.getSuspendedBlocks(1)).toEqual(['recommendations-block']);
    expect(mapper.getActiveBlocks(1)).toEqual(expect.arrayContaining([
      'payment-block', 'cart-block', 'browse-block',
    ]));
    expect(mapper.getActiveBlocks(1)).not.toContain('recommendations-block');
  });

  it('level 2: browse + recommendations suspended', () => {
    const mapper = createMapper();
    const suspended = mapper.getSuspendedBlocks(2);
    expect(suspended).toContain('browse-block');
    expect(suspended).toContain('recommendations-block');
    expect(suspended).toHaveLength(2);
  });

  it('level 3: only payment active', () => {
    const mapper = createMapper();
    const active = mapper.getActiveBlocks(3);
    expect(active).toEqual(['payment-block']);
    const suspended = mapper.getSuspendedBlocks(3);
    expect(suspended).toHaveLength(3);
  });

  it('getLevelMap returns all 4 levels', () => {
    const mapper = createMapper();
    const levelMap = mapper.getLevelMap();
    expect(levelMap).toHaveLength(4);
    expect(levelMap[0].level).toBe(0);
    expect(levelMap[3].level).toBe(3);
  });
});

// ===================================================================
// getBlockState
// ===================================================================

describe('getBlockState', () => {
  it('payment-block is active at all levels', () => {
    const mapper = createMapper();
    for (let level = 0; level <= 3; level++) {
      const state = mapper.getBlockState('payment-block', level);
      expect(state.isActive).toBe(true);
      expect(state.isSuspended).toBe(false);
    }
  });

  it('recommendations-block suspended at levels 1-3', () => {
    const mapper = createMapper();
    expect(mapper.getBlockState('recommendations-block', 0).isSuspended).toBe(false);
    expect(mapper.getBlockState('recommendations-block', 1).isSuspended).toBe(true);
    expect(mapper.getBlockState('recommendations-block', 2).isSuspended).toBe(true);
    expect(mapper.getBlockState('recommendations-block', 3).isSuspended).toBe(true);
  });

  it('returns frozen BlockState', () => {
    const mapper = createMapper();
    const state = mapper.getBlockState('payment-block', 0);
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('handles unknown block name gracefully', () => {
    const mapper = createMapper();
    const state = mapper.getBlockState('nonexistent', 2);
    expect(state.block).toBe('nonexistent');
    expect(state.isActive).toBe(true); // minLevel defaults to 0
  });
});

// ===================================================================
// Block registration
// ===================================================================

describe('block registration', () => {
  it('registerBlock adds a block', () => {
    const mapper = new RingMapper({ blocks: {} });
    mapper.registerBlock('new-block', {
      endpoints: ['GET /api/new'],
      minLevel: 2,
      weightBase: 40,
    });
    mapper.compile();
    expect(mapper.lookup('GET', '/api/new').block).toBe('new-block');
  });

  it('registerRoute adds a route to existing block', () => {
    const mapper = new RingMapper({ blocks: {} });
    mapper.registerBlock('api-block', {
      endpoints: ['GET /api/a'],
      minLevel: 1,
      weightBase: 50,
    });
    mapper.registerRoute('GET', '/api/b', 'api-block');
    mapper.compile();
    expect(mapper.lookup('GET', '/api/a').block).toBe('api-block');
    expect(mapper.lookup('GET', '/api/b').block).toBe('api-block');
  });

  it('registerRoute creates block if it does not exist', () => {
    const mapper = new RingMapper({ blocks: {} });
    mapper.registerRoute('POST', '/api/data', 'auto-block');
    mapper.compile();
    expect(mapper.lookup('POST', '/api/data').block).toBe('auto-block');
  });
});

// ===================================================================
// Compilation and versioning
// ===================================================================

describe('compilation and versioning', () => {
  it('constructor produces version 1', () => {
    const mapper = createMapper();
    expect(mapper.getVersion()).toBe(1);
  });

  it('compile() increments version', () => {
    const mapper = createMapper();
    expect(mapper.getVersion()).toBe(1);
    mapper.compile();
    expect(mapper.getVersion()).toBe(2);
    mapper.compile();
    expect(mapper.getVersion()).toBe(3);
  });

  it('changes take effect after compile()', () => {
    const mapper = new RingMapper({ blocks: {} });
    mapper.registerBlock('late-block', {
      endpoints: ['GET /api/late'],
      minLevel: 0,
      weightBase: 80,
    });
    // Before compile, the route hits catch-all
    expect(mapper.lookup('GET', '/api/late').block).toBe('default-block');
    mapper.compile();
    // After compile, the route matches
    expect(mapper.lookup('GET', '/api/late').block).toBe('late-block');
  });
});

// ===================================================================
// Rollback
// ===================================================================

describe('rollback', () => {
  it('rollback to previous version restores old lookup behavior', () => {
    const mapper = new RingMapper({
      blocks: {
        'v1-block': { endpoints: ['GET /api/test'], minLevel: 0, weightBase: 50 },
      },
    });
    expect(mapper.getVersion()).toBe(1);

    // Modify and recompile
    mapper.registerBlock('v2-block', {
      endpoints: ['GET /api/new'],
      minLevel: 1,
      weightBase: 40,
    });
    mapper.compile();
    expect(mapper.getVersion()).toBe(2);
    expect(mapper.lookup('GET', '/api/new').block).toBe('v2-block');

    // Rollback to v1
    const success = mapper.rollback(1);
    expect(success).toBe(true);
    expect(mapper.getVersion()).toBe(1);
    // v2 route should now hit catch-all
    expect(mapper.lookup('GET', '/api/new').block).toBe('default-block');
    // v1 route should still work
    expect(mapper.lookup('GET', '/api/test').block).toBe('v1-block');
  });

  it('rollback to nonexistent version returns false', () => {
    const mapper = createMapper();
    expect(mapper.rollback(999)).toBe(false);
  });

  it('rollback restores registry — recompile after rollback uses old blocks', () => {
    const mapper = new RingMapper({
      blocks: { 'v1-block': { endpoints: ['GET /api/v1'], minLevel: 0, weightBase: 50 } },
    });
    // Add a block and recompile to v2
    mapper.registerBlock('v2-block', { endpoints: ['GET /api/v2'], minLevel: 1, weightBase: 40 });
    mapper.compile();
    expect(mapper.lookup('GET', '/api/v2').block).toBe('v2-block');

    // Rollback to v1 — registry should also revert
    mapper.rollback(1);
    // Recompile should produce the v1 registry (no v2-block)
    mapper.compile();
    expect(mapper.lookup('GET', '/api/v1').block).toBe('v1-block');
    expect(mapper.lookup('GET', '/api/v2').block).toBe('default-block');
  });
});

// ===================================================================
// Unmatched endpoint tracking
// ===================================================================

describe('unmatched endpoint tracking', () => {
  it('tracks unmatched endpoints', () => {
    const mapper = createMapper();
    mapper.lookup('GET', '/unknown/a');
    mapper.lookup('GET', '/unknown/a');
    mapper.lookup('GET', '/unknown/b');

    const hits = mapper.getUnmatchedEndpoints();
    expect(hits.get('GET:/unknown/a')).toBe(2);
    expect(hits.get('GET:/unknown/b')).toBe(1);
  });

  it('resetUnmatchedEndpoints clears counts', () => {
    const mapper = createMapper();
    mapper.lookup('GET', '/unknown');
    expect(mapper.getUnmatchedEndpoints().size).toBe(1);
    mapper.resetUnmatchedEndpoints();
    expect(mapper.getUnmatchedEndpoints().size).toBe(0);
  });

  it('returns a copy, not the internal map', () => {
    const mapper = createMapper();
    mapper.lookup('GET', '/unknown');
    const hits = mapper.getUnmatchedEndpoints();
    hits.clear();
    // Internal map should be unaffected
    expect(mapper.getUnmatchedEndpoints().size).toBe(1);
  });

  it('outermost-level mode does not track unmatched', () => {
    const mapper = new RingMapper({ blocks: {}, unmatchedEndpointHandling: 'outermost-level' });
    mapper.lookup('GET', '/unknown');
    expect(mapper.getUnmatchedEndpoints().size).toBe(0);
  });
});

// ===================================================================
// Validation errors
// ===================================================================

describe('validation', () => {
  it('constructor silently recovers from invalid config (CHAKRA Rule #1)', () => {
    // Must not throw — falls back to empty catch-all-only map
    const mapper = new RingMapper({
      blocks: { 'bad': { endpoints: ['GET /test'], minLevel: 5, weightBase: 50 } },
    });
    expect(mapper.lookup('GET', '/test').block).toBe('default-block');
  });

  it('compile() throws on minLevel out of range', () => {
    const mapper = new RingMapper({ blocks: {} });
    mapper.registerBlock('bad', { endpoints: ['GET /test'], minLevel: 5, weightBase: 50 });
    expect(() => mapper.compile()).toThrow(/minLevel/);
  });

  it('compile() throws on negative minLevel', () => {
    const mapper = new RingMapper({ blocks: {} });
    mapper.registerBlock('bad', { endpoints: ['GET /test'], minLevel: -1, weightBase: 50 });
    expect(() => mapper.compile()).toThrow(/minLevel/);
  });

  it('compile() throws on weightBase out of range', () => {
    const mapper = new RingMapper({ blocks: {} });
    mapper.registerBlock('bad', { endpoints: ['GET /test'], minLevel: 0, weightBase: 150 });
    expect(() => mapper.compile()).toThrow(/weightBase/);
  });

  it('constructor recovers from duplicate endpoints', () => {
    const mapper = new RingMapper({
      blocks: {
        'block-a': { endpoints: ['GET /api/shared'], minLevel: 0, weightBase: 50 },
        'block-b': { endpoints: ['GET /api/shared'], minLevel: 1, weightBase: 40 },
      },
    });
    // Falls back to empty map
    expect(mapper.lookup('GET', '/api/shared').block).toBe('default-block');
  });

  it('compile() throws on duplicate exact endpoints across blocks', () => {
    const mapper = new RingMapper({ blocks: {} });
    mapper.registerBlock('block-a', { endpoints: ['GET /api/shared'], minLevel: 0, weightBase: 50 });
    mapper.registerBlock('block-b', { endpoints: ['GET /api/shared'], minLevel: 1, weightBase: 40 });
    expect(() => mapper.compile()).toThrow(/Duplicate/);
  });

  it('compile() throws on malformed endpoint string', () => {
    const mapper = new RingMapper({ blocks: {} });
    mapper.registerBlock('bad', { endpoints: ['nospace'], minLevel: 0, weightBase: 50 });
    expect(() => mapper.compile()).toThrow(/Invalid endpoint format/);
  });
});

// ===================================================================
// Immutability
// ===================================================================

describe('immutability', () => {
  it('lookup returns frozen RouteInfo', () => {
    const mapper = createMapper();
    const info = mapper.lookup('POST', '/api/payment/process');
    expect(Object.isFrozen(info)).toBe(true);
  });

  it('level map entries are frozen', () => {
    const mapper = createMapper();
    const levelMap = mapper.getLevelMap();
    expect(Object.isFrozen(levelMap)).toBe(true);
    expect(Object.isFrozen(levelMap[0])).toBe(true);
    expect(Object.isFrozen(levelMap[0].activeBlocks)).toBe(true);
  });
});

// ===================================================================
// Error resilience
// ===================================================================

describe('error resilience', () => {
  it('lookup never throws with empty string inputs', () => {
    const mapper = createMapper();
    expect(() => mapper.lookup('', '')).not.toThrow();
    const info = mapper.lookup('', '');
    expect(info.block).toBe('default-block');
  });

  it('constructor with no config produces valid mapper', () => {
    const mapper = new RingMapper();
    const info = mapper.lookup('GET', '/anything');
    expect(info.block).toBe('default-block');
  });

  it('constructor with empty blocks produces valid mapper', () => {
    const mapper = new RingMapper({ blocks: {} });
    expect(mapper.getVersion()).toBe(1);
    expect(mapper.lookup('GET', '/test').block).toBe('default-block');
  });
});

// ===================================================================
// Suspended block config
// ===================================================================

describe('suspended block config', () => {
  it('returns config for blocks with whenSuspended', () => {
    const mapper = createMapper();
    const config = mapper.getSuspendedBlockConfig('payment-block');
    expect(config?.responseType).toBe('503');
  });

  it('returns undefined for blocks without whenSuspended', () => {
    const mapper = new RingMapper({
      blocks: { 'plain': { endpoints: ['GET /test'], minLevel: 0, weightBase: 50 } },
    });
    expect(mapper.getSuspendedBlockConfig('plain')).toBeUndefined();
  });

  it('returns undefined for nonexistent blocks', () => {
    const mapper = createMapper();
    expect(mapper.getSuspendedBlockConfig('nope')).toBeUndefined();
  });
});

// ===================================================================
// Shadow Mode bridge
// ===================================================================

describe('applySuggestion', () => {
  it('compiles and activates the suggestion', () => {
    const mapper = new RingMapper({ blocks: {} });
    const v1 = mapper.getVersion();

    mapper.applySuggestion({
      blocks: {
        'suggested': { endpoints: ['GET /api/suggested'], minLevel: 2, weightBase: 30 },
      },
    });

    expect(mapper.getVersion()).toBeGreaterThan(v1);
    expect(mapper.lookup('GET', '/api/suggested').block).toBe('suggested');
  });
});

// ===================================================================
// Edge cases
// ===================================================================

describe('edge cases', () => {
  it('root path / is handled', () => {
    const config: RingMapConfig = {
      blocks: {
        'root': { endpoints: ['GET /'], minLevel: 0, weightBase: 50 },
      },
    };
    const mapper = new RingMapper(config);
    expect(mapper.lookup('GET', '/').block).toBe('root');
  });

  it('handles paths with many segments', () => {
    const config: RingMapConfig = {
      blocks: {
        'deep': { endpoints: ['GET /a/b/c/d/e/f'], minLevel: 0, weightBase: 50 },
      },
    };
    const mapper = new RingMapper(config);
    expect(mapper.lookup('GET', '/a/b/c/d/e/f').block).toBe('deep');
  });

  it('different methods on same path map to different blocks', () => {
    const config: RingMapConfig = {
      blocks: {
        'get-block': { endpoints: ['GET /api/resource'], minLevel: 0, weightBase: 50 },
        'post-block': { endpoints: ['POST /api/resource'], minLevel: 1, weightBase: 70 },
      },
    };
    const mapper = new RingMapper(config);
    expect(mapper.lookup('GET', '/api/resource').block).toBe('get-block');
    expect(mapper.lookup('POST', '/api/resource').block).toBe('post-block');
  });
});
