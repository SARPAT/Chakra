// Tests for the Prometheus exporter: event mapping, exposition format, route cap.

import { describe, it, expect } from 'vitest';
import { createPrometheusExporter } from '../../../src/observability/prometheus';
import type { AdmissionEvent } from '../../../src/types';

function admission(overrides: Partial<AdmissionEvent> = {}): AdmissionEvent {
  return {
    type: 'admission',
    decision: 'shed',
    band: 'sheddable',
    route: 'GET /feed',
    dryRun: false,
    ...overrides,
  };
}

describe('createPrometheusExporter', () => {
  it('counts admissions by decision, band, route and dry_run', () => {
    const exporter = createPrometheusExporter();
    exporter.emit(admission());
    exporter.emit(admission());
    exporter.emit(admission({ decision: 'admitted', band: 'critical', route: 'POST /checkout' }));
    exporter.emit(admission({ dryRun: true, decision: 'degraded', band: 'normal' }));

    const text = exporter.render();
    expect(text).toContain('# TYPE chakra_requests_total counter');
    expect(text).toContain(
      'chakra_requests_total{decision="shed",band="sheddable",route="GET /feed",dry_run="false"} 2',
    );
    expect(text).toContain(
      'chakra_requests_total{decision="admitted",band="critical",route="POST /checkout",dry_run="false"} 1',
    );
    expect(text).toContain(
      'chakra_requests_total{decision="degraded",band="normal",route="GET /feed",dry_run="true"} 1',
    );
    expect(text.match(/^chakra_requests_total\{/gm)).toHaveLength(3);
  });

  it('reports the latest limiter state and event-loop lag as gauges', () => {
    const exporter = createPrometheusExporter();
    exporter.emit({ type: 'limiter_state', limit: 40, inFlight: 12 });
    exporter.emit({ type: 'event_loop_lag', lagMs: 25 });
    exporter.emit(admission({ limit: 38, inFlight: 39 }));

    const text = exporter.render();
    expect(text).toContain('# TYPE chakra_concurrency_limit gauge\nchakra_concurrency_limit 38');
    expect(text).toContain('chakra_inflight_requests 39');
    expect(text).toContain('chakra_event_loop_lag_seconds 0.025');
  });

  it('renders shed latency as a cumulative histogram per band', () => {
    const exporter = createPrometheusExporter();
    exporter.emit({
      type: 'shed_complete',
      band: 'sheddable',
      route: 'GET /feed',
      durationMs: 0.08,
    });
    exporter.emit({ type: 'shed_complete', band: 'sheddable', route: 'GET /feed', durationMs: 3 });
    exporter.emit({
      type: 'shed_complete',
      band: 'sheddable',
      route: 'GET /feed',
      durationMs: 500,
    });

    const text = exporter.render();
    expect(text).toContain('chakra_shed_latency_seconds_bucket{band="sheddable",le="0.00005"} 0');
    expect(text).toContain('chakra_shed_latency_seconds_bucket{band="sheddable",le="0.0001"} 1');
    expect(text).toContain('chakra_shed_latency_seconds_bucket{band="sheddable",le="0.005"} 2');
    expect(text).toContain('chakra_shed_latency_seconds_bucket{band="sheddable",le="0.1"} 2');
    expect(text).toContain('chakra_shed_latency_seconds_bucket{band="sheddable",le="+Inf"} 3');
    expect(text).toContain('chakra_shed_latency_seconds_count{band="sheddable"} 3');
    expect(text).toMatch(/chakra_shed_latency_seconds_sum\{band="sheddable"\} 0\.503/);
    expect(text).not.toContain('band="critical",le=');
  });

  it('caps distinct routes and counts the rest as __other__', () => {
    const exporter = createPrometheusExporter({ maxRoutes: 2 });
    for (const route of ['GET /a', 'GET /b', 'GET /c', 'GET /d', 'GET /a'])
      exporter.emit(admission({ route }));

    const text = exporter.render();
    expect(text).toContain('route="GET /a",dry_run="false"} 2');
    expect(text).toContain('route="GET /b",dry_run="false"} 1');
    expect(text).toContain('route="__other__",dry_run="false"} 2');
    expect(text).not.toContain('GET /c');
  });

  it('escapes label values', () => {
    const exporter = createPrometheusExporter();
    exporter.emit(admission({ route: 'GET /a"b\\c\nd' }));
    expect(exporter.render()).toContain('route="GET /a\\"b\\\\c\\nd"');
  });

  it('applies a custom prefix to every metric', () => {
    const exporter = createPrometheusExporter({ prefix: 'shop_' });
    exporter.emit(admission());
    const names = exporter
      .render()
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(/[{ ]/)[0]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n.startsWith('shop_')).toBe(true);
  });

  it('formats non-finite gauge values per the exposition format', () => {
    const exporter = createPrometheusExporter();
    exporter.emit({ type: 'limiter_state', limit: Infinity, inFlight: NaN });
    const text = exporter.render();
    expect(text).toContain('chakra_concurrency_limit +Inf');
    expect(text).toContain('chakra_inflight_requests NaN');
  });

  it('never throws on malformed events', () => {
    const exporter = createPrometheusExporter();
    const bad = [
      null,
      undefined,
      {},
      { type: 'admission', band: 'bogus', decision: 'shed' },
      { type: 'shed_complete' },
    ];
    for (const event of bad) expect(() => exporter.emit(event as never)).not.toThrow();
    expect(() => exporter.render()).not.toThrow();
  });

  it('exposes the Prometheus text content type', () => {
    expect(createPrometheusExporter().contentType).toBe('text/plain; version=0.0.4; charset=utf-8');
  });
});
