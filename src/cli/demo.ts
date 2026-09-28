// `chakra demo`: a tiny shop API behind CHAKRA, plus a load generator that overloads it.
//
// The app runs in a child process so the load generator does not share its event loop.
// Its backend is a simulated database with a fixed pool of connections: past that,
// requests queue and latency climbs, which is what the adaptive limiter reacts to.

import { fork } from 'node:child_process';
import { Agent, createServer, request, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chakra, type Mode, type Priority } from '../index';

export const DEMO_ROUTES = [
  { method: 'POST', path: '/checkout', priority: 'critical', serviceMs: 15, share: 0.1 },
  { method: 'GET', path: '/products', priority: 'normal', serviceMs: 20, share: 0.5 },
  { method: 'GET', path: '/recommendations', priority: 'sheddable', serviceMs: 40, share: 0.4 },
] as const satisfies readonly {
  method: string;
  path: string;
  priority: Priority;
  serviceMs: number;
  share: number;
}[];

const POOL_SIZE = 8;

export interface DemoServer {
  readonly port: number;
  close(): Promise<void>;
}

/** Start the demo app on `port` (0 picks a free one). CHAKRA_MODE, when set, wins over `mode`. */
export function startDemoServer(port = 0, mode?: Mode): Promise<DemoServer> {
  const c = chakra({
    mode,
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
    if (d.outcome === 'shed')
      return send(res, d.response.status, d.response.body, d.response.headers);
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
        close: () =>
          new Promise((r) => {
            c.close();
            server.closeAllConnections();
            server.close(() => r());
          }),
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
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// ─── Load generator ───────────────────────────────────────────────────────────

export interface DemoOptions {
  /** Total run time. Default 30. */
  readonly seconds?: number;
  /** Arrival rate during the surge, requests per second. Default 600 (about twice capacity). */
  readonly rps?: number;
  /** `off` shows the same surge without CHAKRA. Default `enforce`. */
  readonly mode?: Mode;
  /** Run the app in this process instead of a child (tests). */
  readonly inProcess?: boolean;
  readonly write?: (text: string) => void;
  /** Redraw in place with colours. Default: stdout is a TTY. */
  readonly tty?: boolean;
}

export interface RouteStats {
  readonly route: string;
  readonly priority: Priority;
  ok: number;
  shed: number;
  failed: number;
  degraded: number;
  latencies: number[];
}

export interface DemoSummary {
  readonly mode: string;
  /** Totals over the surge phase. */
  readonly surge: readonly RouteStats[];
}

const TIMEOUT_MS = 5000;

/** Run the demo: calm traffic, a surge, then recovery. Resolves with the surge totals. */
export async function runDemo(options: DemoOptions = {}): Promise<DemoSummary> {
  const seconds = Math.max(3, options.seconds ?? 30);
  const surgeRps = options.rps ?? 600;
  const mode = options.mode ?? 'enforce';
  const write = options.write ?? ((t: string) => void process.stdout.write(t));
  const tty = options.tty ?? Boolean(process.stdout.isTTY);
  const server = await launch(mode, options.inProcess ?? __filename.endsWith('.ts'));
  const agent = new Agent({ keepAlive: true, maxSockets: 2048 });
  const phases = [
    { name: 'calm', until: seconds * 0.2, rps: surgeRps / 5 },
    { name: 'SURGE', until: seconds * 0.7, rps: surgeRps },
    { name: 'recovery', until: seconds, rps: surgeRps / 5 },
  ];
  const blank = (): RouteStats[] =>
    DEMO_ROUTES.map((r) => ({
      route: `${r.method} ${r.path}`,
      priority: r.priority,
      ok: 0,
      shed: 0,
      failed: 0,
      degraded: 0,
      latencies: [],
    }));
  const surge = blank();
  let window = blank();
  let status: Record<string, unknown> = {};
  const start = performance.now();
  let due = 0;
  let stopped = false;

  const fire = (): void => {
    let x = Math.random();
    const i = Math.max(
      0,
      DEMO_ROUTES.findIndex((r) => (x -= r.share) < 0),
    );
    const r = DEMO_ROUTES[i];
    const inSurge = phaseAt((performance.now() - start) / 1000).name === 'SURGE';
    const t0 = performance.now();
    const record = (code: number, degraded: boolean): void => {
      if (stopped) return; // aborted by shutdown, not by the app
      for (const s of inSurge ? [window[i], surge[i]] : [window[i]]) {
        if (code === 200) {
          s.ok++;
          s.latencies.push(performance.now() - t0);
          if (degraded) s.degraded++;
        } else if (code === 503) s.shed++;
        else s.failed++;
      }
    };
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        method: r.method,
        path: r.path,
        agent,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        res.on('end', () => record(res.statusCode ?? 0, res.headers['x-chakra-degraded'] === '1'));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => record(0, false));
    req.end();
  };
  const phaseAt = (t: number) => phases.find((p) => t < p.until) ?? phases[phases.length - 1];

  const load = setInterval(() => {
    due += phaseAt((performance.now() - start) / 1000).rps / 50;
    for (; due >= 1; due--) fire();
  }, 20);
  const poll = setInterval(() => {
    const t = (performance.now() - start) / 1000;
    getJson(server.port, agent).then(
      (s) => (status = s),
      () => {},
    );
    write(view(window, status, phaseAt(t), t, seconds, mode, tty));
    window = blank();
  }, 1000);

  await new Promise((r) => setTimeout(r, seconds * 1000));
  clearInterval(load);
  clearInterval(poll);
  await new Promise((r) => setTimeout(r, 250)); // let in-flight responses land
  stopped = true;
  agent.destroy();
  await server.close();
  write(summary(surge, mode, tty));
  return { mode, surge };
}

async function launch(mode: Mode, inProcess: boolean): Promise<DemoServer> {
  if (inProcess) return startDemoServer(0, mode);
  const child = fork(join(__dirname, 'index.js'), ['__demo-server'], {
    env: { ...process.env, CHAKRA_MODE: mode },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.once('message', (m) => resolve((m as { port: number }).port));
    child.once('exit', (code) => reject(new Error(`demo app exited with code ${code}`)));
  });
  return { port, close: () => new Promise((r) => (child.once('exit', () => r()), child.kill())) };
}

function getJson(port: number, agent: Agent): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/_status', agent, timeout: 1000 }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (d: string) => (body += d));
      res.on('end', () => resolve(JSON.parse(body) as Record<string, unknown>));
    })
      .on('error', reject)
      .end();
  });
}

