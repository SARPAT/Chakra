// End to end through the public API: chakra() + real Express/Fastify apps + the real
// adaptive limiter pinned to a fixed limit of 4, so the sheddable band (50% share)
// holds 2 slots. Two slow sheddable requests fill it; a third is shed while a
// critical request still gets through.

import express from 'express';
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { chakra } from '../../src/index';

const LIMITER = { initialLimit: 4, minLimit: 4, maxLimit: 4 };

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
}

describe('Express via app.use(chakra())', () => {
  let server: Server;
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it('sheds the sheddable band at its limit and keeps critical routes serving', async () => {
    const c = chakra({ logger: false, limiter: LIMITER });
    const hold = gate();
    let entered = 0;

    const app = express();
    app.use(c);
    app.get('/recs', chakra.route('sheddable'), async (req, res) => {
      entered++;
      await hold.opened;
      res.json({ priority: req.chakra?.priority });
    });
    app.post('/pay', chakra.route('critical'), (req, res) => {
      res.json({ priority: req.chakra?.priority });
    });
    app.get('/metrics', c.metricsHandler);

    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // First request discovers route() tags; it runs before the table knows them.
    await fetch(`${base}/pay`, { method: 'POST' });

    const slow = [fetch(`${base}/recs`), fetch(`${base}/recs`)];
    await waitFor(() => entered === 2);

    const shed = await fetch(`${base}/recs`);
    expect(shed.status).toBe(503);
    expect(shed.headers.get('retry-after')).toBe('1');

    const pay = await fetch(`${base}/pay`, { method: 'POST' });
    expect(pay.status).toBe(200);
    expect(await pay.json()).toEqual({ priority: 'critical' });

    hold.open();
    const done = await Promise.all(slow);
    expect(done.map((r) => r.status)).toEqual([200, 200]);
    expect(await done[0].json()).toEqual({ priority: 'sheddable' });

    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toMatch(
      /chakra_requests_total\{[^}]*decision="shed"[^}]*band="sheddable"[^}]*\} 1/,
    );
    c.close();
  });

  it('lets everything through in dry-run and reports what it would shed', async () => {
    const c = chakra({ logger: false, mode: 'dry-run', limiter: LIMITER });
    c.applyPreset('shed-sheddable');

    const app = express();
    app.use(c);
    app.get('/recs', chakra.route('sheddable'), (req, res) => {
      res.json({ wouldShed: req.chakra?.wouldShed });
    });

    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await fetch(`${base}/recs`); // discovery
    const res = await fetch(`${base}/recs`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ wouldShed: true });
    expect(c.dryRunReport()?.byRoute[0]).toMatchObject({ route: 'GET /recs', band: 'sheddable' });
    c.close();
  });
});

describe('Fastify via app.register(c.fastify)', () => {
  it('sheds the sheddable band at its limit and keeps critical routes serving', async () => {
    const c = chakra({ logger: false, limiter: LIMITER });
    const hold = gate();
    let entered = 0;

    const app = Fastify();
    await app.register(c.fastify);
    app.get('/recs', { config: { chakra: 'sheddable' } }, async () => {
      entered++;
      await hold.opened;
      return { ok: true };
    });
    app.post('/pay', { config: { chakra: 'critical' } }, async (request) => ({
      priority: (request as unknown as { chakra?: { priority: string } }).chakra?.priority,
    }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    const slow = [fetch(`${base}/recs`), fetch(`${base}/recs`)];
    await waitFor(() => entered === 2);

    expect((await fetch(`${base}/recs`)).status).toBe(503);
    const pay = await fetch(`${base}/pay`, { method: 'POST' });
    expect(pay.status).toBe(200);
    expect(await pay.json()).toEqual({ priority: 'critical' });

    hold.open();
    expect((await Promise.all(slow)).map((r) => r.status)).toEqual([200, 200]);
    await app.close();
    c.close();
  });
});
