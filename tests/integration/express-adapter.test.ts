import express from 'express';
import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expressMiddleware } from '../../src/adapters/express';
import { route } from '../../src/priority';
import type { ChakraOptions } from '../../src/config/schema';
import { harness } from './harness';

function app(options: ChakraOptions = {}) {
  const h = harness(options);
  const a = express();
  a.use((req, _res, next) => {
    (req as { user?: unknown }).user = req.query.plan ? { plan: req.query.plan } : undefined;
    next();
  });
  a.use(expressMiddleware(h.core, h.table));
  a.post('/checkout', route('critical'), (_req, res) => res.json({ ok: true }));
  a.get('/recommendations', route('sheddable'), (req, res) =>
    res.json(
      req.chakra?.degraded ? { items: [] } : { items: [1, 2, 3], priority: req.chakra?.priority },
    ),
  );
  a.get(
    '/search',
    route('sheddable', { fallback: { status: 429, body: 'busy', retryAfterSeconds: 5 } }),
    (_q, s) => s.send('results'),
  );
  a.get('/boom', (_req, res) => res.status(500).end());
  const api = express.Router();
  api.get('/orders/:id', route('high'), (req, res) => res.json({ priority: req.chakra?.priority }));
  api.get('/pinned', route('sheddable'), (req, res) =>
    res.json({ priority: req.chakra?.priority }),
  );
  a.use('/api', api);
  return { app: a, ...h };
}

describe('Express adapter', () => {
  it('sheds sheddable routes with 503 + Retry-After while critical routes succeed', async () => {
    const t = app();
    t.capacity.sheddable = 0;
    const shed = await request(t.app).get('/recommendations');
    expect(shed.status).toBe(503);
    expect(shed.headers['retry-after']).toBe('1');
    expect(shed.body.error).toBe('overloaded');
    expect((await request(t.app).post('/checkout')).body).toEqual({ ok: true });
  });

  it('discovers route() tags, including in mounted routers with params', async () => {
    const t = app();
    expect((await request(t.app).get('/api/orders/7')).body).toEqual({ priority: 'high' });
    expect(t.table.match({ method: 'GET', path: '/api/orders/9', headers: {} })?.key).toBe(
      'GET /api/orders/:id',
    );
  });

  it('lets configured routes win over route() tags', async () => {
    const t = app({ routes: { 'GET /api/pinned': 'critical' } });
    expect((await request(t.app).get('/api/pinned')).body).toEqual({ priority: 'critical' });
  });

  it('exposes req.chakra so handlers can serve a lighter response', async () => {
    const t = app();
    expect((await request(t.app).get('/recommendations')).body).toEqual({
      items: [1, 2, 3],
      priority: 'sheddable',
    });
    t.setDegraded(true);
    expect((await request(t.app).get('/recommendations')).body).toEqual({ items: [] });
  });

  it('writes a route fallback as-is', async () => {
    const t = app();
    t.capacity.sheddable = 0;
    const res = await request(t.app).get('/search');
    expect([res.status, res.text, res.headers['retry-after']]).toEqual([429, 'busy', '5']);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });

  it('releases the limiter once per request with the right outcome', async () => {
    const t = app();
    await request(t.app).post('/checkout');
    await request(t.app).get('/boom');
    expect(t.releases).toEqual(['success', 'error']);
    expect(t.inFlight.critical + t.inFlight.normal).toBe(0);
  });

  it('reports a client abort as dropped', async () => {
    const t = app();
    t.app.get('/slow', (_req, res) => setTimeout(() => res.end('late'), 100));
    const server = http.createServer(t.app).listen(0);
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      const req = http.get({ port, path: '/slow' });
      req.on('error', () => {});
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 20);
    });
    await new Promise((r) => setTimeout(r, 150));
    server.close();
    expect(t.releases).toEqual(['dropped']);
  });

  it('takes priority from req.user, never from client headers', async () => {
    const t = app({
      priority: (ctx) => ((ctx.user as { plan?: string })?.plan === 'pro' ? 'critical' : undefined),
    });
    t.capacity.sheddable = 0;
    expect(
      (await request(t.app).get('/recommendations').set('X-User-Tier', 'premium')).status,
    ).toBe(503);
    expect((await request(t.app).get('/recommendations?plan=pro')).body.priority).toBe('critical');
  });

  it('closed bands shed via overrides', async () => {
    const t = app();
    t.core.setOverrides({ closedBands: ['high'] });
    expect((await request(t.app).get('/api/orders/1')).status).toBe(503);
  });
});
