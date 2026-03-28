// Policy Engine — Developer-written rule evaluator
// Step 6 of Dispatcher: last-chance override after Weight Engine scoring.
// Rules pre-compiled at startup into sorted predicate array.
// Budget: < 0.5ms for up to 50 rules. Never throws.

import type { RouteInfo, SessionContext, DispatchOutcome, SuspendedResponse, RPMState } from '../types';
import type { PolicyProvider } from './dispatcher';

// ─── Public types ─────────────────────────────────────────────────────────────

/** All available condition fields for a policy rule (AND logic within one rule) */
export interface PolicyConditions {
  // User / session conditions
  user_tier?: string;
  user_tier_in?: string[];
  is_authenticated?: boolean;
  session_depth_above?: number;
  session_depth_below?: number;
  has_cart_items?: boolean;
  cart_items_above?: number;
  moment_of_value?: 'none' | 'partial' | 'full';
  moment_of_value_any?: boolean;

  // Request conditions
  method?: string;
  method_in?: string[];
  path_matches?: string;    // glob: * matches within segment, ** matches across
  path_exact?: string;
  block?: string;
  block_in?: string[];
  block_not?: string[];

  // Load conditions
  rpm_above?: number;
  rpm_below?: number;
  rpm_between?: [number, number];
  block_rpm_above?: number;
  block_rpm_below?: number;

  // Time conditions
  time_between?: [string, string];      // ["HH:MM", "HH:MM"]
  day_of_week_in?: string[];            // ["saturday", "sunday"]
  day_of_week_not_in?: string[];
}

/** Action to take when a rule matches */
export interface PolicyAction {
  action: 'serve_fully' | 'serve_limited' | 'suspend' | 'redirect' | 'rate_limit';
  hint?: string;                // for serve_limited
  response?: 'empty' | '503' | 'static' | 'cached';  // for suspend
  static_body?: string;         // for suspend + static
  static_status?: number;       // for suspend + static
  cache_max_age_seconds?: number; // for suspend + cached
  to?: string;                  // for redirect
  max_per_minute?: number;      // for rate_limit
  when_exceeded?: PolicyAction; // for rate_limit
}

/** A complete policy rule as written by developer */
export interface PolicyRule {
  name: string;
  if: PolicyConditions;
  then: PolicyAction;
  priority: number;
}

/** Config for the PolicyEngine */
export interface PolicyEngineConfig {
  rules: PolicyRule[];
}

// ─── Internal types ───────────────────────────────────────────────────────────

/** Request context passed to each predicate during evaluation */
interface PolicyContext {
  method: string;       // already uppercased
  path: string;
  block: string;
  session: SessionContext | null;
  rpmState: Readonly<RPMState> | null;
  currentLevel: number;
}

