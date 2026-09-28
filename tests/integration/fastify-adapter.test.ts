import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { fastifyPlugin, type FastifyAdapterOptions } from '../../src/adapters/fastify';
import type { ChakraOptions } from '../../src/config/schema';
import { harness } from './harness';

async function app(options: ChakraOptions = {}, adapter: FastifyAdapterOptions = {}) {
  const h = harness(options);
  const a: FastifyInstance = Fastify();
  a.addHook('onRequest', async (req) => {
    const plan = (req.query as { plan?: string }).plan;
    (req as { user?: unknown }).user = plan ? { plan } : undefined;
  });
  await a.register(fastifyPlugin(h.core, h.table, adapter));
  a.post('/checkout', { config: { chakra: 'critical' } }, async () => ({ ok: true }));
  a.get('/recommendations', { config: { chakra: 'sheddable' } }, async (req) =>
    req.chakra?.degraded ? { items: [] } : { items: [1, 2, 3], priority: req.chakra?.priority },
  );
  a.get(
    '/search',
    { config: { chakra: { priority: 'sheddable', fallback: { status: 429, body: 'busy' } } } },
    async () => 'ok',
  );
  a.get('/boom', async () => {
    throw new Error('boom');
  });
  await a.register(async (child) => {
    child.get('/users/:id', { config: { chakra: 'high' } }, async (req) => ({
      priority: req.chakra?.priority,
    }));
  });
  return { app: a, ...h };
}

describe('Fastify adapter', () => {
  it('sheds sheddable routes with 503 + Retry-After while critical routes succeed', async () => {
    const t = await app();
    t.capacity.sheddable = 0;
    const shed = await t.app.inject('/recommendations');
    expect(shed.statusCode).toBe(503);
    expect(shed.headers['retry-after']).toBe('1');
    expect(shed.json().error).toBe('overloaded');
    expect((await t.app.inject({ method: 'POST', url: '/checkout' })).json()).toEqual({ ok: true });
  });

  it('reads priority from route config in child plugins, keyed by pattern', async () => {
    const t = await app();
    expect((await t.app.inject('/users/42')).json()).toEqual({ priority: 'high' });
    expect(
      t.table.match({ method: 'GET', path: '/x', route: '/users/:id', headers: {} })?.key,
    ).toBe('GET /users/:id');
  });

  it('lets configured routes win over route config', async () => {
    const t = await app({ routes: { 'GET /users/:id': 'critical' } });
    expect((await t.app.inject('/users/1')).json()).toEqual({ priority: 'critical' });
  });

  it('exposes request.chakra and the degraded flag', async () => {
    const t = await app();
    expect((await t.app.inject('/recommendations')).json()).toEqual({
      items: [1, 2, 3],
      priority: 'sheddable',
    });
    t.setDegraded(true);
    expect((await t.app.inject('/recommendations')).json()).toEqual({ items: [] });
  });

  it('writes a route fallback as-is', async () => {
    const t = await app();
    t.capacity.sheddable = 0;
    const res = await t.app.inject('/search');
    expect([res.statusCode, res.body]).toEqual([429, 'busy']);
  });

  it('releases the limiter once per request with the right outcome', async () => {
    const t = await app();
    await t.app.inject({ method: 'POST', url: '/checkout' });
    await t.app.inject('/boom');
    await t.app.inject('/nope');
    expect(t.releases).toEqual(['success', 'error', 'success']);
  });

  it('reports a client abort as dropped', async () => {
    const t = await app();
    t.app.get('/slow', async () => new Promise((r) => setTimeout(() => r('late'), 100)));
    await t.app.listen({ port: 0 });
    const { port } = t.app.server.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      const req = http.get({ port, path: '/slow' });
      req.on('error', () => {});
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 20);
    });
    await new Promise((r) => setTimeout(r, 150));
    await t.app.close();
    expect(t.releases[0]).toBe('dropped');
  });

  it('takes priority from request.user in preHandler mode, never from headers', async () => {
    const t = await app(
      {
        priority: (ctx) =>
          (ctx.user as { plan?: string })?.plan === 'pro' ? 'critical' : undefined,
      },
      { hook: 'preHandler' },
    );
    t.capacity.sheddable = 0;
    expect(
      (await t.app.inject({ url: '/recommendations', headers: { 'x-user-tier': 'premium' } }))
        .statusCode,
    ).toBe(503);
    expect((await t.app.inject('/recommendations?plan=pro')).json().priority).toBe('critical');
  });
});
