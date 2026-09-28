// Stand-ins used until the real modules are wired in (ADR 0001):
//   - admitAllLimiter      → replaced by createLimiter() from src/limiter/
//   - exactRouteResolver   → replaced by createRouteTable() from src/priority/
// Both are also handy in tests.

import {
  PRIORITIES,
  type AcquireResult,
  type Limiter,
  type LimiterSnapshot,
  type LimiterToken,
  type Priority,
  type PriorityResolver,
  type RequestContext,
  type RouteRule,
  type RouteRuleInput,
} from '../types';

const NOOP_TOKEN: LimiterToken = Object.freeze({ release: () => {} });
const ADMITTED: AcquireResult = Object.freeze({
  admitted: true,
  degraded: false,
  token: NOOP_TOKEN,
});
const IDLE_SNAPSHOT: LimiterSnapshot = Object.freeze({
  limit: Number.POSITIVE_INFINITY,
  inFlight: 0,
  pressure: 0,
  eventLoopDelayMs: 0,
  bandLimits: Object.freeze(
    Object.fromEntries(PRIORITIES.map((p) => [p, Number.POSITIVE_INFINITY])) as Record<
      Priority,
      number
    >,
  ),
});

/** A limiter that admits everything. */
export function admitAllLimiter(): Limiter {
  return {
    acquire: () => ADMITTED,
    snapshot: () => IDLE_SNAPSHOT,
    start: () => {},
    stop: () => {},
  };
}

/** Matches `'METHOD /path'` keys exactly (method `*` matches any). No patterns. */
export function exactRouteResolver(
  routes: Readonly<Record<string, Priority | RouteRuleInput>>,
): PriorityResolver {
  const table = new Map<string, RouteRule>();
  for (const [rawKey, value] of Object.entries(routes)) {
    const [method, path] = rawKey.trim().split(/\s+/, 2);
    const key = `${method.toUpperCase()} ${path}`;
    const input: RouteRuleInput = typeof value === 'string' ? { priority: value } : value;
    table.set(key, Object.freeze({ ...input, key }));
  }
  return {
    match(ctx: RequestContext) {
      return table.get(`${ctx.method} ${ctx.path}`) ?? table.get(`* ${ctx.path}`);
    },
  };
}
