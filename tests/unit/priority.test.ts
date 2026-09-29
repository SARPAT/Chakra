import { createRouteTable, route, getRouteTag, EMERGENCY_PRESETS } from '../../src/priority';
import type { RequestContext } from '../../src/types';

const ctx = (method: string, path: string, routePattern?: string): RequestContext => ({
  method,
  path,
  route: routePattern,
  headers: {},
});

describe('createRouteTable', () => {
  const table = createRouteTable({
    'POST /checkout': 'critical',
    '/health': 'high',
    'GET /products/:id': { priority: 'normal', fallback: { body: 'later' } },
    'GET /products/featured': 'high',
    '* /recommendations/*': 'sheddable',
    'GET /products/:id/reviews': 'sheddable',
  });

  it('matches static routes by method, with any-method keys as fallback', () => {
    expect(table.match(ctx('POST', '/checkout'))?.priority).toBe('critical');
    expect(table.match(ctx('GET', '/checkout'))).toBeUndefined();
    expect(table.match(ctx('DELETE', '/health'))?.key).toBe('* /health');
  });

  it('matches HEAD with the GET rule', () => {
    expect(table.match(ctx('HEAD', '/products/featured'))?.key).toBe('GET /products/featured');
    expect(table.match(ctx('HEAD', '/products/42'))?.key).toBe('GET /products/:id');
    expect(table.match(ctx('HEAD', '/checkout'))).toBeUndefined();
  });

  it('matches params and wildcards and labels by pattern, never the concrete path', () => {
    const rule = table.match(ctx('GET', '/products/42'));
    expect(rule?.key).toBe('GET /products/:id');
    expect(rule?.fallback).toEqual({ body: 'later' });
    expect(table.match(ctx('GET', '/products/42/reviews'))?.key).toBe('GET /products/:id/reviews');
    expect(table.match(ctx('PUT', '/recommendations/a/b'))?.key).toBe('* /recommendations/*');
    expect(table.match(ctx('GET', '/recommendations'))?.priority).toBe('sheddable');
  });

  it('prefers static over params and tolerates trailing slashes', () => {
    expect(table.match(ctx('GET', '/products/featured'))?.priority).toBe('high');
    expect(table.match(ctx('POST', '/checkout/'))?.priority).toBe('critical');
    expect(table.match(ctx('GET', '/products/42/'))?.key).toBe('GET /products/:id');
  });

  it('prefers the framework route pattern when given', () => {
    expect(table.match(ctx('GET', '/whatever', '/products/:id'))?.key).toBe('GET /products/:id');
  });

  it('returns the same frozen rule object on every match', () => {
    const a = table.match(ctx('GET', '/products/1'));
    expect(table.match(ctx('GET', '/products/2'))).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('prefers method-specific rules and replaces on add()', () => {
    const t = createRouteTable({ '* /a/:x': 'sheddable' });
    t.add('get', '/a/:x', { priority: 'critical' });
    expect(t.match(ctx('GET', '/a/1'))?.priority).toBe('critical');
    expect(t.match(ctx('POST', '/a/1'))?.priority).toBe('sheddable');
    t.add('GET', '/a/:x/', { priority: 'high' });
    expect(t.size).toBe(2);
    expect(t.match(ctx('GET', '/a/1'))?.priority).toBe('high');
  });

  it('rejects invalid configuration loudly', () => {
    expect(() => createRouteTable({ 'GET /x': 'urgent' as never })).toThrow(/unknown priority/);
    expect(() => createRouteTable({ 'GET x': 'normal' })).toThrow(/must start with/);
    expect(() => createRouteTable({ 'GET /x extra': 'normal' })).toThrow(/malformed/);
    expect(() => createRouteTable().add('G-T', '/x', { priority: 'normal' })).toThrow(
      /invalid method/,
    );
  });

  it('never throws from match()', () => {
    expect(table.match({ method: 'GET' } as RequestContext)).toBeUndefined();
  });
});

describe('route()', () => {
  it('is a tagged pass-through', () => {
    const next = vi.fn();
    const handler = route('critical', { fallback: { status: 429 } });
    handler({}, {}, next);
    expect(next).toHaveBeenCalledWith();
    expect(getRouteTag(handler)).toEqual({ priority: 'critical', fallback: { status: 429 } });
    expect(Object.keys(handler)).toEqual([]);
    expect(getRouteTag(() => {})).toBeUndefined();
  });

  it('rejects unknown priorities', () => {
    expect(() => route('urgent' as never)).toThrow(/unknown priority/);
  });
});

describe('EMERGENCY_PRESETS', () => {
  it('never closes the critical band', () => {
    expect(EMERGENCY_PRESETS['restore-all'].closedBands).toEqual([]);
    expect(EMERGENCY_PRESETS['critical-only'].closedBands).toEqual(['high', 'normal', 'sheddable']);
    for (const preset of Object.values(EMERGENCY_PRESETS))
      expect(preset.closedBands).not.toContain('critical');
  });
});
