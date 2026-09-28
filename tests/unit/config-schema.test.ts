import { ChakraConfigError, DEFAULT_SHED_RESPONSE, resolveOptions } from '../../src/config/schema';

function problemsOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ChakraConfigError) return err.problems;
    throw err;
  }
  return [];
}

describe('resolveOptions defaults', () => {
  it('works with no options', () => {
    const o = resolveOptions(undefined, {});
    expect(o.mode).toBe('enforce');
    expect(o.defaultPriority).toBe('normal');
    expect(o.routes).toEqual({});
    expect(o.shedResponse).toEqual(DEFAULT_SHED_RESPONSE);
    expect(o.metrics).toEqual({});
    expect(typeof o.logger === 'object' && typeof o.logger.info).toBe('function');
  });

  it('accepts a full valid config', () => {
    expect(() =>
      resolveOptions(
        {
          mode: 'dry-run',
          defaultPriority: 'high',
          routes: {
            'POST /checkout': 'critical',
            'get /recs/:id': { priority: 'sheddable', fallback: { status: 200, body: [] } },
            '* /health': 'critical',
          },
          priority: () => undefined,
          limiter: {
            algorithm: 'aimd',
            initialLimit: 10,
            minLimit: 2,
            maxLimit: 100,
            bandShares: { sheddable: 0.3 },
          },
          shedResponse: { status: 429, retryAfterSeconds: 5, headers: { 'X-Reason': 'busy' } },
          metrics: { prefix: 'shop_', maxRoutes: 50 },
          logger: false,
        },
        {},
      ),
    ).not.toThrow();
  });

  it('accepts a custom event sink as metrics', () => {
    const sink = { emit: () => {} };
    expect(resolveOptions({ metrics: sink }, {}).metrics).toBe(sink);
  });
});

describe('CHAKRA_MODE', () => {
  it('overrides the mode option, case-insensitively', () => {
    expect(resolveOptions({ mode: 'enforce' }, { CHAKRA_MODE: 'OFF' }).mode).toBe('off');
  });

  it('is ignored when empty', () => {
    expect(resolveOptions({ mode: 'dry-run' }, { CHAKRA_MODE: '' }).mode).toBe('dry-run');
  });

  it('rejects unknown values', () => {
    expect(problemsOf(() => resolveOptions({}, { CHAKRA_MODE: 'shadow' }))).toEqual([
      'CHAKRA_MODE must be one of enforce, dry-run, off; got "shadow"',
    ]);
  });
});

describe('validation', () => {
  it('lists every problem at once', () => {
    const problems = problemsOf(() =>
      resolveOptions(
        {
          mode: 'auto',
          defaultPriority: 'urgent',
          routes: { '/no-method': 'critical', 'FETCH /x': 'high', 'GET /y': 'vip' },
          limiter: { minLimit: 50, maxLimit: 10, degradeAt: 2, bandShares: { gold: 0.5 } },
          shedResponse: { status: 42 },
          metrics: { prefix: '9bad' },
          dashboard: { port: 4242 },
        } as never,
        {},
      ),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'unknown option "dashboard"',
        'mode must be one of enforce, dry-run, off; got "auto"',
        'defaultPriority must be one of critical, high, normal, sheddable; got "urgent"',
        'routes key "/no-method" must look like "GET /path"',
        'routes key "FETCH /x" has unknown method "FETCH"',
        'routes["GET /y"] must be a priority or { priority, fallback? }',
        'limiter.minLimit must not exceed limiter.maxLimit',
        'limiter.degradeAt must be a number in (0, 1]',
        'limiter.bandShares has unknown priority "gold"',
        'shedResponse.status must be an HTTP status code',
        'metrics.prefix must be a valid Prometheus metric name prefix',
      ]),
    );
  });

  it('rejects unknown nested keys', () => {
    const problems = problemsOf(() =>
      resolveOptions(
        {
          routes: { 'GET /a': { priority: 'high', weight: 5 } },
          limiter: { rpm_threshold: 60 },
          shedResponse: { code: 503 },
        } as never,
        {},
      ),
    );
    expect(problems).toEqual([
      'routes["GET /a"] has unknown key "weight"',
      'limiter has unknown option "rpm_threshold"',
      'shedResponse has unknown key "code"',
    ]);
  });

  it('rejects a logger without the required methods', () => {
    expect(problemsOf(() => resolveOptions({ logger: { info() {} } } as never, {}))).toEqual([
      'logger must be false or an object with info, warn and error functions',
    ]);
  });

  it('throws ChakraConfigError with a readable message', () => {
    expect(() => resolveOptions({ mode: 'x' } as never, {})).toThrow(
      /Invalid CHAKRA options:\n {2}- mode/,
    );
  });
});
