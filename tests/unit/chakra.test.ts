import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chakra, ChakraConfigError, type ChakraEvent, type MetricsExporter } from '../../src/index';

describe('chakra()', () => {
  it('builds a working instance with zero config', () => {
    const c = chakra({ logger: false });
    const d = c.decide({ method: 'GET', path: '/', headers: {} });
    expect(d.outcome).toBe('admit');
    expect(d.info.priority).toBe('normal');
    expect(c.mode).toBe('enforce');
    c.close();
    c.close();
  });

  it('throws ChakraConfigError for invalid options', () => {
    expect(() => chakra({ mode: 'auto' } as never)).toThrow(ChakraConfigError);
  });

  it('forwards events to a custom sink', () => {
    const events: ChakraEvent[] = [];
    const c = chakra({
      logger: false,
      metrics: { emit: (e) => events.push(e) },
      routes: { 'GET /': 'high' },
    });
    c.decide({ method: 'GET', path: '/', headers: {} });
    expect(events[0]).toMatchObject({ type: 'admission', band: 'high', route: 'GET /' });
    c.close();
  });

  it('applies overrides through the instance', () => {
    const c = chakra({ logger: false, routes: { 'GET /recs': 'sheddable' } });
    c.setOverrides({ closedBands: ['sheddable'] });
    expect(c.decide({ method: 'GET', path: '/recs', headers: {} }).outcome).toBe('shed');
    c.close();
  });
});

describe('metricsHandler', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
  });

  async function scrape(handler: Parameters<typeof createServer>[1]) {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
  }

  it('returns 404 when no exporter is configured', async () => {
    const c = chakra({ logger: false, metrics: false });
    const res = await scrape(c.metricsHandler);
    expect(res.status).toBe(404);
  });

  it('renders an exporter sink', async () => {
    const exporter: MetricsExporter = {
      contentType: 'text/plain; version=0.0.4',
      emit: () => {},
      render: () => 'chakra_up 1\n',
    };
    const c = chakra({ logger: false, metrics: exporter });
    const res = await scrape(c.metricsHandler);
    expect(res).toEqual({ status: 200, type: 'text/plain; version=0.0.4', body: 'chakra_up 1\n' });
  });
});

describe('default observability', () => {
  it('exports Prometheus metrics by default', () => {
    const c = chakra({ logger: false, routes: { 'GET /': 'high' } });
    c.decide({ method: 'GET', path: '/', headers: {} });
    const res = { statusCode: 0, headers: {} as Record<string, string>, body: '' };
    c.metricsHandler(
      {} as never,
      {
        set statusCode(v: number) {
          res.statusCode = v;
        },
        setHeader: (k: string, v: string) => {
          res.headers[k] = v;
        },
        end: (b: string) => {
          res.body = b;
        },
      } as never,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/chakra_requests_total\{[^}]*band="high"[^}]*\} 1/);
    c.close();
  });

  it('reports would-shed decisions in dry-run mode', () => {
    const lines: string[] = [];
    const c = chakra({
      mode: 'dry-run',
      routes: { 'GET /recs': 'sheddable' },
      logger: { info: (m) => lines.push(m), warn: () => {}, error: () => {} },
    });
    c.setOverrides({ closedBands: ['sheddable'] });
    expect(c.decide({ method: 'GET', path: '/recs', headers: {} }).outcome).toBe('admit');
    expect(c.dryRunReport()?.totals.shed).toBe(1);
    expect(lines.some((l) => l.startsWith('dry-run '))).toBe(true);
    c.close();
  });

  it('has no dry-run report in enforce mode', () => {
    const c = chakra({ logger: false });
    expect(c.dryRunReport()).toBeUndefined();
    c.close();
  });
});
