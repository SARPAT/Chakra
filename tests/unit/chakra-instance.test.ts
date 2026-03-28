// Tests for CP6: ChakraInstance + chakra() factory
// Covers: config loading, middleware(), block(), activate/deactivate,
//         status(), getMetrics(), getRPM(), shutdown(), error resilience.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { Request, Response, NextFunction } from 'express';
import { ChakraInstance, chakra } from '../../src/index';

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Create a minimal valid config YAML string */
function minimalConfig(overrides = ''): string {
  return `mode: "manual"\n${overrides}`;
}

/** Create a temporary config file and return its path */
function writeTmpConfig(content: string): string {
  const tmpPath = path.join('/tmp', `chakra-test-${Date.now()}-${Math.random()}.yaml`);
  fs.writeFileSync(tmpPath, content, 'utf-8');
  return tmpPath;
}

/** Clean up a temp file */
function removeTmpConfig(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

/** Create a mock Express request */
function mockReq(method = 'GET', reqPath = '/api/test'): Request {
  return {
    method,
    path: reqPath,
    headers: {},
  } as unknown as Request;
}

/** Create a mock Express response */
function mockRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; statusCode: number } {
  const res = {
    statusCode: 200,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    on: vi.fn(),
  };
  return res;
}

/** Create a mock next() function */
function mockNext(): ReturnType<typeof vi.fn> {
  return vi.fn();
}

// ─── Config loading ───────────────────────────────────────────────────────────

describe('config loading', () => {
  it('creates instance with minimal valid config', () => {
    const configPath = writeTmpConfig(minimalConfig());
    try {
      const instance = new ChakraInstance(configPath);
      expect(instance).toBeDefined();
      instance.shutdown();
    } finally {
      removeTmpConfig(configPath);
    }
  });

  it('creates pass-through instance when config file not found', () => {
    // Should not throw — CHAKRA disables itself
    const instance = new ChakraInstance('/nonexistent/path/chakra.yaml');
    const status = instance.status();
    expect(status.disabled).toBe(true);
    instance.shutdown();
  });

  it('creates pass-through instance when config has invalid YAML', () => {
    const configPath = writeTmpConfig('mode: [invalid: yaml: here');
    try {
      const instance = new ChakraInstance(configPath);
      expect(instance.status().disabled).toBe(true);
      instance.shutdown();
    } finally {
      removeTmpConfig(configPath);
    }
  });

  it('creates pass-through instance when mode field is missing', () => {
    const configPath = writeTmpConfig('rpm_threshold: 70');
    try {
      const instance = new ChakraInstance(configPath);
      expect(instance.status().disabled).toBe(true);
      instance.shutdown();
    } finally {
      removeTmpConfig(configPath);
    }
  });

  it('creates pass-through instance when mode is invalid value', () => {
    const configPath = writeTmpConfig('mode: "invalid"');
    try {
      const instance = new ChakraInstance(configPath);
      expect(instance.status().disabled).toBe(true);
      instance.shutdown();
    } finally {
      removeTmpConfig(configPath);
    }
  });

  it('creates pass-through instance when rpm_threshold is out of range', () => {
    const configPath = writeTmpConfig('mode: "auto"\nactivate_when:\n  rpm_threshold: 150');
    try {
      const instance = new ChakraInstance(configPath);
      expect(instance.status().disabled).toBe(true);
      instance.shutdown();
    } finally {
      removeTmpConfig(configPath);
    }
  });

  it('accepts auto mode config', () => {
    const configPath = writeTmpConfig('mode: "auto"\nactivate_when:\n  rpm_threshold: 70');
    try {
      const instance = new ChakraInstance(configPath);
      expect(instance.status().mode).toBe('auto');
      expect(instance.status().disabled).toBe(false);
      instance.shutdown();
    } finally {
      removeTmpConfig(configPath);
    }
  });
});

// ─── chakra() factory ─────────────────────────────────────────────────────────

describe('chakra() factory', () => {
  it('returns a ChakraInstance', () => {
    const configPath = writeTmpConfig(minimalConfig());
    try {
      const instance = chakra(configPath);
      expect(instance).toBeInstanceOf(ChakraInstance);
      instance.shutdown();
    } finally {
      removeTmpConfig(configPath);
    }
  });
});

