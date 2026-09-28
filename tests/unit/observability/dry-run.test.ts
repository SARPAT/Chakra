// Tests for the dry-run reporter (JSON lines, filtering, rate limiting, summary, report).

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DRY_RUN_MAX_ROUTE_KEYS,
  DRY_RUN_OVERFLOW_ROUTE,
  createDryRunReporter,
} from '../../../src/observability/dry-run';
import type { DryRunReporterOptions } from '../../../src/observability/dry-run';
import type { AdmissionEvent, ChakraEvent } from '../../../src/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function admission(overrides: Partial<AdmissionEvent> = {}): AdmissionEvent {
  return {
    type: 'admission',
    decision: 'shed',
    band: 'sheddable',
    route: 'GET /x',
    dryRun: true,
    ...overrides,
  };
}

function setup(opts: Omit<DryRunReporterOptions, 'log' | 'now'> = {}) {
  const lines: string[] = [];
  const clock = { t: 0 };
  const reporter = createDryRunReporter({
    ...opts,
    log: (line) => { lines.push(line); },
    now: () => clock.t,
  });
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { reporter, lines, parsed, clock };
}

describe('createDryRunReporter', () => {
  describe('log lines', () => {
    it('logs one structured JSON line for a would-shed event', () => {
      const { reporter, lines } = setup();
      reporter.emit(admission({
        route: 'GET /users/:id',
        reason: 'limit_exceeded',
        limit: 40,
        inFlight: 41,
      }));

      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('\n');
      expect(JSON.parse(lines[0])).toEqual({
        level: 'info',
        msg: 'chakra dry-run: would have shed',
        component: 'chakra',
        mode: 'dry-run',
        decision: 'shed',
        band: 'sheddable',
        route: 'GET /users/:id',
        reason: 'limit_exceeded',
        limit: 40,
        inFlight: 41,
      });
    });

    it('logs would-degrade events with their own message', () => {
      const { reporter, parsed } = setup();
      reporter.emit(admission({ decision: 'degraded', band: 'normal' }));
      expect(parsed()[0]).toMatchObject({
        msg: 'chakra dry-run: would have degraded',
        decision: 'degraded',
        band: 'normal',
      });
    });

    it('omits undefined optional fields', () => {
      const { reporter, lines } = setup();
      reporter.emit(admission());
      const obj = JSON.parse(lines[0]);
      expect(Object.keys(obj).sort()).toEqual(
        ['band', 'component', 'decision', 'level', 'mode', 'msg', 'route'].sort(),
      );
      expect(lines[0]).not.toContain('undefined');
    });

    it('escapes route strings safely', () => {
      const { reporter, parsed } = setup();
      const route = 'GET /a"b\\c\n';
      reporter.emit(admission({ route }));
      expect(parsed()[0].route).toBe(route);
    });
  });

  describe('filtering', () => {
    it('ignores admitted events, non-dry-run events and other event types', () => {
      const { reporter, lines } = setup();
      const ignored: ChakraEvent[] = [
        admission({ decision: 'admitted' }),
        admission({ dryRun: false }),
        admission({ dryRun: false, decision: 'degraded' }),
        { type: 'shed_complete', band: 'normal', route: 'GET /x', durationMs: 1 },
        { type: 'limiter_state', limit: 10, inFlight: 3 },
        { type: 'event_loop_lag', lagMs: 12 },
      ];
      for (const e of ignored) reporter.emit(e);
      reporter.flush();

      expect(lines).toEqual([]);
      expect(reporter.stats()).toEqual({ wouldShed: 0, wouldDegrade: 0, suppressed: 0, logged: 0 });
      expect(reporter.report().byRoute).toEqual([]);
    });

    it('ignores malformed input without throwing', () => {
      const { reporter, lines } = setup();
      expect(() => reporter.emit(null as unknown as ChakraEvent)).not.toThrow();
      expect(() => reporter.emit(undefined as unknown as ChakraEvent)).not.toThrow();
      expect(() => reporter.emit({ type: 'admission' } as unknown as ChakraEvent)).not.toThrow();
      expect(lines).toEqual([]);
    });
  });

  describe('rate limiting', () => {
    it('logs at most maxLogsPerInterval lines per window and counts the rest', () => {
      const { reporter, lines } = setup({ maxLogsPerInterval: 3, intervalMs: 1000 });
      for (let i = 0; i < 10; i++) reporter.emit(admission());

      expect(lines).toHaveLength(3);
      expect(reporter.stats()).toEqual({ wouldShed: 10, wouldDegrade: 0, suppressed: 7, logged: 3 });
    });

    it('defaults to 10 lines per 10s window', () => {
      const { reporter, lines, clock } = setup();
      for (let i = 0; i < 15; i++) reporter.emit(admission());
      expect(lines).toHaveLength(10);

      clock.t = 9_999;
      reporter.emit(admission());
      expect(lines).toHaveLength(10);

      clock.t = 10_000;
      reporter.emit(admission());
      // summary + one fresh line
      expect(lines).toHaveLength(12);
    });

    it('writes one summary line keyed by decision|band|route when the next window starts', () => {
      const { reporter, parsed, clock } = setup({ maxLogsPerInterval: 1, intervalMs: 1000 });

      reporter.emit(admission({ route: 'GET /a' })); // logged
      reporter.emit(admission({ route: 'GET /a' }));
      reporter.emit(admission({ route: 'GET /a' }));
      reporter.emit(admission({ route: 'GET /b', decision: 'degraded', band: 'normal' }));
      expect(parsed()).toHaveLength(1);

      clock.t = 1000;
      reporter.emit(admission({ route: 'GET /c' }));

      const out = parsed();
      expect(out).toHaveLength(3);
      expect(out[1]).toEqual({
        level: 'info',
        msg: 'chakra dry-run: suppressed similar logs',
        component: 'chakra',
        mode: 'dry-run',
        suppressed: 3,
        counts: {
          'shed|sheddable|GET /a': 2,
          'degraded|normal|GET /b': 1,
        },
      });
      expect(out[2]).toMatchObject({ msg: 'chakra dry-run: would have shed', route: 'GET /c' });
    });

    it('caps the summary to the top 20 keys by count but reports the full suppressed total', () => {
      const { reporter, parsed } = setup({ maxLogsPerInterval: 0, intervalMs: 1000 });
      // 25 routes; route i is suppressed i+1 times.
      for (let i = 0; i < 25; i++) {
        for (let n = 0; n <= i; n++) reporter.emit(admission({ route: `GET /r${i}` }));
      }
      reporter.flush();

      const out = parsed();
      expect(out).toHaveLength(1);
      const summary = out[0] as { suppressed: number; counts: Record<string, number> };
      expect(summary.suppressed).toBe((25 * 26) / 2);
      const keys = Object.keys(summary.counts);
      expect(keys).toHaveLength(20);
      expect(keys[0]).toBe('shed|sheddable|GET /r24');
      expect(summary.counts['shed|sheddable|GET /r24']).toBe(25);
      expect(keys).not.toContain('shed|sheddable|GET /r0');
      expect(keys).not.toContain('shed|sheddable|GET /r4');
      expect(keys).toContain('shed|sheddable|GET /r5');
    });
  });

  describe('flush', () => {
    it('writes the pending summary immediately and clears it', () => {
      const { reporter, parsed } = setup({ maxLogsPerInterval: 1, intervalMs: 60_000 });
      reporter.emit(admission());
      reporter.emit(admission());
      reporter.emit(admission());

      reporter.flush();
      const out = parsed();
      expect(out).toHaveLength(2);
      expect(out[1]).toMatchObject({ suppressed: 2, counts: { 'shed|sheddable|GET /x': 2 } });

      reporter.flush();
      expect(parsed()).toHaveLength(2);
    });

    it('does not reset the per-window line budget before the window ends', () => {
      const { reporter, lines } = setup({ maxLogsPerInterval: 1, intervalMs: 60_000 });
      reporter.emit(admission());
      reporter.emit(admission());
      reporter.flush(); // 1 line + 1 summary
      reporter.emit(admission()); // still suppressed
      expect(lines).toHaveLength(2);
      expect(reporter.stats().suppressed).toBe(2);
    });

    it('starts a new window when called after the window has elapsed', () => {
      const { reporter, lines, clock } = setup({ maxLogsPerInterval: 1, intervalMs: 1000 });
      reporter.emit(admission());
      reporter.emit(admission());
      clock.t = 2000;
      reporter.flush(); // summary
      reporter.emit(admission()); // fresh window: logged
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[2]).msg).toBe('chakra dry-run: would have shed');
    });

    it('is a no-op before any event', () => {
      const { reporter, lines } = setup();
      expect(() => reporter.flush()).not.toThrow();
      expect(lines).toEqual([]);
    });
  });

  describe('safety', () => {
    it('swallows a throwing logger and keeps counting', () => {
      const log = vi.fn(() => { throw new Error('disk full'); });
      const reporter = createDryRunReporter({ log, maxLogsPerInterval: 1, now: () => 0 });

      expect(() => reporter.emit(admission())).not.toThrow();
      expect(() => reporter.emit(admission())).not.toThrow();
      expect(() => reporter.flush()).not.toThrow();
      expect(log).toHaveBeenCalledTimes(2); // line + summary
      expect(reporter.stats()).toMatchObject({ wouldShed: 2, suppressed: 1 });
    });

    it('writes to process.stdout with a trailing newline by default', () => {
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        createDryRunReporter().emit(admission());
        expect(write).toHaveBeenCalledTimes(1);
        const arg = String(write.mock.calls[0][0]);
        expect(arg.endsWith('\n')).toBe(true);
        expect(JSON.parse(arg).msg).toBe('chakra dry-run: would have shed');
      } finally {
        write.mockRestore();
      }
    });
  });

  describe('report', () => {
    it('summarises counts per route and band, most would-shed first', () => {
      const { reporter, clock } = setup({ maxLogsPerInterval: 2 });
      clock.t = 1234;
      reporter.reset();

      reporter.emit(admission({ route: 'GET /a', band: 'sheddable' }));
      reporter.emit(admission({ route: 'GET /b', band: 'normal' }));
      reporter.emit(admission({ route: 'GET /b', band: 'normal' }));
      reporter.emit(admission({ route: 'GET /b', band: 'normal', decision: 'degraded' }));
      reporter.emit(admission({ route: 'GET /a', band: 'high', decision: 'degraded' }));
      reporter.emit(admission({ route: 'GET /a', band: 'high', decision: 'degraded' }));
      reporter.emit(admission({ route: 'GET /a', decision: 'admitted' }));
      reporter.emit(admission({ route: 'GET /z', dryRun: false }));

      expect(reporter.report()).toEqual({
        since: 1234,
        totals: { shed: 3, degraded: 3, suppressed: 4 },
        byRoute: [
          { route: 'GET /b', band: 'normal', shed: 2, degraded: 1 },
          { route: 'GET /a', band: 'sheddable', shed: 1, degraded: 0 },
          { route: 'GET /a', band: 'high', shed: 0, degraded: 2 },
        ],
      });
    });

    it('returns copies that callers cannot mutate', () => {
      const { reporter } = setup();
      reporter.emit(admission());
      const r = reporter.report();
      r.byRoute[0].shed = 100;
      r.totals.shed = 100;
      expect(reporter.report().byRoute[0].shed).toBe(1);
      expect(reporter.report().totals.shed).toBe(1);
    });

    it('caps distinct route/band keys and overflows into __other__ per band', () => {
      const { reporter } = setup({ maxLogsPerInterval: 0 });
      const extra = 7;
      for (let i = 0; i < DRY_RUN_MAX_ROUTE_KEYS + extra; i++) {
        reporter.emit(admission({ route: `GET /r${i}` }));
      }
      // Existing keys keep counting after the cap is reached.
      reporter.emit(admission({ route: 'GET /r0' }));
      // New keys in another band also overflow.
      reporter.emit(admission({ route: 'GET /new', band: 'critical', decision: 'degraded' }));

      const { byRoute, totals } = reporter.report();
      expect(byRoute).toHaveLength(DRY_RUN_MAX_ROUTE_KEYS + 2);
      expect(byRoute[0]).toEqual({
        route: DRY_RUN_OVERFLOW_ROUTE,
        band: 'sheddable',
        shed: extra,
        degraded: 0,
      });
      expect(byRoute.find((e) => e.route === 'GET /r0')).toMatchObject({ shed: 2 });
      expect(
        byRoute.find((e) => e.route === DRY_RUN_OVERFLOW_ROUTE && e.band === 'critical'),
      ).toEqual({ route: DRY_RUN_OVERFLOW_ROUTE, band: 'critical', shed: 0, degraded: 1 });
      expect(totals.shed).toBe(DRY_RUN_MAX_ROUTE_KEYS + extra + 1);
      expect(DRY_RUN_OVERFLOW_ROUTE).toBe('__other__');
      expect(DRY_RUN_MAX_ROUTE_KEYS).toBe(500);
    });

    it('reset() clears the report and restarts since, but keeps lifetime stats and log state', () => {
      const { reporter, lines, clock } = setup({ maxLogsPerInterval: 1, intervalMs: 1000 });
      reporter.emit(admission());
      reporter.emit(admission());

      clock.t = 500;
      reporter.reset();
      expect(reporter.report()).toEqual({
        since: 500,
        totals: { shed: 0, degraded: 0, suppressed: 0 },
        byRoute: [],
      });
      expect(reporter.stats()).toEqual({ wouldShed: 2, wouldDegrade: 0, suppressed: 1, logged: 1 });

      // Rate-limit window is unaffected: still suppressed until t >= 1000.
      reporter.emit(admission());
      expect(lines).toHaveLength(1);
      expect(reporter.report().totals).toEqual({ shed: 1, degraded: 0, suppressed: 1 });
    });
  });
});
