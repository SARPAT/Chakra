// `chakra demo`: a tiny shop API behind CHAKRA, plus a load generator that overloads it.
//
// The app runs in a child process so the load generator does not share its event loop.
// Its backend is a simulated database with a fixed pool of connections: past that,
// requests queue and latency climbs, which is what the adaptive limiter reacts to.

import { createServer, type Server } from 'node:http';
import { chakra, type Priority } from '../index';

export const DEMO_ROUTES = [
  { method: 'POST', path: '/checkout', priority: 'critical', serviceMs: 15, share: 0.1 },
  { method: 'GET', path: '/products', priority: 'normal', serviceMs: 20, share: 0.5 },
  { method: 'GET', path: '/recommendations', priority: 'sheddable', serviceMs: 40, share: 0.4 },
] as const satisfies readonly { method: string; path: string; priority: Priority; serviceMs: number; share: number }[];

const POOL_SIZE = 8;

export interface DemoServer {
  readonly port: number;
  close(): Promise<void>;
}

/** Start the demo app on `port` (0 picks a free one). Mode comes from CHAKRA_MODE. */
export function startDemoServer(port = 0): Promise<DemoServer> {
  const c = chakra({
    routes: Object.fromEntries(DEMO_ROUTES.map((r) => [`${r.method} ${r.path}`, r.priority])),
    logger: false,
  });
  const query = pool(POOL_SIZE);
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?', 1)[0];
    if (path === '/_status') return send(res, 200, { mode: c.mode, ...c.snapshot() });
    const route = DEMO_ROUTES.find((r) => r.path === path && r.method === req.method);
    if (!route) return send(res, 404, { error: 'not found' });

    const d = c.decide({ method: req.method ?? 'GET', path, headers: req.headers, raw: req });
    if (d.outcome === 'shed') return send(res, d.response.status, d.response.body, d.response.headers);
    res.once('close', () => d.done(res.statusCode, !res.writableFinished));
    burn(0.2); // request parsing, auth, serialisation
    // A degraded request skips the expensive part (e.g. personalisation).
    query(d.info.degraded ? route.serviceMs / 4 : route.serviceMs).then(() =>
      send(res, 200, { ok: true }, d.info.degraded ? { 'x-chakra-degraded': '1' } : undefined),
    );
  });
  server.keepAliveTimeout = 30_000;
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({
        port: (server.address() as { port: number }).port,
        close: () => new Promise((r) => { c.close(); server.closeAllConnections(); server.close(() => r()); }),
      }),
    ),
  );
}

/** A connection pool: at most `size` queries run at once, the rest wait in FIFO order. */
function pool(size: number): (ms: number) => Promise<void> {
  const waiting: (() => void)[] = [];
  let free = size;
  const run = (ms: number, done: () => void): void => {
    setTimeout(() => {
      done();
      const next = waiting.shift();
      if (next) next();
      else free++;
    }, ms);
  };
  return (ms) =>
    new Promise((resolve) => {
      if (free > 0) {
        free--;
        run(ms, resolve);
      } else waiting.push(() => run(ms, resolve));
    });
}

function burn(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end);
}

function send(
  res: import('node:http').ServerResponse,
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