/** A rule compiled from PolicyRule — predicate pre-built, outcome pre-frozen */
interface CompiledRule {
  name: string;
  priority: number;
  predicate: (ctx: PolicyContext) => boolean;
  outcome: Readonly<DispatchOutcome> | null;  // null = not implemented (redirect/rate_limit)
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVE_FULLY_OUTCOME: Readonly<DispatchOutcome> = Object.freeze({ type: 'SERVE_FULLY' });
const DAYS_OF_WEEK = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// ─── Condition compilers ──────────────────────────────────────────────────────

// Pre-built regex for glob placeholder replacement (global flag = replace all occurrences)
const DOUBLE_STAR_RE = /\x00DS\x00/g;

/** Compile a glob pattern string into a pre-built RegExp (done once at startup) */
function compileGlob(pattern: string): RegExp {
  // Escape regex special chars (including ?), then convert globs in two passes using a
  // placeholder so single-* replacement doesn't corrupt the .* produced by **
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped
    .replace(/\*\*/g, '\x00DS\x00')    // protect ** first
    .replace(/\*/g, '[^/]*')           // single * → within-segment match
    .replace(DOUBLE_STAR_RE, '.*');    // ** → cross-segment match (all occurrences)
  return new RegExp(`^${regexStr}$`);
}

/**
 * Compile all condition fields into a single AND-predicate function.
 * Each field becomes one check. Multiple fields = all must be true.
 * Empty conditions (no fields) = always match.
 */
function compileConditions(cond: PolicyConditions): (ctx: PolicyContext) => boolean {
  const checks: Array<(ctx: PolicyContext) => boolean> = [];

  // --- User / session conditions ---

  if (cond.user_tier !== undefined) {
    const tier = cond.user_tier;
    checks.push(ctx => ctx.session?.userTier === tier);
  }

  if (cond.user_tier_in !== undefined) {
    const tiers = new Set(cond.user_tier_in);
    checks.push(ctx => ctx.session?.userTier != null && tiers.has(ctx.session.userTier!));
  }

  if (cond.is_authenticated !== undefined) {
    const want = cond.is_authenticated;
    // Proxy: session with callCount > 0 = authenticated (same design as Weight Engine)
    checks.push(ctx => (ctx.session != null && ctx.session.callCount > 0) === want);
  }

  if (cond.session_depth_above !== undefined) {
    const threshold = cond.session_depth_above;
    checks.push(ctx => (ctx.session?.callCount ?? 0) > threshold);
  }

  if (cond.session_depth_below !== undefined) {
    const threshold = cond.session_depth_below;
    checks.push(ctx => (ctx.session?.callCount ?? 0) < threshold);
  }

  if (cond.has_cart_items !== undefined) {
    const want = cond.has_cart_items;
    checks.push(ctx => (ctx.session?.hasCartItems ?? false) === want);
  }

  if (cond.cart_items_above !== undefined) {
    const threshold = cond.cart_items_above;
    checks.push(ctx => (ctx.session?.cartItemCount ?? 0) > threshold);
  }

  if (cond.moment_of_value !== undefined) {
    const strength = cond.moment_of_value;
    checks.push(ctx => ctx.session?.momentOfValueStrength === strength);
  }

  if (cond.moment_of_value_any === true) {
    checks.push(ctx =>
      ctx.session != null &&
      ctx.session.momentOfValueStrength !== 'none',
    );
  }

  // --- Request conditions ---

  if (cond.method !== undefined) {
    const m = cond.method.toUpperCase();
    checks.push(ctx => ctx.method === m);
  }

  if (cond.method_in !== undefined) {
    const methods = new Set(cond.method_in.map(m => m.toUpperCase()));
    checks.push(ctx => methods.has(ctx.method));
  }

  if (cond.path_matches !== undefined) {
    const regex = compileGlob(cond.path_matches);    // compiled once at startup
    checks.push(ctx => regex.test(ctx.path));
  }

  if (cond.path_exact !== undefined) {
    const exactPath = cond.path_exact;
    checks.push(ctx => ctx.path === exactPath);
  }

  if (cond.block !== undefined) {
    const blockName = cond.block;
    checks.push(ctx => ctx.block === blockName);
  }

  if (cond.block_in !== undefined) {
    const blocks = new Set(cond.block_in);
    checks.push(ctx => blocks.has(ctx.block));
  }

  if (cond.block_not !== undefined) {
    const excluded = new Set(cond.block_not);
    checks.push(ctx => !excluded.has(ctx.block));
  }

  // --- Load conditions ---

  if (cond.rpm_above !== undefined) {
    const threshold = cond.rpm_above;
    checks.push(ctx => (ctx.rpmState?.global ?? 0) > threshold);
  }

  if (cond.rpm_below !== undefined) {
    const threshold = cond.rpm_below;
    checks.push(ctx => (ctx.rpmState?.global ?? 0) < threshold);
  }

  if (cond.rpm_between !== undefined) {
    const [lo, hi] = cond.rpm_between;
    checks.push(ctx => {
      const rpm = ctx.rpmState?.global ?? 0;
      return rpm >= lo && rpm <= hi;
    });
  }

  if (cond.block_rpm_above !== undefined) {
    const threshold = cond.block_rpm_above;
    checks.push(ctx => (ctx.rpmState?.perBlock[ctx.block] ?? 0) > threshold);
  }

  if (cond.block_rpm_below !== undefined) {
    const threshold = cond.block_rpm_below;
    checks.push(ctx => (ctx.rpmState?.perBlock[ctx.block] ?? 0) < threshold);
  }

  // --- Time conditions ---

  if (cond.time_between !== undefined) {
    const [startStr, endStr] = cond.time_between;
    checks.push(() => isCurrentTimeBetween(startStr, endStr));
  }

  if (cond.day_of_week_in !== undefined) {
    const days = new Set(cond.day_of_week_in.map(d => d.toLowerCase()));
    checks.push(() => days.has(DAYS_OF_WEEK[new Date().getDay()]));
  }

  if (cond.day_of_week_not_in !== undefined) {
    const days = new Set(cond.day_of_week_not_in.map(d => d.toLowerCase()));
    checks.push(() => !days.has(DAYS_OF_WEEK[new Date().getDay()]));
  }

  // No conditions = always match
  if (checks.length === 0) return () => true;

  // AND logic: all checks must pass
  return (ctx: PolicyContext) => {
    for (const check of checks) {
      if (!check(ctx)) return false;
    }
    return true;
  };
}

// ─── Action compiler ──────────────────────────────────────────────────────────

/** Convert PolicyAction to pre-frozen DispatchOutcome. Returns null for unimplemented actions. */
function compileAction(action: PolicyAction): Readonly<DispatchOutcome> | null {
  switch (action.action) {
    case 'serve_fully':
      return SERVE_FULLY_OUTCOME;

    case 'serve_limited':
      return Object.freeze<DispatchOutcome>({
        type: 'SERVE_LIMITED',
        hint: action.hint ?? 'reduce-payload',
      });

    case 'suspend': {
      const response = buildSuspendResponse(action);
      return Object.freeze<DispatchOutcome>({ type: 'SUSPEND', response });
    }

    case 'redirect':
    case 'rate_limit':
      // Not yet implemented — null causes Dispatcher to use default weight-based decision
      return null;

    default:
      return null;
  }
}

/** Build a SuspendedResponse from a policy suspend action definition */
function buildSuspendResponse(action: PolicyAction): SuspendedResponse {
  const baseHeaders: Record<string, string> = { 'X-Chakra-Active': 'true' };

  switch (action.response) {
    case '503':
      return {
        status: 503,
        body: 'Service temporarily unavailable',
        headers: { ...baseHeaders, 'Retry-After': '30' },
      };

    case 'static':
      return {
        status: action.static_status ?? 200,
        body: action.static_body ?? '{}',
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      };

    case 'cached':
      // Cache infrastructure deferred — empty fallback until Session Cache is wired in
      return { status: 200, body: {}, headers: baseHeaders };

    case 'empty':
    default:
      return { status: 200, body: {}, headers: baseHeaders };
  }
}

// ─── Rule compiler ────────────────────────────────────────────────────────────

/** Compile raw PolicyRules into a sorted CompiledRules array */
function compileRules(rules: PolicyRule[]): readonly CompiledRule[] {
  return rules
    .map(rule => ({
      name: rule.name,
      priority: rule.priority,
      predicate: compileConditions(rule.if),
      outcome: compileAction(rule.then),
    }))
    .sort((a, b) => b.priority - a.priority);  // descending: higher priority = evaluated first
}

// ─── PolicyEngine class ───────────────────────────────────────────────────────

export class PolicyEngine implements PolicyProvider {
  private compiledRules: readonly CompiledRule[];
  private rpmState: Readonly<RPMState> | null = null;

