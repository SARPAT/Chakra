// DashboardServer unit tests
//
// Tests the HTTP server and WebSocket broadcast behaviour.
// Uses supertest for HTTP requests and the 'ws' library for WebSocket testing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DashboardAPI } from '../../src/dashboard/api';
import { DashboardServer } from '../../src/dashboard/server';
import type { RPMState } from '../../src/types';
import type { ChakraStatus } from '../../src/index';

// ─── Test helpers ──────────────────────────────────────────────────────────────

function makeStatus(active = false): ChakraStatus {
  return { active, mode: 'manual', currentLevel: 0, rpm: 0, rpmPhase: 1, disabled: false };
}

function makeRPMState(rpm = 0): RPMState {
  return { global: rpm, perBlock: {}, updatedAt: Date.now(), phase: 1 };
}

/**
 * Create a mock DashboardAPI with controllable method responses.
 * All methods default to returning safe no-op values.
 */
function makeMockAPI(overrides: Partial<DashboardAPI> = {}): DashboardAPI {
  return {
    status: vi.fn().mockReturnValue(makeStatus()),
    rpm: vi.fn().mockReturnValue({ current: makeRPMState(), history: [] }),
    blocks: vi.fn().mockReturnValue({ blocks: [], perBlockRpm: {} }),
    getPolicies: vi.fn().mockReturnValue({ active: [], suggestions: [] }),
    learning: vi.fn().mockReturnValue({ daysSinceInstall: 0, layers: {}, suggestions: {} }),
    history: vi.fn().mockReturnValue({ activations: [], incidents: [] }),
    report: vi.fn().mockReturnValue(null),
    getConfig: vi.fn().mockReturnValue({ mode: 'manual' }),
    activate: vi.fn(),
    deactivate: vi.fn(),
    createPolicy: vi.fn(),
    updatePolicy: vi.fn(),
    deletePolicy: vi.fn(),
    activatePreset: vi.fn(),
    updateSettings: vi.fn(),
    generateIncidentReport: vi.fn(),
    recordRPMSample: vi.fn(),
    ...overrides,
  } as unknown as DashboardAPI;
}

/** Start a server on a random port and return it + a base URL for requests. */
async function startServer(
  api: DashboardAPI,
  options: { auth?: { username: string; password: string } } = {},
): Promise<{ server: DashboardServer; port: number; baseUrl: string }> {
  const port = 14200 + Math.floor(Math.random() * 1000);
  const server = new DashboardServer({ api, port, ...options });
  server.start();
  // Give the server a tick to bind
  await new Promise(resolve => setTimeout(resolve, 50));
  return { server, port, baseUrl: `http://localhost:${port}` };
}

async function stopServer(server: DashboardServer): Promise<void> {
  server.stop();
  await new Promise(resolve => setTimeout(resolve, 50));
}

async function httpGet(url: string, headers?: Record<string, string>): Promise<Response> {
  return fetch(url, { headers });
}

