import { main } from '../../src/cli/index';
import { runDemo, startDemoServer } from '../../src/cli/demo';

describe('chakra demo', () => {
  it('runs a short surge and prints the live view and summary', async () => {
    let out = '';
    const summary = await runDemo({
      seconds: 3,
      rps: 150,
      inProcess: true,
      tty: false,
      write: (t) => (out += t),
    });
    expect(out).toContain('CHAKRA demo');
    expect(out).toContain('POST /checkout');
    expect(out).toContain('During the surge (mode enforce)');
    const checkout = summary.surge.find((s) => s.priority === 'critical')!;
    expect(checkout.ok).toBeGreaterThan(0);
    expect(checkout.shed + checkout.failed).toBe(0);
  }, 15_000);

  it('sheds sheddable requests while every critical request succeeds under overload', async () => {
    const { surge } = await runDemo({ seconds: 6, rps: 600, inProcess: true, write: () => {} });
    const [checkout, , recommendations] = surge;
    expect(checkout.ok).toBeGreaterThan(0);
    expect(checkout.shed + checkout.failed).toBe(0);
    expect(recommendations.shed).toBeGreaterThan(recommendations.ok);
  }, 20_000);

  it('serves the demo routes and a status endpoint', async () => {
    const server = await startDemoServer(0, 'enforce');
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${base}/checkout`, { method: 'POST' })).status).toBe(200);
      expect((await fetch(`${base}/nope`)).status).toBe(404);
      expect(await (await fetch(`${base}/_status`)).json()).toMatchObject({ mode: 'enforce' });
    } finally {
      await server.close();
    }
  });
});

describe('chakra CLI', () => {
  it('prints help and rejects unknown commands', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['--help'])).toBe(0);
    expect(log.mock.calls[0][0]).toContain('Usage: chakra');
    expect(await main(['bogus'])).toBe(1);
    expect(error.mock.calls[0][0]).toContain('Unknown command "bogus"');
    vi.restoreAllMocks();
  });
});
