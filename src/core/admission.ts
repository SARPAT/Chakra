// Admission core — the framework-free decision point, run once per request.
//
// decide() order:
//   1. mode `off` → admit untouched, emit nothing
//   2. priority: options.priority(ctx) → resolver rule → defaultPriority
//   3. band closed by an override → shed
//   4. limiter.acquire(priority, force = dry-run)
//   5. dry-run turns every shed into an admit with wouldShed = true
// Any internal error admits the request. decide() never throws.

import { performance } from 'node:perf_hooks';
import {
  NOOP_SINK,
  UNMATCHED_ROUTE,
  type AdmissionCore,
  type AdmissionDecision,
  type ChakraEventSink,
  type ChakraRequestInfo,
  type Decision,
  type Limiter,
  type LimiterToken,
  type Mode,
  type Priority,
  type PriorityResolver,
  type RequestContext,
  type ResolvedShedResponse,
  type RouteRule,
  type ShedResponse,
} from '../types';
import type { ResolvedOptions } from '../config/schema';
import { isPriority } from '../config/schema';
import { onceLogger } from '../utils/logger';

export interface Overrides {
  /** Bands shed unconditionally, e.g. `['sheddable']` during an incident. */
  readonly closedBands?: readonly Priority[];
}

export interface AdmissionCoreDeps {
  readonly options: ResolvedOptions;
  readonly limiter: Limiter;
  readonly resolver: PriorityResolver;
  readonly sink: ChakraEventSink;
}

export interface ControllableAdmissionCore extends AdmissionCore {
  readonly mode: Mode;
  setOverrides(overrides: Overrides): void;
  getOverrides(): Required<Overrides>;
}

type ShedReason = 'limit_exceeded' | 'band_closed';

export function createAdmissionCore(deps: AdmissionCoreDeps): ControllableAdmissionCore {
  const { options, limiter, resolver, sink } = deps;
  const mode = options.mode;
  const dryRun = mode === 'dry-run';
  const emitting = sink !== NOOP_SINK;
  const log = onceLogger(
    options.logger === false ? { info() {}, warn() {}, error() {} } : options.logger,
  );

  let closedBands: ReadonlySet<Priority> = new Set();
  const defaultResponse = resolveShedResponse(options.shedResponse);
  const fallbackCache = new WeakMap<RouteRule, ResolvedShedResponse>();

  const passThrough: Decision = Object.freeze({
    outcome: 'admit',
    info: Object.freeze({
      priority: options.defaultPriority,
      degraded: false,
      wouldShed: false,
      pressure: 0,
      mode,
    }),
    done: noop,
  });

  function emit(event: Parameters<ChakraEventSink['emit']>[0]): void {
    try {
      sink.emit(event);
    } catch (err) {
      log.warnOnce('sink', `metrics sink threw and was ignored: ${describe(err)}`);
    }
  }

  function matchRule(ctx: RequestContext): RouteRule | undefined {
    try {
      return resolver.match(ctx);
    } catch (err) {
      log.warnOnce('resolver', `route resolver threw and was ignored: ${describe(err)}`);
      return undefined;
    }
  }

  function resolvePriority(ctx: RequestContext, rule: RouteRule | undefined): Priority {
    if (options.priority) {
      try {
        const p = options.priority(ctx);
        if (p !== undefined) {
          if (isPriority(p)) return p;
          log.warnOnce(
            'priority-value',
            `priority() returned an unknown value "${String(p)}"; ignored`,
          );
        }
      } catch (err) {
        log.warnOnce('priority-fn', `priority() threw and was ignored: ${describe(err)}`);
      }
    }
    return rule?.priority ?? options.defaultPriority;
  }

  function shedResponseFor(rule: RouteRule | undefined): ResolvedShedResponse {
    if (!rule?.fallback) return defaultResponse;
    let cached = fallbackCache.get(rule);
    if (!cached) {
      cached = resolveShedResponse({ ...options.shedResponse, ...rule.fallback });
      fallbackCache.set(rule, cached);
    }
    return cached;
  }

  function admit(info: ChakraRequestInfo, token: LimiterToken | null): Decision {
    let finished = false;
    return {
      outcome: 'admit',
      info,
      done(statusCode: number, aborted = false) {
        if (finished) return;
        finished = true;
        if (!token) return;
        try {
          token.release(aborted ? 'dropped' : statusCode >= 500 ? 'error' : 'success');
        } catch (err) {
          log.warnOnce('release', `limiter token release threw and was ignored: ${describe(err)}`);
        }
      },
    };
  }

  function decide(ctx: RequestContext): Decision {
    if (mode === 'off') return passThrough;
    const start = performance.now();
    try {
      const rule = matchRule(ctx);
      const priority = resolvePriority(ctx, rule);
      const route = rule?.key ?? UNMATCHED_ROUTE;

      let reason: ShedReason | undefined;
      let admitted: boolean;
      let degraded = false;
      let token: LimiterToken | null = null;

      if (closedBands.has(priority)) {
        reason = 'band_closed';
        admitted = false;
        if (dryRun) token = limiter.acquire(priority, true).token;
      } else {
        const result = limiter.acquire(priority, dryRun);
        admitted = result.admitted;
        degraded = result.degraded;
        token = result.token;
        if (!admitted) reason = 'limit_exceeded';
      }

      const snap = limiter.snapshot();
      const decision: AdmissionDecision = !admitted ? 'shed' : degraded ? 'degraded' : 'admitted';
      if (emitting)
        emit({
          type: 'admission',
          decision,
          band: priority,
          route,
          dryRun,
          reason,
          limit: snap.limit,
          inFlight: snap.inFlight,
          at: start,
        });

      const info: ChakraRequestInfo = {
        priority,
        degraded: admitted && degraded,
        wouldShed: dryRun && !admitted,
        pressure: snap.pressure,
        mode,
      };

      if (admitted || dryRun) return admit(info, token);

      if (emitting)
        emit({
          type: 'shed_complete',
          band: priority,
          route,
          durationMs: performance.now() - start,
        });
      return { outcome: 'shed', info, response: shedResponseFor(rule) };
    } catch (err) {
      log.warnOnce('decide', `admission failed and the request was let through: ${describe(err)}`);
      return passThrough;
    }
  }

  return {
    mode,
    decide,
    setOverrides(overrides: Overrides) {
      const bands = (overrides.closedBands ?? []).filter(isPriority);
      closedBands = new Set(bands);
      if (bands.includes('critical')) {
        log.warn('override closes the "critical" band: every critical request will be shed');
      }
    },
    getOverrides() {
      return { closedBands: [...closedBands] };
    },
  };
}

/** Merge defaults into a ShedResponse and build its headers once. */
export function resolveShedResponse(input: ShedResponse): ResolvedShedResponse {
  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  if (input.retryAfterSeconds !== undefined && !hasHeader(headers, 'retry-after')) {
    headers['Retry-After'] = String(input.retryAfterSeconds);
  }
  return Object.freeze({
    status: input.status ?? 503,
    headers: Object.freeze(headers),
    body: input.body ?? { error: 'overloaded' },
  });
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function noop(): void {}
