import { createAdmissionCore } from '../../src/core/admission';
import { createRouteTable } from '../../src/priority';
import { resolveOptions, type ChakraOptions } from '../../src/config/schema';
import {
  UNMATCHED_ROUTE,
  type AcquireResult,
  type ChakraEvent,
  type Limiter,
  type LimiterSnapshot,
  type Priority,
  type ReleaseOutcome,
  type RequestContext,
} from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function admitAllLimiter(): Limiter {
  return {
    acquire: () => ({ admitted: true, degraded: false, token: { release: () => {} } }),
    snapshot: () => SNAPSHOT,
    start: () => {},
    stop: () => {},
  };
}

const SNAPSHOT: LimiterSnapshot = {
  limit: 10,
  inFlight: 4,
  pressure: 0.4,
  eventLoopDelayMs: 2,
  bandLimits: { critical: 10, high: 9, normal: 7, sheddable: 5 },
};

/** A limiter whose decision per band is scripted, recording every call. */
function scriptedLimiter(verdicts: Partial<Record<Priority, 'admit' | 'degrade' | 'reject'>> = {}) {
  const calls: { priority: Priority; force: boolean }[] = [];
  const releases: ReleaseOutcome[] = [];
  const limiter: Limiter = {
    acquire(priority, force = false): AcquireResult {
      calls.push({ priority, force });
      const verdict = verdicts[priority] ?? 'admit';
      const admitted = verdict !== 'reject';
      const token = admitted || force ? { release: (o: ReleaseOutcome) => releases.push(o) } : null;
      return { admitted, degraded: verdict === 'degrade', token };
    },
    snapshot: () => SNAPSHOT,
    start: () => {},
    stop: () => {},
  };
  return { limiter, calls, releases };
}

function setup(options: ChakraOptions = {}, limiter: Limiter = admitAllLimiter()) {
  const events: ChakraEvent[] = [];
  const resolved = resolveOptions({ logger: false, ...options }, {});
  const core = createAdmissionCore({
    options: resolved,
    limiter,
    resolver: createRouteTable({ ...resolved.routes }),
    sink: { emit: (e) => events.push(e) },
  });
  return { core, events };
}

function ctx(method: string, path: string, user?: unknown): RequestContext {
  return { method, path, headers: {}, user };
}

// ─── Priority resolution ──────────────────────────────────────────────────────

describe('priority resolution', () => {
  it('uses the matching route rule', () => {
    const { core } = setup({ routes: { 'POST /checkout': 'critical' } });
    expect(core.decide(ctx('POST', '/checkout')).info.priority).toBe('critical');
  });

  it('falls back to defaultPriority when no rule matches', () => {
    const { core } = setup({ defaultPriority: 'high' });
    expect(core.decide(ctx('GET', '/anything')).info.priority).toBe('high');
  });

  it('lets the per-request resolver override the route rule', () => {
    const { core } = setup({
      routes: { 'GET /feed': 'sheddable' },
      priority: (c) => ((c.user as { plan?: string })?.plan === 'enterprise' ? 'high' : undefined),
    });
    expect(core.decide(ctx('GET', '/feed', { plan: 'enterprise' })).info.priority).toBe('high');
    expect(core.decide(ctx('GET', '/feed', { plan: 'free' })).info.priority).toBe('sheddable');
  });

  it('ignores a resolver that throws or returns an unknown value', () => {
    const throwing = setup({
      routes: { 'GET /a': 'high' },
      priority: () => {
        throw new Error('boom');
      },
    });
    expect(throwing.core.decide(ctx('GET', '/a')).info.priority).toBe('high');

    const bogus = setup({ routes: { 'GET /a': 'high' }, priority: () => 'vip' as Priority });
    expect(bogus.core.decide(ctx('GET', '/a')).info.priority).toBe('high');
  });
});

// ─── Enforce mode ─────────────────────────────────────────────────────────────

describe('enforce mode', () => {
  it('admits and reports pressure from the limiter', () => {
    const { limiter } = scriptedLimiter();
    const { core } = setup({}, limiter);
    const d = core.decide(ctx('GET', '/'));
    expect(d.outcome).toBe('admit');
    expect(d.info).toMatchObject({
      degraded: false,
      wouldShed: false,
      pressure: 0.4,
      mode: 'enforce',
    });
  });

  it('marks degraded admits', () => {
    const { limiter } = scriptedLimiter({ normal: 'degrade' });
    const { core, events } = setup({}, limiter);
    const d = core.decide(ctx('GET', '/'));
    expect(d.outcome).toBe('admit');
    expect(d.info.degraded).toBe(true);
    expect(events[0]).toMatchObject({ type: 'admission', decision: 'degraded' });
  });

  it('sheds with a 503 and Retry-After when the limiter rejects', () => {
    const { limiter } = scriptedLimiter({ sheddable: 'reject' });
    const { core, events } = setup({ routes: { 'GET /recs': 'sheddable' } }, limiter);
    const d = core.decide(ctx('GET', '/recs'));
    expect(d.outcome).toBe('shed');
    if (d.outcome !== 'shed') return;
    expect(d.response.status).toBe(503);
    expect(d.response.headers['Retry-After']).toBe('1');
    expect(events.map((e) => e.type)).toEqual(['admission', 'shed_complete']);
    expect(events[0]).toMatchObject({
      decision: 'shed',
      band: 'sheddable',
      route: 'GET /recs',
      dryRun: false,
      reason: 'limit_exceeded',
      limit: 10,
      inFlight: 4,
    });
  });

  it('uses a route fallback over the default shed response', () => {
    const { limiter } = scriptedLimiter({ sheddable: 'reject' });
    const { core } = setup(
      {
        routes: {
          'GET /recs': { priority: 'sheddable', fallback: { status: 200, body: { items: [] } } },
        },
      },
      limiter,
    );
    const d = core.decide(ctx('GET', '/recs'));
    expect(d.outcome === 'shed' && d.response).toMatchObject({ status: 200, body: { items: [] } });
  });

  it('labels unmatched routes with a bounded value, never the raw path', () => {
    const { core, events } = setup();
    core.decide(ctx('GET', '/users/12345'));
    expect(events[0]).toMatchObject({ route: UNMATCHED_ROUTE });
  });
});