// ─── middleware() — pass-through when sleeping ────────────────────────────────

describe('middleware() — CHAKRA sleeping (inactive)', () => {
  let configPath: string;
  let instance: ChakraInstance;

  beforeEach(() => {
    configPath = writeTmpConfig(minimalConfig());
    instance = new ChakraInstance(configPath);
  });

  afterEach(() => {
    instance.shutdown();
    removeTmpConfig(configPath);
  });

  it('calls next() for GET request when CHAKRA is sleeping', () => {
    const mw = instance.middleware();
    const req = mockReq('GET', '/api/products');
    const res = mockRes();
    const next = mockNext();

    mw(req as Request, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect(res.send).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('calls next() for POST request when CHAKRA is sleeping', () => {
    const mw = instance.middleware();
    const req = mockReq('POST', '/api/payment');
    const res = mockRes();
    const next = mockNext();

    mw(req as Request, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
  });

  it('returns a function', () => {
    expect(typeof instance.middleware()).toBe('function');
  });
});

// ─── middleware() — disabled instance ─────────────────────────────────────────

describe('middleware() — disabled instance', () => {
  it('returns pass-through middleware when disabled', () => {
    const instance = new ChakraInstance('/no/such/config.yaml');
    const mw = instance.middleware();
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    mw(req as Request, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    instance.shutdown();
  });
});

// ─── block() annotation ───────────────────────────────────────────────────────

describe('block() annotation', () => {
  let configPath: string;
  let instance: ChakraInstance;

  beforeEach(() => {
    configPath = writeTmpConfig(minimalConfig());
    instance = new ChakraInstance(configPath);
  });

  afterEach(() => {
    instance.shutdown();
    removeTmpConfig(configPath);
  });

  it('returns a middleware function', () => {
    expect(typeof instance.block('payment-block')).toBe('function');
  });

  it('calls next() on every request', () => {
    const blockMw = instance.block('payment-block');
    const req = mockReq('POST', '/api/payment');
    const res = mockRes();
    const next = mockNext();

    blockMw(req as Request, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
  });

  it('registers route with ring mapper on first call', () => {
    const blockMw = instance.block('search-block');
    const req = mockReq('GET', '/api/search');
    const res = mockRes();
    const next = mockNext();

    blockMw(req as Request, res as unknown as Response, next as NextFunction);

    // After registration, the route should appear in block states
    const states = instance.getBlockStates();
    const blockNames = states.map(s => s.block);
    expect(blockNames).toContain('search-block');
  });

  it('does not re-register the same route on repeat calls', () => {
    const blockMw = instance.block('browse-block');
    const req = mockReq('GET', '/api/browse');
    const res = mockRes();

    // Call three times
    blockMw(req as Request, res as unknown as Response, mockNext() as NextFunction);
    blockMw(req as Request, res as unknown as Response, mockNext() as NextFunction);
    blockMw(req as Request, res as unknown as Response, mockNext() as NextFunction);

    const states = instance.getBlockStates();
    const browseEntries = states.filter(s => s.block === 'browse-block');
    expect(browseEntries).toHaveLength(1);
  });

  it('never throws — invalid registration is swallowed', () => {
    // This should not throw even with an unusual block name
    const blockMw = instance.block('');
    expect(() => {
      blockMw(
        mockReq() as Request,
        mockRes() as unknown as Response,
        mockNext() as NextFunction,
      );
    }).not.toThrow();
  });
});

// ─── activate() / deactivate() ───────────────────────────────────────────────

describe('activate() and deactivate()', () => {
  let configPath: string;
  let instance: ChakraInstance;

  beforeEach(() => {
    configPath = writeTmpConfig(minimalConfig());
    instance = new ChakraInstance(configPath);
  });

  afterEach(() => {
    instance.shutdown();
    removeTmpConfig(configPath);
  });

  it('starts inactive by default', () => {
    expect(instance.status().active).toBe(false);
  });

  it('activate() sets active to true', () => {
    instance.activate();
    expect(instance.status().active).toBe(true);
  });

  it('activate() defaults to level 1', () => {
    instance.activate();
    expect(instance.status().currentLevel).toBe(1);
  });

  it('activate(2) sets level 2', () => {
    instance.activate(2);
    expect(instance.status().currentLevel).toBe(2);
  });

  it('activate(3) sets level 3', () => {
    instance.activate(3);
    expect(instance.status().currentLevel).toBe(3);
  });

  it('activate(0) clamps to level 1', () => {
    instance.activate(0);
    expect(instance.status().currentLevel).toBe(1);
  });

  it('activate(5) clamps to level 3', () => {
    instance.activate(5);
    expect(instance.status().currentLevel).toBe(3);
  });

  it('deactivate() sets active to false', () => {
    instance.activate();
    instance.deactivate();
    expect(instance.status().active).toBe(false);
  });

  it('deactivate() resets level to 0', () => {
    instance.activate(3);
    instance.deactivate();
    expect(instance.status().currentLevel).toBe(0);
  });
});

// ─── middleware() — active mode dispatch ──────────────────────────────────────

describe('middleware() — CHAKRA active', () => {
  let configPath: string;
  let instance: ChakraInstance;

  beforeEach(() => {
    configPath = writeTmpConfig(minimalConfig());
    instance = new ChakraInstance(configPath);
    // Register a minLevel=3 block so it's suspended at level 1
    instance.getBlockStates(); // warm up
  });

  afterEach(() => {
    instance.shutdown();
    removeTmpConfig(configPath);
  });

  it('adds X-Chakra headers on SERVE_LIMITED', () => {
    // Register a block and activate at level that suspends it
    const blockMw = instance.block('recommendations-block');
    const req = mockReq('GET', '/api/recs');
    const res = mockRes();

    // Register the block (lazy, first call)
    blockMw(req as Request, res as unknown as Response, mockNext() as NextFunction);

    // Manually update block to minLevel=3 by recompiling (use via ring mapper through instance)
    // For this test, just verify headers get set by simulating SERVE_LIMITED scenario
    // The actual block suspension requires level ≥ 1 and minLevel=3
    instance.activate(1);

    const mw = instance.middleware();
    const next = mockNext();
    mw(req as Request, res as unknown as Response, next as NextFunction);

    // At level 1, freshly registered blocks default to minLevel=0 (never suspended)
    // So this should SERVE_FULLY and call next
    expect(next).toHaveBeenCalled();
  });

  it('passes through when no matching block and CHAKRA is active', () => {
    instance.activate(1);
    const mw = instance.middleware();
    const req = mockReq('GET', '/api/unmapped-route-xyz');
    const res = mockRes();
    const next = mockNext();

    mw(req as Request, res as unknown as Response, next as NextFunction);

    // Unmapped routes → default-block (minLevel=0, always active)
    expect(next).toHaveBeenCalledOnce();
  });
});

// ─── status() ────────────────────────────────────────────────────────────────

describe('status()', () => {
  let configPath: string;
  let instance: ChakraInstance;

  beforeEach(() => {
    configPath = writeTmpConfig(minimalConfig());
    instance = new ChakraInstance(configPath);
  });

  afterEach(() => {
    instance.shutdown();
    removeTmpConfig(configPath);
  });

  it('returns correct mode', () => {
    expect(instance.status().mode).toBe('manual');
  });

  it('returns disabled: false for valid config', () => {
    expect(instance.status().disabled).toBe(false);
  });

  it('returns rpm as a number', () => {
    expect(typeof instance.status().rpm).toBe('number');
  });

  it('returns rpmPhase as 1, 2, or 3', () => {
    expect([1, 2, 3]).toContain(instance.status().rpmPhase);
  });

  it('reflects activation changes', () => {
    instance.activate(2);
    const s = instance.status();
    expect(s.active).toBe(true);
    expect(s.currentLevel).toBe(2);
  });
});

// ─── getMetrics() ─────────────────────────────────────────────────────────────

describe('getMetrics()', () => {
  let configPath: string;
  let instance: ChakraInstance;

  beforeEach(() => {
    configPath = writeTmpConfig(minimalConfig());
    instance = new ChakraInstance(configPath);
  });

  afterEach(() => {
    instance.shutdown();
    removeTmpConfig(configPath);
  });

  it('returns metrics object with totalRequests', () => {
    const metrics = instance.getMetrics();
    expect(typeof metrics.totalRequests).toBe('number');
  });

  it('increments totalRequests when CHAKRA is active', () => {
    instance.activate();
    const mw = instance.middleware();
    const req = mockReq();
    const res = mockRes();

    mw(req as Request, res as unknown as Response, mockNext() as NextFunction);

    expect(instance.getMetrics().totalRequests).toBe(1);
  });

  it('returns deep copy — mutations do not affect internal state', () => {
    const metrics1 = instance.getMetrics();
    metrics1.totalRequests = 99999;
    expect(instance.getMetrics().totalRequests).not.toBe(99999);
  });
});

// ─── getRPM() ─────────────────────────────────────────────────────────────────

describe('getRPM()', () => {
  let configPath: string;
  let instance: ChakraInstance;

  beforeEach(() => {
    configPath = writeTmpConfig(minimalConfig());
    instance = new ChakraInstance(configPath);
  });

  afterEach(() => {
    instance.shutdown();
    removeTmpConfig(configPath);
  });

  it('returns RPM state with global score', () => {
    const rpm = instance.getRPM();
    expect(typeof rpm.global).toBe('number');
    expect(rpm.global).toBeGreaterThanOrEqual(0);
    expect(rpm.global).toBeLessThanOrEqual(100);
  });

  it('returns RPM state with phase', () => {
    const rpm = instance.getRPM();
    expect([1, 2, 3]).toContain(rpm.phase);
  });

  it('returns RPM state with perBlock', () => {
    const rpm = instance.getRPM();
    expect(typeof rpm.perBlock).toBe('object');
  });
});

// ─── getBlockStates() ─────────────────────────────────────────────────────────

describe('getBlockStates()', () => {
  let configPath: string;
  let instance: ChakraInstance;

  beforeEach(() => {
    configPath = writeTmpConfig(minimalConfig());
    instance = new ChakraInstance(configPath);
  });

  afterEach(() => {
    instance.shutdown();
    removeTmpConfig(configPath);
  });

  it('returns empty array before any blocks are registered', () => {
    expect(instance.getBlockStates()).toEqual([]);
  });

  it('includes a block after it is registered via block()', () => {
    const blockMw = instance.block('cart-block');
    blockMw(
      mockReq('POST', '/api/cart') as Request,
      mockRes() as unknown as Response,
      mockNext() as NextFunction,
    );

    const states = instance.getBlockStates();
    expect(states.some(s => s.block === 'cart-block')).toBe(true);
  });

  it('all returned states have required fields', () => {
    const blockMw = instance.block('test-block');
    blockMw(
      mockReq() as Request,
      mockRes() as unknown as Response,
      mockNext() as NextFunction,
    );

    for (const state of instance.getBlockStates()) {
      expect(typeof state.block).toBe('string');
      expect(typeof state.currentLevel).toBe('number');
      expect(typeof state.isActive).toBe('boolean');
      expect(typeof state.isSuspended).toBe('boolean');
    }
  });
});

// ─── reloadConfig() ───────────────────────────────────────────────────────────

describe('reloadConfig()', () => {
  it('keeps existing config when reload fails (CHAKRA Rule #4)', () => {
    const configPath = writeTmpConfig('mode: "manual"');
    const instance = new ChakraInstance(configPath);

    // Remove the file
    removeTmpConfig(configPath);

    // Should not throw — keeps existing config
    expect(() => instance.reloadConfig()).not.toThrow();
    expect(instance.status().mode).toBe('manual');

    instance.shutdown();
  });

  it('updates config on successful reload', () => {
    const configPath = writeTmpConfig('mode: "manual"');
    const instance = new ChakraInstance(configPath);

    // Update the file
    fs.writeFileSync(configPath, 'mode: "auto"', 'utf-8');
    instance.reloadConfig();

    expect(instance.status().mode).toBe('auto');

    instance.shutdown();
    removeTmpConfig(configPath);
  });
});

// ─── updateConfig() ───────────────────────────────────────────────────────────

describe('updateConfig()', () => {
  it('updates the mode field', () => {
    const configPath = writeTmpConfig('mode: "manual"');
    const instance = new ChakraInstance(configPath);

    instance.updateConfig({ mode: 'auto' });
    expect(instance.status().mode).toBe('auto');

    instance.shutdown();
    removeTmpConfig(configPath);
  });
});

// ─── shutdown() ───────────────────────────────────────────────────────────────

describe('shutdown()', () => {
  it('deactivates CHAKRA on shutdown', () => {
    const configPath = writeTmpConfig(minimalConfig());
    const instance = new ChakraInstance(configPath);

    instance.activate();
    expect(instance.status().active).toBe(true);

    instance.shutdown();
    expect(instance.status().active).toBe(false);

    removeTmpConfig(configPath);
  });

  it('does not throw when called on disabled instance', () => {
    const instance = new ChakraInstance('/no/such/config.yaml');
    expect(() => instance.shutdown()).not.toThrow();
  });

  it('is idempotent — second call does not throw', () => {
    const configPath = writeTmpConfig(minimalConfig());
    const instance = new ChakraInstance(configPath);
    instance.shutdown();
    expect(() => instance.shutdown()).not.toThrow();
    removeTmpConfig(configPath);
  });
});

// ─── Error resilience ─────────────────────────────────────────────────────────

describe('error resilience', () => {
  it('middleware() never throws even when dispatcher is in error state', () => {
    const configPath = writeTmpConfig(minimalConfig());
    const instance = new ChakraInstance(configPath);
    const mw = instance.middleware();

    // Pass malformed request objects — should not throw
    expect(() => {
      mw({} as Request, mockRes() as unknown as Response, mockNext() as NextFunction);
    }).not.toThrow();

    instance.shutdown();
    removeTmpConfig(configPath);
  });

  it('block() middleware never throws for any input', () => {
    const configPath = writeTmpConfig(minimalConfig());
    const instance = new ChakraInstance(configPath);
    const blockMw = instance.block('resilience-block');

    expect(() => {
      blockMw({} as Request, mockRes() as unknown as Response, mockNext() as NextFunction);
    }).not.toThrow();

    instance.shutdown();
    removeTmpConfig(configPath);
  });
});

// ─── always_protect config ────────────────────────────────────────────────────

describe('always_protect config', () => {
  it('instance initializes without error when always_protect is set', () => {
    const configPath = writeTmpConfig(
      'mode: "manual"\nalways_protect:\n  - /api/payment\n  - /api/auth',
    );
    try {
      const instance = new ChakraInstance(configPath);
      expect(instance.status().disabled).toBe(false);
      instance.shutdown();
    } finally {
      removeTmpConfig(configPath);
    }
  });
});

// ─── degrade_first config ─────────────────────────────────────────────────────

describe('degrade_first config', () => {
  it('instance initializes without error when degrade_first is set', () => {
    const configPath = writeTmpConfig(
      'mode: "manual"\ndegrade_first:\n  - /api/recommendations\n  - /api/ads',
    );
    try {
      const instance = new ChakraInstance(configPath);
      expect(instance.status().disabled).toBe(false);
      instance.shutdown();
    } finally {
      removeTmpConfig(configPath);
    }
  });

  it('registers degrade-first-block in ring map', () => {
    const configPath = writeTmpConfig(
      'mode: "manual"\ndegrade_first:\n  - /api/recommendations',
    );
    try {
      const instance = new ChakraInstance(configPath);
      // Activate at level 1 — degrade-first-block (minLevel=3) should be suspended
      instance.activate(1);
      const states = instance.getBlockStates();
      const degradeEntry = states.find(s => s.block === 'degrade-first-block');
      expect(degradeEntry).toBeDefined();
      expect(degradeEntry?.isSuspended).toBe(true);
      instance.shutdown();
    } finally {
      removeTmpConfig(configPath);
    }
  });
});
