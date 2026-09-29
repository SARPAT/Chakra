// Helpers shared by the adapters.
//
// Shed responses are resolved once by the core; serialise each one once too,
// so writing a shed response under overload is a cached lookup plus res.end().

import type { ServerResponse } from 'node:http';
import type { AdmitDecision, ResolvedShedResponse, RouteRuleInput, RouteTable } from '../types';

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

// ─── Completion ───────────────────────────────────────────────────────────────
//
// A permit is released when the handler finishes, not when the client leaves.
// If the client disconnects first, the handler is still using capacity, so the
// slot stays held until the handler ends the response (or ABORT_HOLD_MS passes,
// so a hung handler cannot leak a slot forever). The normal path allocates
// nothing: one shared listener, state on the response object.

/** Longest a slot is held for a disconnected client whose handler never ends. */
export const ABORT_HOLD_MS = 10_000;

const kDecision = Symbol('chakra.decision');
const kAbortedAt = Symbol('chakra.abortedAt');
type Res = ServerResponse & { [kDecision]?: AdmitDecision; [kAbortedAt]?: number };

const held = new Set<Res>();
let sweeper: NodeJS.Timeout | undefined;

/** Call decision.done() once the handler has finished with this response. */
export function releaseOnCompletion(res: ServerResponse, decision: AdmitDecision): void {
  (res as Res)[kDecision] = decision;
  res.once('close', onClose);
}

// 'close' fires after a normal finish too; writableEnded says whether the handler ended it.
function onClose(this: Res): void {
  if (this.writableEnded) return this[kDecision]!.done(this.statusCode, false);
  this[kAbortedAt] = Date.now();
  held.add(this);
  sweeper ??= setInterval(sweep, 25).unref();
}

function sweep(): void {
  const now = Date.now();
  for (const res of held) {
    if (res.writableEnded || now - res[kAbortedAt]! >= ABORT_HOLD_MS) {
      held.delete(res);
      res[kDecision]!.done(res.statusCode, true);
    }
  }
  if (held.size === 0) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}