// ─── Token release ────────────────────────────────────────────────────────────

describe('done()', () => {
  it('releases the token once with an outcome derived from the status', () => {
    const { limiter, releases } = scriptedLimiter();
    const { core } = setup({}, limiter);

    const ok = core.decide(ctx('GET', '/'));
    if (ok.outcome === 'admit') {
      ok.done(200);
      ok.done(200);
    }
    const failed = core.decide(ctx('GET', '/'));
    if (failed.outcome === 'admit') failed.done(502);
    const aborted = core.decide(ctx('GET', '/'));
    if (aborted.outcome === 'admit') aborted.done(200, true);

    expect(releases).toEqual(['success', 'error', 'dropped']);
  });
});

// ─── Dry-run ──────────────────────────────────────────────────────────────────

describe('dry-run mode', () => {
  it('admits what it would shed, forces a token, and reports the real decision', () => {
    const { limiter, calls, releases } = scriptedLimiter({ sheddable: 'reject' });
    const { core, events } = setup(
      { mode: 'dry-run', routes: { 'GET /recs': 'sheddable' } },
      limiter,
    );

    const d = core.decide(ctx('GET', '/recs'));
    expect(d.outcome).toBe('admit');
    expect(d.info.wouldShed).toBe(true);
    expect(calls[0]).toEqual({ priority: 'sheddable', force: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'shed', dryRun: true, reason: 'limit_exceeded' });

    if (d.outcome === 'admit') d.done(200);
    expect(releases).toEqual(['success']);
  });

  it('is overridden by CHAKRA_MODE', () => {
    const resolved = resolveOptions({ mode: 'enforce', logger: false }, { CHAKRA_MODE: 'dry-run' });
    expect(resolved.mode).toBe('dry-run');
  });
});

// ─── Off mode ─────────────────────────────────────────────────────────────────

describe('off mode', () => {
  it('admits without touching the limiter or emitting events', () => {
    const { limiter, calls } = scriptedLimiter({ normal: 'reject' });
    const { core, events } = setup({ mode: 'off' }, limiter);
    expect(core.decide(ctx('GET', '/')).outcome).toBe('admit');
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

// ─── Overrides ────────────────────────────────────────────────────────────────

describe('overrides', () => {
  it('sheds a closed band without asking the limiter', () => {
    const { limiter, calls } = scriptedLimiter();
    const { core, events } = setup({ routes: { 'GET /recs': 'sheddable' } }, limiter);
    core.setOverrides({ closedBands: ['sheddable'] });

    expect(core.decide(ctx('GET', '/recs')).outcome).toBe('shed');
    expect(core.decide(ctx('GET', '/other')).outcome).toBe('admit');
    expect(calls.map((c) => c.priority)).toEqual(['normal']);
    expect(events[0]).toMatchObject({ reason: 'band_closed' });
    expect(core.getOverrides()).toEqual({ closedBands: ['sheddable'] });

    core.setOverrides({ closedBands: [] });
    expect(core.decide(ctx('GET', '/recs')).outcome).toBe('admit');
  });

  it('only reports a closed band in dry-run', () => {
    const { limiter, calls } = scriptedLimiter();
    const { core } = setup({ mode: 'dry-run', routes: { 'GET /recs': 'sheddable' } }, limiter);
    core.setOverrides({ closedBands: ['sheddable'] });
    const d = core.decide(ctx('GET', '/recs'));
    expect(d.outcome).toBe('admit');
    expect(d.info.wouldShed).toBe(true);
    expect(calls).toEqual([{ priority: 'sheddable', force: true }]);
  });
});

// ─── Never throws ─────────────────────────────────────────────────────────────

describe('failure isolation', () => {
  it('admits when the limiter throws', () => {
    const broken: Limiter = {
      acquire: () => {
        throw new Error('limiter bug');
      },
      snapshot: () => SNAPSHOT,
      start: () => {},
      stop: () => {},
    };
    const { core } = setup({}, broken);
    expect(core.decide(ctx('GET', '/')).outcome).toBe('admit');
  });

  it('keeps deciding when the sink or resolver throws', () => {
    const resolved = resolveOptions({ logger: false }, {});
    const core = createAdmissionCore({
      options: resolved,
      limiter: admitAllLimiter(),
      resolver: {
        match: () => {
          throw new Error('resolver bug');
        },
      },
      sink: {
        emit: () => {
          throw new Error('sink bug');
        },
      },
    });
    expect(core.decide(ctx('GET', '/')).outcome).toBe('admit');
  });
});
