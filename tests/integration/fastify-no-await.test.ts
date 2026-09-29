import Fastify from 'fastify';
import { chakra } from '../../src/index';

describe('Fastify without awaiting register', () => {
  it('still applies config.chakra tags declared on top-level routes', async () => {
    const c = chakra({ logger: false });
    c.applyPreset('shed-sheddable');
    const app = Fastify();
    app.register(c.fastify); // not awaited
    app.get('/recs', { config: { chakra: 'sheddable' } }, async () => ({ ok: true }));
    app.get('/home', async () => ({ ok: true }));

    expect((await app.inject({ method: 'GET', url: '/recs' })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/home' })).statusCode).toBe(200);
    await app.close();
    c.close();
  });
});

describe('invalid tag learned on the request path', () => {
  it('serves the request instead of failing it', async () => {
    const c = chakra({ logger: false });
    const app = Fastify();
    app.register(c.fastify); // not awaited, so the tag is learned per request
    app.get('/x', { config: { chakra: 'urgent' as never } }, async () => ({ ok: true }));

    expect((await app.inject({ method: 'GET', url: '/x' })).statusCode).toBe(200);
    await app.close();
    c.close();
  });
});

describe('metricsHandler on Fastify', () => {
  it('serves Prometheus text through a Fastify reply', async () => {
    const c = chakra({ logger: false });
    const app = Fastify();
    await app.register(c.fastify);
    app.get('/metrics', c.metricsHandler);
    await app.inject({ method: 'GET', url: '/metrics' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).toMatch(/chakra_requests_total/);
    await app.close();
    c.close();
  });
});