  constructor(config: PolicyEngineConfig) {
    try {
      this.compiledRules = compileRules(config.rules);
    } catch {
      // Malformed rules — start with empty set rather than crashing (CHAKRA Rule #1)
      this.compiledRules = [];
    }
  }

  /**
   * Evaluate compiled rules against the request context.
   * Returns first matching rule's outcome, or null if no rule matches.
   * Budget: < 0.5ms for up to 50 rules. Never throws.
   */
  evaluate(
    method: string,
    path: string,
    routeInfo: RouteInfo,
    sessionContext: SessionContext | null,
    currentLevel: number,
  ): DispatchOutcome | null {
    try {
      const ctx: PolicyContext = {
        method: method.toUpperCase(),
        path,
        block: routeInfo.block,
        session: sessionContext,
        rpmState: this.rpmState,
        currentLevel,
      };

      for (const rule of this.compiledRules) {
        if (rule.predicate(ctx)) {
          if (rule.outcome !== null) {
            return rule.outcome;
          }
          // Unimplemented action — continue to next rule
        }
      }

      return null;
    } catch {
      // Never throw from Policy Engine — null = Dispatcher uses default decision
      return null;
    }
  }

  /**
   * Update RPM state snapshot used for load conditions.
   * Called by background RPM Engine tick. Atomic single-assignment.
   */
  setRPMState(state: Readonly<RPMState>): void {
    this.rpmState = state;
  }

  /**
   * Live-update rule set without restart.
   * Atomic pointer swap — new rules active on next evaluate() call.
   */
  updateRules(rules: PolicyRule[]): void {
    try {
      this.compiledRules = compileRules(rules);
    } catch {
      // Keep existing rules on compile failure — better to run stale rules than no rules
    }
  }

  /** Current rule count — Dashboard warns if > 100 (performance budget) */
  getRuleCount(): number {
    return this.compiledRules.length;
  }

  /** Rule names in priority order (for Dashboard display) */
  getRuleNames(): string[] {
    return this.compiledRules.map(r => r.name);
  }
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

/** Check if current wall-clock time falls within [startStr, endStr] (HH:MM) */
function isCurrentTimeBetween(startStr: string, endStr: string): boolean {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = startStr.split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;

  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  }
  // Spans midnight
  return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
}

export default PolicyEngine;
