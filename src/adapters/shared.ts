// Helpers shared by the adapters.
//
// Shed responses are resolved once by the core; serialise each one once too,
// so writing a shed response under overload is a cached lookup plus res.end().

import type { ResolvedShedResponse, RouteRuleInput, RouteTable } from '../types';

export interface SerialisedShed {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Buffer;
}

const cache = new WeakMap<ResolvedShedResponse, SerialisedShed>();

export function serialiseShed(r: ResolvedShedResponse): SerialisedShed {
  let s = cache.get(r);
  if (!s) {
    const raw = typeof r.body === 'string' || Buffer.isBuffer(r.body);
    const hasType = Object.keys(r.headers).some((k) => k.toLowerCase() === 'content-type');
    const headers = hasType
      ? r.headers
      : {
          ...r.headers,
          'Content-Type': raw ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
        };
    s = Object.freeze({
      status: r.status,
      headers,
      body: raw ? (r.body as string | Buffer) : JSON.stringify(r.body),
    });
    cache.set(r, s);
  }
  return s;
}

/**
 * Add a route discovered from the framework, unless the developer configured a
 * rule for exactly this pattern: explicit config wins over annotations.
 */
export function addUnlessConfigured(
  table: RouteTable,
  method: string,
  pattern: string,
  rule: RouteRuleInput,
): void {
  const norm = pattern.length > 1 ? pattern.replace(/\/+$/, '') : pattern;
  const existing = table.match({ method, path: norm, route: norm, headers: {} });
  if (existing && existing.key.slice(existing.key.indexOf(' ') + 1) === norm) return;
  table.add(method, pattern, rule);
}
