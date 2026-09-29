// Per-request overhead of the adapters, with the real admission core and route
// table and an admit-all limiter, so only CHAKRA's own work is measured.
//   npx tsx bench/adapters.bench.ts

import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { createAdmissionCore } from '../src/core/admission';
import { resolveOptions } from '../src/config/schema';
import { createRouteTable } from '../src/priority';
import { expressMiddleware } from '../src/adapters/express';
import { fastifyPlugin } from '../src/adapters/fastify';
import type { Request, Response } from 'express';
import type { Limiter } from '../src/types';

const admitAll: Limiter = {
  acquire: () => ({ admitted: true, degraded: false, token: { release() {} } }),
  snapshot: () => ({
    limit: 1,
    inFlight: 0,
    pressure: 0,
    eventLoopDelayMs: 0,
    bandLimits: { critical: 1, high: 1, normal: 1, sheddable: 1 },
  }),
  start() {},
  stop() {},
};

const routes: Record<string, 'critical' | 'sheddable'> = { 'POST /checkout': 'critical' };
for (let i = 0; i < 50; i++) routes[`GET /r${i}/:id/items/*`] = 'sheddable';

function setup() {
  const options = resolveOptions({ routes, logger: false, metrics: false }, {});
  const table = createRouteTable(options.routes);
  const core = createAdmissionCore({
    options,
    limiter: admitAll,
    resolver: table,
    sink: { emit() {} },
  });
  return { core, table };
}

function express(n: number): number {
  const { core, table } = setup();
  const mw = expressMiddleware(core, table);
  const next = () => {};
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: true });
    const req = { method: 'GET', path: '/r49/7/items/x', headers: {}, app: {} };
    mw(req as unknown as Request, res as unknown as Response, next);
    res.emit('close');
  }
  return Number(process.hrtime.bigint() - t0) / n;
}

function baseline(n: number): number {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: true });
    res.once('close', () => {});
    res.emit('close');
  }
  return Number(process.hrtime.bigint() - t0) / n;
}

async function fastifyApp(withPlugin: boolean) {
  const app = Fastify();
  if (withPlugin) {
    const { core, table } = setup();
    await app.register(fastifyPlugin(core, table));
  }
  app.get('/r49/:id/items/*', async () => 'ok');
  await app.ready();
  return app;
}

async function time(app: Awaited<ReturnType<typeof fastifyApp>>, n: number): Promise<number> {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) await app.inject('/r49/7/items/x');
  return Number(process.hrtime.bigint() - t0) / n;
}

/** inject() is noisy, so interleave rounds and take the median difference. */
async function fastify(rounds: number, n: number): Promise<number> {
  const [plain, chakra] = [await fastifyApp(false), await fastifyApp(true)];
  await time(plain, 5000);
  await time(chakra, 5000);
  const diffs: number[] = [];
  for (let r = 0; r < rounds; r++) diffs.push((await time(chakra, n)) - (await time(plain, n)));
  return diffs.sort((a, b) => a - b)[rounds >> 1];
}

async function main() {
  express(200_000);
  const e = express(1_000_000) - baseline(1_000_000);
  const f = await fastify(15, 5000);
  console.log(
    `express middleware (worst-case: last of 50 dynamic routes): ${(e / 1000).toFixed(2)} µs/request`,
  );
  console.log(
    `fastify plugin (inject, median of with minus without): ${(f / 1000).toFixed(2)} µs/request`,
  );
}

void main();
