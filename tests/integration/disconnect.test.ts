// Clients that disconnect while their handler is still running must not free
// capacity early, or a retry storm can push real concurrency past the limit.

import express from 'express';
import Fastify from 'fastify';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expressMiddleware } from '../../src/adapters/express';
import { fastifyPlugin } from '../../src/adapters/fastify';
import { harness } from './harness';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start a request and destroy the client socket after `ms`. */
function abandon(port: number, path: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const req = http.get({ port, path });
    req.on('error', () => {});
    setTimeout(() => {
      req.destroy();
      resolve();
    }, ms);
  });
}

async function status(port: number, path: string): Promise<number> {
  return (await fetch(`http://127.0.0.1:${port}${path}`)).status;
}

type Server = { port: number; close: () => Promise<unknown> };

async function expressServer(
  h: ReturnType<typeof harness>,
  handlerMs: number | null,
): Promise<Server> {
  const app = express();
  app.use(expressMiddleware(h.core, h.table));
  app.get('/work', (_req, res) => {
    if (handlerMs !== null) setTimeout(() => res.end('done'), handlerMs);
  });
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise((r) => server.close(r)).then(() => server.closeAllConnections()),
  };
}

async function fastifyServer(h: ReturnType<typeof harness>, handlerMs: number): Promise<Server> {
  const app = Fastify();
  await app.register(fastifyPlugin(h.core, h.table));
  app.get('/work', async () => {
    await sleep(handlerMs);
    return 'done';
  });
  await app.listen({ port: 0 });
  return { port: (app.server.address() as AddressInfo).port, close: () => app.close() };
}

describe.each([
  ['Express', expressServer],
  ['Fastify', fastifyServer],
] as const)('%s: client disconnects under overload', (_name, start) => {
  it('keeps the slot until the handler finishes, then releases it as dropped', async () => {
    const h = harness();
    h.capacity.normal = 2;
    const s = await start(h, 150);
    await Promise.all([abandon(s.port, '/work', 20), abandon(s.port, '/work', 20)]);
    await sleep(30);
    // Both clients are gone but both handlers still run: the band is still full.
    expect(h.inFlight.normal).toBe(2);
    expect(await status(s.port, '/work')).toBe(503);
    await sleep(200);
    expect(h.inFlight.normal).toBe(0);
    expect(h.releases).toEqual(['dropped', 'dropped']);
    expect(await status(s.port, '/work')).toBe(200);
    await s.close();
  });
});
