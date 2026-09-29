import express from 'express';
import { EventEmitter } from 'node:events';
import { chakra } from '../../src/index';

function fakeRes() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    headersSent: false,
    writableFinished: true,
    setHeader() {},
    end() {},
  });
}

describe('Express route discovery', () => {
  it('reads route() tags from an Express 5 style app.router', () => {
    const c = chakra({ logger: false });
    c.applyPreset('shed-sheddable');
    const recs = {
      path: '/recs',
      methods: { get: true },
      stack: [{ handle: chakra.route('sheddable') }],
    };
    const app = { router: { stack: [{ slash: true, handle: { stack: [{ route: recs }] } }] } };

    let nextCalled = false;
    const req = { app, method: 'GET', path: '/recs', headers: {} };
    c(req as never, fakeRes() as never, () => (nextCalled = true));
    expect(nextCalled).toBe(false); // shed: the sheddable band is closed
    c.close();
  });

  it('warns once when a tag sits under a mount it cannot discover', async () => {
    const warnings: string[] = [];
    const logger = { info() {}, error() {}, warn: (m: string) => warnings.push(m) };
    const c = chakra({ logger });
    const app = express();
    app.use(c);
    const users = express.Router({ mergeParams: true });
    users.get('/recs', chakra.route('sheddable'), (_req, res) => res.end('ok'));
    app.use('/u/:id', users);

    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as { port: number };
    await fetch(`http://127.0.0.1:${port}/u/1/recs`);
    await fetch(`http://127.0.0.1:${port}/u/2/recs`);
    server.closeAllConnections(); // fetch keep-alive sockets hold close() open on Node 18
    await new Promise<void>((r) => server.close(() => r()));
    c.close();

    expect(warnings.filter((w) => w.includes('was not discovered'))).toHaveLength(1);
  });
});
