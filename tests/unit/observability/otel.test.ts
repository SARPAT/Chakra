// OpenTelemetry sink unit tests — driven by an in-memory fake Meter.

import { describe, it, expect, beforeEach } from 'vitest';
import { createOtelSink } from '../../../src/observability/otel';
import { METRICS, OVERFLOW_ROUTE } from '../../../src/observability/metric-names';
import type { ChakraEvent, AdmissionEvent } from '../../../src/types';

// Fakes mirror @opentelemetry/api shapes (undefined attribute values, trailing
// context, promise-returning callbacks, required removeCallback) and are passed
// without a cast, exercising how loose MeterLike is.
type Attributes = { [key: string]: string | number | boolean | undefined };
type Options = { description?: string; unit?: string; valueType?: number; advice?: { explicitBucketBoundaries?: number[] } };
type Callback = (result: { observe(value: number, attributes?: Attributes): void }) => void | Promise<void>;
type Call = { value: number; attributes?: Attributes };

class FakeInstrument {
  calls: Call[] = [];
  callbacks: Callback[] = [];
  throws = false;
  constructor(public name: string, public options?: Options) {}
  add(value: number, attributes?: Attributes, _context?: unknown): void {
    if (this.throws) throw new Error('broke');
    this.calls.push({ value, attributes });
  }
  record(value: number, attributes?: Attributes, _context?: unknown): void {
    this.add(value, attributes);
  }
  addCallback(cb: Callback): void {
    this.callbacks.push(cb);
  }
  removeCallback(cb: Callback): void {
    this.callbacks = this.callbacks.filter((c) => c !== cb);
  }
  collect(): number[] {
    const seen: number[] = [];
    for (const cb of this.callbacks) void cb({ observe: (v) => seen.push(v) });
    return seen;
  }
}

class FakeMeter {
  all = new Map<string, FakeInstrument>();
  private make(name: string, options?: Options): FakeInstrument {
    const i = new FakeInstrument(name, options);
    this.all.set(name, i);
    return i;
  }
  createCounter(name: string, options?: Options) { return this.make(name, options); }
  createHistogram(name: string, options?: Options) { return this.make(name, options); }
  createObservableGauge(name: string, options?: Options) { return this.make(name, options); }
}

const admission = (o: Partial<AdmissionEvent> = {}): AdmissionEvent =>
  ({ type: 'admission', decision: 'admitted', band: 'normal', route: 'GET /users/:id', dryRun: false, ...o });