// ─── Terminal view ────────────────────────────────────────────────────────────

const paint = (tty: boolean, code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

export function p95(latencies: readonly number[]): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  return sorted[Math.floor(0.95 * (sorted.length - 1))];
}

function view(
  stats: readonly RouteStats[],
  status: Record<string, unknown>,
  phase: { name: string; rps: number },
  t: number,
  total: number,
  mode: string,
  tty: boolean,
): string {
  const [bold, green, yellow, red] = [1, 32, 33, 31].map((c) => paint(tty, c));
  const num = (v: unknown, digits = 0) =>
    typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '-';
  const lat = (ms: number) =>
    (ms < 100 ? green : ms < 1000 ? yellow : red)(`${ms.toFixed(0)} ms`.padStart(8));
  const lines = [
    `${bold('CHAKRA demo')}  mode ${mode}  ${t.toFixed(0)}s/${total}s  ` +
      (phase.name === 'SURGE' ? red : green)(`${phase.name} ${phase.rps} req/s`),
    `limit ${num(status.limit)}  in-flight ${num(status.inFlight)}  pressure ${num(status.pressure, 2)}  ` +
      `event-loop p99 ${num(status.eventLoopDelayMs, 1)} ms`,
    '',
    bold(
      `${'route'.padEnd(22)}${'priority'.padEnd(11)}${'ok/s'.padStart(6)}${'shed/s'.padStart(8)}` +
        `${'failed/s'.padStart(10)}${'degraded'.padStart(10)}${'p95'.padStart(9)}`,
    ),
    ...stats.map(
      (s) =>
        `${s.route.padEnd(22)}${s.priority.padEnd(11)}${String(s.ok).padStart(6)}` +
        (s.shed ? yellow : String)(String(s.shed).padStart(8)) +
        (s.failed ? red : String)(String(s.failed).padStart(10)) +
        String(s.degraded).padStart(10) +
        lat(p95(s.latencies)),
    ),
  ];
  return tty ? `\x1b[H\x1b[2J${lines.join('\n')}\n` : `${lines.join('\n')}\n\n`;
}

function summary(surge: readonly RouteStats[], mode: string, tty: boolean): string {
  const bold = paint(tty, 1);
  const rows = surge.map(
    (s) =>
      `  ${s.route.padEnd(22)}${s.priority.padEnd(11)}${s.ok} served, ${s.shed} shed, ${s.failed} failed, ` +
      `p95 ${p95(s.latencies).toFixed(0)} ms`,
  );
  const next =
    mode === 'off'
      ? 'Run `npx chakra demo` to see the same surge with CHAKRA.'
      : 'Run `npx chakra demo --off` to see the same surge without CHAKRA.';
  return `\n${bold(`During the surge (mode ${mode}):`)}\n${rows.join('\n')}\n\n${next}\n`;
}
