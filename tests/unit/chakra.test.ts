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
    const c = chakra({ logger: false, metrics: { emit: (e) => events.push(e) }, routes: { 'GET /': 'high' } });
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
