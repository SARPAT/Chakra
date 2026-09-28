// Public options for chakra() and their validation.
//
// Invalid options fail loudly when chakra() is called, listing every problem at once.
// After construction nothing in CHAKRA may throw into the host application.

import {
  PRIORITIES,
  type ChakraEventSink,
  type LimiterOptions,
  type Logger,
  type Mode,
  type Priority,
  type RequestContext,
  type RouteRuleInput,
  type ShedResponse,
} from '../types';
import { consoleLogger } from '../utils/logger';

// ─── Options ──────────────────────────────────────────────────────────────────

export interface MetricsOptions {
  /** Metric name prefix. Default `chakra_`. */
  readonly prefix?: string;
  /** Cap on distinct `route` label values. Default 200. */
  readonly maxRoutes?: number;
}

export interface ChakraOptions {
  /** Default `enforce`. The `CHAKRA_MODE` environment variable overrides this. */
  readonly mode?: Mode;
  /** Priority for requests no rule matches. Default `normal`. */
  readonly defaultPriority?: Priority;
  /** Route rules keyed by `'METHOD /pattern'`, e.g. `{ 'POST /checkout': 'critical' }`. */
  readonly routes?: Readonly<Record<string, Priority | RouteRuleInput>>;
  /**
   * Per-request priority, checked before route rules. Use the authenticated user
   * (`ctx.user`), never request headers. Return undefined to fall through.
   */
  readonly priority?: (ctx: RequestContext) => Priority | undefined;
  readonly limiter?: LimiterOptions;
  /** Default response for shed requests. Routes can override it with `fallback`. */
  readonly shedResponse?: ShedResponse;
  /** Prometheus metrics (default on), `false` to disable, or your own event sink. */
  readonly metrics?: false | MetricsOptions | ChakraEventSink;
  /** Default: console with a `[CHAKRA]` prefix. `false` silences CHAKRA. */
  readonly logger?: Logger | false;
}