describe('createOtelSink', () => {
  let meter: FakeMeter;
  const get = (name: string) => meter.all.get(name)!;
  const counter = () => get('chakra.requests');
  const histogram = () => get('chakra.shed.latency');

  beforeEach(() => {
    meter = new FakeMeter();
  });

  it('creates instruments whose names map to the Prometheus names', () => {
    createOtelSink(meter);
    // Spec mapping: dots -> underscores, `{...}` units dropped, `s` -> _seconds, counters get _total.
    const prom = (name: string, suffix = '') =>
      name.replace(/\./g, '_') + (get(name).options?.unit === 's' ? '_seconds' : '') + suffix;
    expect(prom('chakra.requests', '_total')).toBe(METRICS.requests.name);
    expect(prom('chakra.shed.latency')).toBe(METRICS.shedLatency.name);
    expect(prom('chakra.inflight_requests')).toBe(METRICS.inFlight.name);
    expect(prom('chakra.concurrency_limit')).toBe(METRICS.concurrencyLimit.name);
    expect(prom('chakra.event_loop.lag')).toBe(METRICS.eventLoopLag.name);
    expect(counter().options).toMatchObject({ unit: '{request}', description: METRICS.requests.help });
    expect(histogram().options?.advice?.explicitBucketBoundaries).toEqual([...METRICS.shedLatency.buckets]);
  });

  it('counts admissions with decision, band, route and boolean dry_run', () => {
    const sink = createOtelSink(meter);
    sink.emit(admission({ decision: 'shed', band: 'sheddable', route: 'POST /cart' }));
    sink.emit(admission({ dryRun: true }));
    expect(counter().calls).toEqual([
      { value: 1, attributes: { decision: 'shed', band: 'sheddable', route: 'POST /cart', dry_run: false } },
      { value: 1, attributes: { decision: 'admitted', band: 'normal', route: 'GET /users/:id', dry_run: true } },
    ]);
  });

  it('reuses cached attribute objects after warm-up', () => {
    const sink = createOtelSink(meter);
    sink.emit(admission());
    sink.emit(admission());
    sink.emit({ type: 'shed_complete', band: 'normal', route: 'GET /', durationMs: 1 });
    sink.emit({ type: 'shed_complete', band: 'normal', route: 'GET /', durationMs: 2 });
    expect(counter().calls[0].attributes).toBe(counter().calls[1].attributes);
    expect(histogram().calls[0].attributes).toBe(histogram().calls[1].attributes);
  });

  it('reports routes beyond maxRoutes as OVERFLOW_ROUTE', () => {
    const sink = createOtelSink(meter, { maxRoutes: 2 });
    for (const route of ['GET /a', 'GET /b', 'GET /c', 'GET /a', 'GET /d', 'GET /b']) sink.emit(admission({ route }));
    expect(counter().calls.map((c) => c.attributes?.route))
      .toEqual(['GET /a', 'GET /b', OVERFLOW_ROUTE, 'GET /a', OVERFLOW_ROUTE, 'GET /b']);
  });

  it('defaults to DEFAULT_MAX_ROUTES distinct routes', () => {
    const sink = createOtelSink(meter);
    for (let i = 0; i < 201; i++) sink.emit(admission({ route: `GET /r${i}` }));
    const routes = counter().calls.map((c) => c.attributes?.route);
    expect([routes[199], routes[200]]).toEqual(['GET /r199', OVERFLOW_ROUTE]);
  });

  it('records shed latency in seconds with a band attribute', () => {
    const sink = createOtelSink(meter);
    sink.emit({ type: 'shed_complete', band: 'sheddable', route: 'GET /feed', durationMs: 2.5 });
    expect(histogram().calls).toEqual([{ value: 0.0025, attributes: { band: 'sheddable' } }]);
  });

  it('gauges observe nothing until a value arrives, then the latest', () => {
    const sink = createOtelSink(meter);
    for (const n of ['chakra.inflight_requests', 'chakra.concurrency_limit', 'chakra.event_loop.lag']) {
      expect(get(n).collect()).toEqual([]);
    }
    sink.emit({ type: 'limiter_state', limit: 10, inFlight: 3 });
    sink.emit({ type: 'limiter_state', limit: 25, inFlight: 7 });
    sink.emit({ type: 'event_loop_lag', lagMs: 30 });
    sink.emit({ type: 'event_loop_lag', lagMs: 12 });
    expect(get('chakra.concurrency_limit').collect()).toEqual([25]);
    expect(get('chakra.inflight_requests').collect()).toEqual([7]);
    expect(get('chakra.event_loop.lag').collect()).toEqual([0.012]);
  });

  it('admission updates limit and in-flight gauges only when present', () => {
    const sink = createOtelSink(meter);
    sink.emit(admission({ limit: 40, inFlight: 12 }));
    sink.emit(admission());
    expect(get('chakra.concurrency_limit').collect()).toEqual([40]);
    expect(get('chakra.inflight_requests').collect()).toEqual([12]);
  });

  it('shutdown removes gauge callbacks, stops recording and is idempotent', () => {
    const sink = createOtelSink(meter);
    sink.shutdown();
    expect(get('chakra.event_loop.lag').callbacks).toHaveLength(0);
    sink.emit(admission());
    expect(counter().calls).toEqual([]);
    expect(() => sink.shutdown()).not.toThrow();
  });

  it('shutdown tolerates gauges without removeCallback', () => {
    const sink = createOtelSink({
      createCounter: () => ({ add: () => {} }),
      createHistogram: () => ({ record: () => {} }),
      createObservableGauge: () => ({ addCallback: () => {} }),
    });
    expect(() => sink.shutdown()).not.toThrow();
  });

  it('never throws from emit or gauge callbacks', () => {
    const sink = createOtelSink(meter);
    counter().throws = true;
    histogram().throws = true;
    expect(() => sink.emit(admission({ limit: 9 }))).not.toThrow();
    expect(() => sink.emit({ type: 'shed_complete', band: 'normal', route: 'GET /', durationMs: 1 })).not.toThrow();
    expect(() => sink.emit(null as unknown as ChakraEvent)).not.toThrow();
    expect(() => sink.emit({ type: 'nope' } as unknown as ChakraEvent)).not.toThrow();
    const cb = get('chakra.concurrency_limit').callbacks[0];
    expect(() => cb({ observe: () => { throw new Error('observe broke'); } })).not.toThrow();
    expect(get('chakra.concurrency_limit').collect()).toEqual([9]);
  });
});
