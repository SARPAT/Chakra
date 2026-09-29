// Route table: maps a request to its declared route rule.
//
//   const table = createRouteTable({
//     'POST /checkout': 'critical',
//     'GET /api/products/:id': { priority: 'high', fallback: { body: 'try later' } },
//     '* /recommendations/*': 'sheddable',
//   });
//
// Keys are 'METHOD /pattern' ('*' or no method matches any method). Patterns
// support static segments, `:param` and a trailing `*`. Everything is compiled
// in add(); match() does Map lookups and precompiled regex tests only, never
// throws, and reads one immutable snapshot so concurrent add() calls are safe.

import type { Priority, RequestContext, RouteRule, RouteRuleInput, RouteTable } from '../types';
import { PRIORITIES } from '../types';

interface Entry {
  readonly method: string;
  readonly pattern: string;
  readonly rule: RouteRule;
  readonly re: RegExp | null; // null for static patterns
  readonly statics: number;
  readonly wildcard: boolean;
  readonly seq: number;
}

interface Snapshot {
  /** pattern (or static path) → method → rule. */
  readonly byPattern: ReadonlyMap<string, ReadonlyMap<string, RouteRule>>;
  /** Dynamic patterns, most specific first. */
  readonly dynamic: readonly Entry[];
}

const METHOD = /^(\*|[A-Z]+)$/;

export function createRouteTable(
  routes: Record<string, Priority | RouteRuleInput> = {},
): RouteTable {
  const entries = new Map<string, Entry>();
  let snap: Snapshot = { byPattern: new Map(), dynamic: [] };

  function add(method: string, pattern: string, input: Priority | RouteRuleInput): void {
    const m = String(method).trim().toUpperCase();
    if (!METHOD.test(m))
      throw new Error(`chakra: invalid method "${method}" for route "${pattern}"`);
    const p = normalise(pattern);
    const key = `${m} ${p}`;
    const rule = toRule(input, key);
    const segs = p.split('/').slice(1);
    const wildcard = segs[segs.length - 1] === '*';
    const dynamic = wildcard || segs.some((s) => s.startsWith(':'));
    const re = dynamic
      ? new RegExp(
          '^' +
            segs
              .map((s, i) =>
                s === '*' && i === segs.length - 1
                  ? '(?:/.*)?'
                  : s.startsWith(':')
                    ? '/[^/]+'
                    : '/' + escape(s),
              )
              .join('') +
            '/?$',
        )
      : null;
    const seq = entries.get(key)?.seq ?? entries.size;
    const statics = segs.filter((s) => s !== '*' && !s.startsWith(':')).length;
    entries.set(key, Object.freeze({ method: m, pattern: p, rule, re, statics, wildcard, seq }));
    snap = build(entries);
  }

  for (const [raw, value] of Object.entries(routes)) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length > 2 || parts[parts.length - 1] === '')
      throw new Error(`chakra: malformed route key "${raw}"`);
    add(parts.length === 2 ? parts[0] : '*', parts[parts.length - 1], value);
  }

  // HEAD falls back to the GET rule: Express serves HEAD with GET handlers, and
  // load balancers often probe health checks with HEAD.
  function match(ctx: RequestContext): RouteRule | undefined {
    return lookup(ctx, ctx.method) ?? (ctx.method === 'HEAD' ? lookup(ctx, 'GET') : undefined);
  }

  function lookup(ctx: RequestContext, method: string): RouteRule | undefined {
    try {
      const { byPattern, dynamic } = snap;
      const hit =
        (ctx.route !== undefined && pick(byPattern.get(ctx.route), method)) ||
        pick(byPattern.get(ctx.path), method) ||
        (ctx.path.length > 1 &&
          ctx.path.endsWith('/') &&
          pick(byPattern.get(ctx.path.slice(0, -1)), method));
      if (hit) return hit;
      for (const e of dynamic) {
        if ((e.method === method || e.method === '*') && e.re!.test(ctx.path)) return e.rule;
      }
    } catch {
      // match() is on the hot path and must never throw.
    }
    return undefined;
  }

  return {
    match,
    add,
    get size() {
      return entries.size;
    },
  };
}

function pick(
  byMethod: ReadonlyMap<string, RouteRule> | undefined,
  method: string,
): RouteRule | undefined {
  return byMethod && (byMethod.get(method) ?? byMethod.get('*'));
}

function build(entries: Map<string, Entry>): Snapshot {
  const byPattern = new Map<string, Map<string, RouteRule>>();
  for (const e of entries.values()) {
    let slot = byPattern.get(e.pattern);
    if (!slot) byPattern.set(e.pattern, (slot = new Map()));
    slot.set(e.method, e.rule);
  }
  const dynamic = [...entries.values()]
    .filter((e) => e.re !== null)
    .sort(
      (a, b) =>
        b.statics - a.statics ||
        Number(a.wildcard) - Number(b.wildcard) ||
        Number(a.method === '*') - Number(b.method === '*') ||
        b.pattern.length - a.pattern.length ||
        a.seq - b.seq,
    );
  return { byPattern, dynamic };
}

function toRule(input: Priority | RouteRuleInput, key: string): RouteRule {
  const rule: RouteRuleInput = typeof input === 'string' ? { priority: input } : input;
  if (!rule || !PRIORITIES.includes(rule.priority)) {
    throw new Error(`chakra: route "${key}" has unknown priority "${String(rule?.priority)}"`);
  }
  return Object.freeze({ ...rule, key });
}

function normalise(pattern: string): string {
  if (typeof pattern !== 'string' || !pattern.startsWith('/')) {
    throw new Error(`chakra: route pattern "${String(pattern)}" must start with "/"`);
  }
  const p = pattern.replace(/\/+/g, '/');
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
