// route() tagging: declare a route's priority inline in an Express route chain.
//
//   app.post('/checkout', route('critical'), handler);
//
// The returned middleware is a pass-through. The Express adapter finds tagged
// handlers by walking the app's router stack and adds their route patterns to
// the route table, so the admission decision is made before the handler runs.

import type { Priority, RouteRuleInput, ShedResponse } from '../types';
import { PRIORITIES } from '../types';

/** Property under which a tagged handler carries its rule. */
export const CHAKRA_ROUTE_TAG: unique symbol = Symbol.for('chakra.route');

/**
 * Request property the Express adapter sets to a callback that route() calls with
 * its rule, so the adapter can detect tags that discovery missed.
 */
export const CHAKRA_TAG_CHECK: unique symbol = Symbol.for('chakra.tagCheck');

export interface RouteOptions {
  /** Response sent instead of the default shed response when this route is shed. */
  fallback?: ShedResponse;
}

/** A pass-through middleware carrying a declared route rule. */
export interface TaggedRouteHandler {
  (req: unknown, res: unknown, next: (err?: unknown) => void): void;
  readonly [CHAKRA_ROUTE_TAG]: RouteRuleInput;
}

/**
 * Declare the priority of the route this middleware is mounted on.
 * Throws on an unknown priority, since it runs at app setup time.
 */
export function route(priority: Priority, options: RouteOptions = {}): TaggedRouteHandler {
  if (!PRIORITIES.includes(priority)) {
    throw new Error(
      `chakra.route(): unknown priority "${String(priority)}". Expected one of: ${PRIORITIES.join(', ')}`,
    );
  }
  const rule: RouteRuleInput = Object.freeze(
    options.fallback ? { priority, fallback: options.fallback } : { priority },
  );
  const handler = function chakraRoute(
    req: unknown,
    _res: unknown,
    next: (err?: unknown) => void,
  ): void {
    const check = (req as { [CHAKRA_TAG_CHECK]?: (req: unknown, rule: RouteRuleInput) => void })?.[
      CHAKRA_TAG_CHECK
    ];
    if (check) check(req, rule);
    next();
  };
  Object.defineProperty(handler, CHAKRA_ROUTE_TAG, { value: rule, enumerable: false });
  return handler as TaggedRouteHandler;
}

/** The rule attached by route(), or undefined for any other function. */
export function getRouteTag(fn: unknown): RouteRuleInput | undefined {
  if (typeof fn !== 'function') return undefined;
  return (fn as Partial<TaggedRouteHandler>)[CHAKRA_ROUTE_TAG];
}