/** Options after defaults and environment overrides are applied. */
export interface ResolvedOptions {
  readonly mode: Mode;
  readonly defaultPriority: Priority;
  readonly routes: Readonly<Record<string, Priority | RouteRuleInput>>;
  readonly priority: ((ctx: RequestContext) => Priority | undefined) | undefined;
  readonly limiter: LimiterOptions;
  readonly shedResponse: ShedResponse;
  readonly metrics: false | MetricsOptions | ChakraEventSink;
  readonly logger: Logger | false;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_SHED_RESPONSE: ShedResponse = Object.freeze({
  status: 503,
  body: Object.freeze({ error: 'overloaded', message: 'The service is busy. Please retry shortly.' }),
  retryAfterSeconds: 1,
});

const MODES: readonly Mode[] = ['enforce', 'dry-run', 'off'];
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', '*']);
const TOP_LEVEL_KEYS = new Set([
  'mode', 'defaultPriority', 'routes', 'priority', 'limiter', 'shedResponse', 'metrics', 'logger',
]);
const LIMITER_KEYS = new Set([
  'algorithm', 'initialLimit', 'minLimit', 'maxLimit', 'maxEventLoopDelayMs', 'bandShares', 'degradeAt',
]);
const SHED_KEYS = new Set(['status', 'headers', 'body', 'retryAfterSeconds']);

// ─── Errors ───────────────────────────────────────────────────────────────────

export class ChakraConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid CHAKRA options:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ChakraConfigError';
    this.problems = problems;
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate options and apply defaults. Throws ChakraConfigError listing every problem.
 * `env` is injectable for tests; it defaults to `process.env`.
 */
export function resolveOptions(
  input: ChakraOptions = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedOptions {
  const problems: string[] = [];

  const raw: unknown = input;
  if (!isPlainObject(raw)) {
    throw new ChakraConfigError(['options must be an object']);
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) problems.push(`unknown option "${key}"`);
  }

  const mode = resolveMode(input.mode, env.CHAKRA_MODE, problems);

  const defaultPriority = input.defaultPriority ?? 'normal';
  if (!isPriority(defaultPriority)) {
    problems.push(`defaultPriority must be one of ${PRIORITIES.join(', ')}; got ${show(defaultPriority)}`);
  }

  const routes = input.routes ?? {};
  if (!isPlainObject(routes)) {
    problems.push('routes must be an object keyed by "METHOD /pattern"');
  } else {
    for (const [key, value] of Object.entries(routes)) validateRoute(key, value, problems);
  }

  if (input.priority !== undefined && typeof input.priority !== 'function') {
    problems.push('priority must be a function (ctx) => Priority | undefined');
  }

  const limiter = input.limiter ?? {};
  validateLimiter(limiter, problems);

  const shedResponse = input.shedResponse ?? DEFAULT_SHED_RESPONSE;
  validateShedResponse('shedResponse', shedResponse, problems);

  const metrics = input.metrics ?? {};
  validateMetrics(metrics, problems);

  const logger = input.logger ?? undefined;
  if (logger !== undefined && logger !== false && !isLogger(logger)) {
    problems.push('logger must be false or an object with info, warn and error functions');
  }

  if (problems.length > 0) throw new ChakraConfigError(problems);

  return Object.freeze({
    mode,
    defaultPriority,
    routes,
    priority: input.priority,
    limiter,
    shedResponse: { ...DEFAULT_SHED_RESPONSE, ...shedResponse },
    metrics,
    logger: logger ?? consoleLogger,
  });
}

function resolveMode(
  option: Mode | undefined,
  envValue: string | undefined,
  problems: string[],
): Mode {
  if (envValue !== undefined && envValue !== '') {
    const fromEnv = envValue.trim().toLowerCase();
    if (isMode(fromEnv)) return fromEnv;
    problems.push(`CHAKRA_MODE must be one of ${MODES.join(', ')}; got ${show(envValue)}`);
  }
  if (option === undefined) return 'enforce';
  if (isMode(option)) return option;
  problems.push(`mode must be one of ${MODES.join(', ')}; got ${show(option)}`);
  return 'enforce';
}

function validateRoute(key: string, value: unknown, problems: string[]): void {
  const match = /^(\S+)\s+(\/\S*)$/.exec(key.trim());
  if (!match) {
    problems.push(`routes key ${show(key)} must look like "GET /path"`);
  } else if (!METHODS.has(match[1].toUpperCase())) {
    problems.push(`routes key ${show(key)} has unknown method "${match[1]}"`);
  }

  if (isPriority(value)) return;
  if (!isPlainObject(value)) {
    problems.push(`routes[${show(key)}] must be a priority or { priority, fallback? }`);
    return;
  }
  for (const k of Object.keys(value)) {
    if (k !== 'priority' && k !== 'fallback') problems.push(`routes[${show(key)}] has unknown key "${k}"`);
  }
  if (!isPriority(value.priority)) {
    problems.push(`routes[${show(key)}].priority must be one of ${PRIORITIES.join(', ')}`);
  }
  if (value.fallback !== undefined) {
    validateShedResponse(`routes[${show(key)}].fallback`, value.fallback, problems);
  }
}

function validateLimiter(limiter: unknown, problems: string[]): void {
  if (!isPlainObject(limiter)) {
    problems.push('limiter must be an object');
    return;
  }
  for (const k of Object.keys(limiter)) {
    if (!LIMITER_KEYS.has(k)) problems.push(`limiter has unknown option "${k}"`);
  }
  const { algorithm, initialLimit, minLimit, maxLimit, maxEventLoopDelayMs, bandShares, degradeAt } =
    limiter as LimiterOptions;

  if (algorithm !== undefined && algorithm !== 'gradient2' && algorithm !== 'aimd') {
    problems.push(`limiter.algorithm must be "gradient2" or "aimd"; got ${show(algorithm)}`);
  }
  checkPositiveInt('limiter.initialLimit', initialLimit, problems);
  checkPositiveInt('limiter.minLimit', minLimit, problems);
  checkPositiveInt('limiter.maxLimit', maxLimit, problems);
  if (typeof minLimit === 'number' && typeof maxLimit === 'number' && minLimit > maxLimit) {
    problems.push('limiter.minLimit must not exceed limiter.maxLimit');
  }
  if (
    typeof initialLimit === 'number' &&
    ((typeof minLimit === 'number' && initialLimit < minLimit) ||
      (typeof maxLimit === 'number' && initialLimit > maxLimit))
  ) {
    problems.push('limiter.initialLimit must be between minLimit and maxLimit');
  }
  if (maxEventLoopDelayMs !== undefined && !(isFiniteNumber(maxEventLoopDelayMs) && maxEventLoopDelayMs > 0)) {
    problems.push('limiter.maxEventLoopDelayMs must be a positive number');
  }
  if (degradeAt !== undefined && !(isFiniteNumber(degradeAt) && degradeAt > 0 && degradeAt <= 1)) {
    problems.push('limiter.degradeAt must be a number in (0, 1]');
  }
  if (bandShares !== undefined) {
    if (!isPlainObject(bandShares)) {
      problems.push('limiter.bandShares must be an object keyed by priority');
    } else {
      for (const [band, share] of Object.entries(bandShares)) {
        if (!isPriority(band)) problems.push(`limiter.bandShares has unknown priority "${band}"`);
        else if (!(isFiniteNumber(share) && share > 0 && share <= 1)) {
          problems.push(`limiter.bandShares.${band} must be a number in (0, 1]`);
        }
      }
    }
  }
}

function validateShedResponse(path: string, value: unknown, problems: string[]): void {
  if (!isPlainObject(value)) {
    problems.push(`${path} must be an object`);
    return;
  }
  for (const k of Object.keys(value)) {
    if (!SHED_KEYS.has(k)) problems.push(`${path} has unknown key "${k}"`);
  }
  const { status, headers, retryAfterSeconds } = value as ShedResponse;
  if (status !== undefined && !(Number.isInteger(status) && status >= 200 && status <= 599)) {
    problems.push(`${path}.status must be an HTTP status code`);
  }
  if (headers !== undefined) {
    if (!isPlainObject(headers) || Object.values(headers).some((v) => typeof v !== 'string')) {
      problems.push(`${path}.headers must be an object of strings`);
    }
  }
  if (retryAfterSeconds !== undefined && !(Number.isInteger(retryAfterSeconds) && retryAfterSeconds >= 0)) {
    problems.push(`${path}.retryAfterSeconds must be a non-negative integer`);
  }
}

function validateMetrics(metrics: unknown, problems: string[]): void {
  if (metrics === false) return;
  if (isPlainObject(metrics) && typeof metrics.emit === 'function') return; // custom sink
  if (!isPlainObject(metrics)) {
    problems.push('metrics must be false, { prefix?, maxRoutes? }, or an object with emit(event)');
    return;
  }
  for (const k of Object.keys(metrics)) {
    if (k !== 'prefix' && k !== 'maxRoutes') problems.push(`metrics has unknown option "${k}"`);
  }
  const { prefix, maxRoutes } = metrics as MetricsOptions;
  if (prefix !== undefined && !(typeof prefix === 'string' && /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(prefix))) {
    problems.push('metrics.prefix must be a valid Prometheus metric name prefix');
  }
  checkPositiveInt('metrics.maxRoutes', maxRoutes, problems);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function checkPositiveInt(path: string, value: unknown, problems: string[]): void {
  if (value !== undefined && !(Number.isInteger(value) && (value as number) > 0)) {
    problems.push(`${path} must be a positive integer`);
  }
}

export function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isLogger(value: unknown): value is Logger {
  return (
    isPlainObject(value) &&
    typeof value.info === 'function' &&
    typeof value.warn === 'function' &&
    typeof value.error === 'function'
  );
}

function show(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}