async function httpPost(url: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ─── GET /api/status ─────────────────────────────────────────────────────────

describe('GET /api/status', () => {
  let server: DashboardServer;
  let baseUrl: string;
  let api: DashboardAPI;

  beforeEach(async () => {
    api = makeMockAPI({ status: vi.fn().mockReturnValue(makeStatus(true)) });
    ({ server, baseUrl } = await startServer(api));
  });

  afterEach(async () => { await stopServer(server); });

  it('returns 200 with current status JSON', async () => {
    const res = await httpGet(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json() as ChakraStatus;
    expect(body.active).toBe(true);
  });

  it('calls api.status() exactly once per request', async () => {
    await httpGet(`${baseUrl}/api/status`);
    expect((api.status as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

// ─── GET /api/rpm ─────────────────────────────────────────────────────────────

describe('GET /api/rpm', () => {
  let server: DashboardServer;
  let baseUrl: string;

  beforeEach(async () => {
    const api = makeMockAPI({
      rpm: vi.fn().mockReturnValue({ current: makeRPMState(55), history: [{ timestamp: 1000, rpm: 55 }] }),
    });
    ({ server, baseUrl } = await startServer(api));
  });

  afterEach(async () => { await stopServer(server); });

  it('returns 200 with current and history fields', async () => {
    const res = await httpGet(`${baseUrl}/api/rpm`);
    expect(res.status).toBe(200);
    const body = await res.json() as { current: RPMState; history: unknown[] };
    expect(body.current.global).toBe(55);
    expect(body.history).toHaveLength(1);
  });
});

// ─── GET /api/blocks ──────────────────────────────────────────────────────────

describe('GET /api/blocks', () => {
  let server: DashboardServer;
  let baseUrl: string;

  beforeEach(async () => {
    const api = makeMockAPI({
      blocks: vi.fn().mockReturnValue({
        blocks: [{ block: 'payment-block', currentLevel: 0, isActive: true, isSuspended: false }],
        perBlockRpm: { 'payment-block': 31 },
      }),
    });
    ({ server, baseUrl } = await startServer(api));
  });

  afterEach(async () => { await stopServer(server); });

  it('returns 200 with blocks and perBlockRpm', async () => {
    const res = await httpGet(`${baseUrl}/api/blocks`);
    expect(res.status).toBe(200);
    const body = await res.json() as { blocks: unknown[]; perBlockRpm: Record<string, number> };
    expect(body.blocks).toHaveLength(1);
    expect(body.perBlockRpm['payment-block']).toBe(31);
  });
});

// ─── GET /api/policies ────────────────────────────────────────────────────────

describe('GET /api/policies', () => {
  let server: DashboardServer;
  let baseUrl: string;

  beforeEach(async () => {
    const api = makeMockAPI({
      getPolicies: vi.fn().mockReturnValue({
        active: [{ name: 'p1', if: {}, then: { action: 'serve_fully' }, priority: 1 }],
        suggestions: [],
      }),
    });
    ({ server, baseUrl } = await startServer(api));
  });

  afterEach(async () => { await stopServer(server); });

  it('returns 200 with active policies', async () => {
    const res = await httpGet(`${baseUrl}/api/policies`);
    expect(res.status).toBe(200);
    const body = await res.json() as { active: unknown[] };
    expect(body.active).toHaveLength(1);
  });
});

// ─── POST /api/activate ───────────────────────────────────────────────────────

describe('POST /api/activate', () => {
  let server: DashboardServer;
  let baseUrl: string;
  let api: DashboardAPI;

  beforeEach(async () => {
    api = makeMockAPI();
    ({ server, baseUrl } = await startServer(api));
  });

  afterEach(async () => { await stopServer(server); });

  it('returns { ok: true } and calls api.activate()', async () => {
    const res = await httpPost(`${baseUrl}/api/activate`, { level: 2, initiatedBy: 'ops@test.com' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect((api.activate as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(2, 'ops@test.com');
  });

  it('works with empty body (no level or initiatedBy)', async () => {
    const res = await httpPost(`${baseUrl}/api/activate`, {});
    expect(res.status).toBe(200);
  });
});

// ─── POST /api/deactivate ─────────────────────────────────────────────────────

describe('POST /api/deactivate', () => {
  let server: DashboardServer;
  let baseUrl: string;
  let api: DashboardAPI;

  beforeEach(async () => {
    api = makeMockAPI();
    ({ server, baseUrl } = await startServer(api));
  });

  afterEach(async () => { await stopServer(server); });

  it('returns { ok: true } and calls api.deactivate()', async () => {
    const res = await httpPost(`${baseUrl}/api/deactivate`, { sequence: 'immediate' });
    expect(res.status).toBe(200);
    expect((api.deactivate as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('immediate', undefined);
  });
});

// ─── POST /api/policies ───────────────────────────────────────────────────────

describe('POST /api/policies', () => {
  let server: DashboardServer;
  let baseUrl: string;
  let api: DashboardAPI;

  beforeEach(async () => {
    api = makeMockAPI();
    ({ server, baseUrl } = await startServer(api));
  });

  afterEach(async () => { await stopServer(server); });

  it('returns 201 when policy created successfully', async () => {
    const rule = { name: 'new-rule', if: {}, then: { action: 'serve_fully' }, priority: 50 };
    const res = await httpPost(`${baseUrl}/api/policies`, rule);
    expect(res.status).toBe(201);
  });

  it('returns 400 when createPolicy throws', async () => {
    (api.createPolicy as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('Policy already exists');
    });
    const res = await httpPost(`${baseUrl}/api/policies`, { name: 'dup' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('already exists');
  });
});

// ─── DELETE /api/policies/:name ───────────────────────────────────────────────

describe('DELETE /api/policies/:name', () => {
  let server: DashboardServer;
  let baseUrl: string;
  let api: DashboardAPI;

  beforeEach(async () => {
    api = makeMockAPI();
    ({ server, baseUrl } = await startServer(api));
  });

  afterEach(async () => { await stopServer(server); });

  it('returns 200 when policy deleted', async () => {
    const res = await fetch(`${baseUrl}/api/policies/my-rule`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((api.deletePolicy as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('my-rule');
  });

  it('returns 404 when deletePolicy throws', async () => {
    (api.deletePolicy as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('Policy not found');
    });
    const res = await fetch(`${baseUrl}/api/policies/ghost`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

// ─── POST /api/presets/:name ──────────────────────────────────────────────────

describe('POST /api/presets/:name', () => {
  let server: DashboardServer;
  let baseUrl: string;
  let api: DashboardAPI;

  beforeEach(async () => {
    api = makeMockAPI();
    ({ server, baseUrl } = await startServer(api));
  });

  afterEach(async () => { await stopServer(server); });

  it('calls activatePreset and returns { ok: true }', async () => {
    const res = await httpPost(`${baseUrl}/api/presets/checkout-only`, {});
    expect(res.status).toBe(200);
    expect((api.activatePreset as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('checkout-only');
  });

  it('returns 400 on unknown preset', async () => {
    (api.activatePreset as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("Unknown preset 'ghost'");
    });
    const res = await httpPost(`${baseUrl}/api/presets/ghost`, {});
    expect(res.status).toBe(400);
  });
});

// ─── GET /api/report/:id ──────────────────────────────────────────────────────

describe('GET /api/report/:id', () => {
  let server: DashboardServer;
  let baseUrl: string;

  afterEach(async () => { await stopServer(server); });

  it('returns 404 when report not found', async () => {
    const api = makeMockAPI({ report: vi.fn().mockReturnValue(null) });
    ({ server, baseUrl } = await startServer(api));
    const res = await httpGet(`${baseUrl}/api/report/incident-999`);
    expect(res.status).toBe(404);
  });

  it('returns 200 with report data when found', async () => {
    const fakeReport = { id: 'incident-1000', startTime: 1000, endTime: 2000 };
    const api = makeMockAPI({ report: vi.fn().mockReturnValue(fakeReport) });
    ({ server, baseUrl } = await startServer(api));
    const res = await httpGet(`${baseUrl}/api/report/incident-1000`);
    expect(res.status).toBe(200);
    const body = await res.json() as typeof fakeReport;
    expect(body.id).toBe('incident-1000');
  });
});

// ─── Basic auth ───────────────────────────────────────────────────────────────

describe('Basic auth middleware', () => {
  let server: DashboardServer;
  let baseUrl: string;

  beforeEach(async () => {
    const api = makeMockAPI();
    ({ server, baseUrl } = await startServer(api, { auth: { username: 'admin', password: 'secret' } }));
  });

  afterEach(async () => { await stopServer(server); });

  it('returns 401 without credentials', async () => {
    const res = await httpGet(`${baseUrl}/api/status`);
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong credentials', async () => {
    const creds = Buffer.from('admin:wrongpass').toString('base64');
    const res = await httpGet(`${baseUrl}/api/status`, { Authorization: `Basic ${creds}` });
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct credentials', async () => {
    const creds = Buffer.from('admin:secret').toString('base64');
    const res = await httpGet(`${baseUrl}/api/status`, { Authorization: `Basic ${creds}` });
    expect(res.status).toBe(200);
  });
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────

describe('DashboardServer lifecycle', () => {
  it('start() is idempotent — calling twice does not throw', async () => {
    const port = 14100 + Math.floor(Math.random() * 100);
    const server = new DashboardServer({ api: makeMockAPI(), port });
    server.start();
    server.start();   // should not throw
    await new Promise(resolve => setTimeout(resolve, 50));
    server.stop();
  });

  it('stop() is safe when server was never started', () => {
    const server = new DashboardServer({ api: makeMockAPI(), port: 14299 });
    expect(() => server.stop()).not.toThrow();
  });

  it('stop() makes the server unreachable', async () => {
    const port = 14050 + Math.floor(Math.random() * 50);
    const server = new DashboardServer({ api: makeMockAPI(), port });
    server.start();
    await new Promise(resolve => setTimeout(resolve, 50));
    server.stop();
    await new Promise(resolve => setTimeout(resolve, 50));
    await expect(httpGet(`http://localhost:${port}/api/status`)).rejects.toThrow();
  });
});

// ─── broadcastRPMUpdate() ─────────────────────────────────────────────────────

describe('DashboardServer.broadcastRPMUpdate()', () => {
  it('calls api.recordRPMSample() with the new state', async () => {
    const api = makeMockAPI();
    const port = 14300 + Math.floor(Math.random() * 100);
    const server = new DashboardServer({ api, port });
    server.start();
    await new Promise(resolve => setTimeout(resolve, 50));

    const state = makeRPMState(77);
    server.broadcastRPMUpdate(state);
    expect((api.recordRPMSample as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(state);

    server.stop();
  });

  it('does not throw when called before start()', () => {
    const api = makeMockAPI();
    const server = new DashboardServer({ api, port: 14399 });
    expect(() => server.broadcastRPMUpdate(makeRPMState(50))).not.toThrow();
  });
});
