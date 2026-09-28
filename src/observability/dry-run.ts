// Dry-run mode — CHAKRA computes its real decisions but always lets the
// request through, and logs what it would have done. Never throws into the caller.

import type { ChakraEvent, ChakraEventSink, PriorityBand } from '../types';

/** Reports and suppression windows track at most MAX keys; new ones then use the OVERFLOW route. */
export const DRY_RUN_OVERFLOW_ROUTE = '__other__';
export const DRY_RUN_MAX_ROUTE_KEYS = 500;

const SUMMARY_TOP_KEYS = 20;

/** `log` gets one JSON line (no newline; default stdout). Defaults: 10 lines per 10 000 ms, `Date.now`. */
export interface DryRunReporterOptions {
  log?: (line: string) => void;
  maxLogsPerInterval?: number;
  intervalMs?: number;
  now?: () => number;
}

/** Lifetime totals (unaffected by `reset()`). */
export interface DryRunStats {
  wouldShed: number;
  wouldDegrade: number;
  suppressed: number;
  logged: number;
}
export interface DryRunRouteReport {
  route: string;
  band: PriorityBand;
  shed: number;
  degraded: number;
}
/** Counts since creation or the last `reset()`; `byRoute` is most would-shed first. */
export interface DryRunReport {
  since: number;
  totals: { shed: number; degraded: number; suppressed: number };
  byRoute: DryRunRouteReport[];
}

/** `flush()` writes any pending summary now; `reset()` clears only the report. */
export interface DryRunReporter extends ChakraEventSink {
  flush(): void;
  stats(): DryRunStats;
  report(): DryRunReport;
  reset(): void;
}

/**
 * A sink that logs dry-run admission events CHAKRA would have shed or degraded,
 * one JSON line each, at most `maxLogsPerInterval` per window. The rest are
 * counted by `decision|band|route` and summarised in one line when the next
 * window starts (checked on the next event) or on `flush()`. No timers.
 */
export function createDryRunReporter(opts: DryRunReporterOptions = {}): DryRunReporter {
  const log = opts.log ?? ((line: string) => void process.stdout.write(line + '\n'));
  const now = opts.now ?? Date.now;
  const maxLogs = opts.maxLogsPerInterval ?? 10;
  const intervalMs = opts.intervalMs ?? 10_000;

  const totals: DryRunStats = { wouldShed: 0, wouldDegrade: 0, suppressed: 0, logged: 0 };
  let [windowStart, loggedInWindow, suppressedInWindow, reportSuppressed, since] = [
    -Infinity,
    0,
    0,
    0,
    now(),
  ];
  let suppressed = new Map<string, number>();
  let byRoute = new Map<string, DryRunRouteReport>();

  const write = (obj: object): void => {
    try {
      log(JSON.stringify(obj));
    } catch {
      /* best-effort */
    }
  };

  function writeSummary(): void {
    if (suppressedInWindow === 0) return;
    const top = [...suppressed].sort((a, b) => b[1] - a[1]).slice(0, SUMMARY_TOP_KEYS);
    write({
      level: 'info',
      msg: 'chakra dry-run: suppressed similar logs',
      component: 'chakra',
      mode: 'dry-run',
      suppressed: suppressedInWindow,
      counts: Object.fromEntries(top),
    });
    [suppressedInWindow, suppressed] = [0, new Map()];
  }

  /** `route`, or the overflow route if `prefix|route` is new and `map` is full. */
  const cap = (map: Map<string, unknown>, prefix: string, route: string): string =>
    map.size < DRY_RUN_MAX_ROUTE_KEYS || map.has(`${prefix}|${route}`)
      ? route
      : DRY_RUN_OVERFLOW_ROUTE;

  return {
    emit(event: ChakraEvent): void {
      if (event?.type !== 'admission' || event.dryRun !== true || event.decision === 'admitted')
        return;
      try {
        const { decision, band, route } = event;
        const shed = decision === 'shed';
        const r = cap(byRoute, band, route);
        const rKey = `${band}|${r}`;
        let entry = byRoute.get(rKey);
        if (!entry) byRoute.set(rKey, (entry = { route: r, band, shed: 0, degraded: 0 }));
        if (shed) {
          totals.wouldShed++;
          entry.shed++;
        } else {
          totals.wouldDegrade++;
          entry.degraded++;
        }

        const t = now();
        if (t - windowStart >= intervalMs) {
          writeSummary();
          [windowStart, loggedInWindow] = [t, 0];
        }
        if (loggedInWindow < maxLogs) {
          loggedInWindow++;
          totals.logged++;
          write({
            level: 'info',
            msg: `chakra dry-run: would have ${shed ? 'shed' : 'degraded'}`,
            component: 'chakra',
            mode: 'dry-run',
            decision,
            band,
            route,
            reason: event.reason,
            limit: event.limit,
            inFlight: event.inFlight,
          });
          return;
        }
        totals.suppressed++;
        reportSuppressed++;
        suppressedInWindow++;
        const key = `${decision}|${band}|${cap(suppressed, `${decision}|${band}`, route)}`;
        suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
      } catch {
        // Never let reporting break the request path.
      }
    },
    flush(): void {
      try {
        writeSummary();
        if (now() - windowStart >= intervalMs) loggedInWindow = 0;
      } catch {
        /* best-effort */
      }
    },
    stats: () => ({ ...totals }),
    report(): DryRunReport {
      const byRouteCopy = [...byRoute.values()].map((e) => ({ ...e }));
      const totals = { shed: 0, degraded: 0, suppressed: reportSuppressed };
      for (const e of byRouteCopy) {
        totals.shed += e.shed;
        totals.degraded += e.degraded;
      }
      byRouteCopy.sort(
        (a, b) => b.shed - a.shed || b.degraded - a.degraded || a.route.localeCompare(b.route),
      );
      return { since, totals, byRoute: byRouteCopy };
    },
    reset: () => void ([since, reportSuppressed, byRoute] = [now(), 0, new Map()]),
  };
}
