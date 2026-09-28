// Real admission core + route table, with a limiter whose per-band capacity the
// test controls, so overload is deterministic.

import { createAdmissionCore } from '../../src/core/admission';
import { resolveOptions, type ChakraOptions } from '../../src/config/schema';
import { createRouteTable } from '../../src/priority';
import type { Limiter, Priority, ReleaseOutcome } from '../../src/types';

export function harness(options: ChakraOptions = {}) {
  const capacity: Record<Priority, number> = {
    critical: 100,
    high: 100,
    normal: 100,
    sheddable: 100,
  };
  const inFlight: Record<Priority, number> = { critical: 0, high: 0, normal: 0, sheddable: 0 };
  const releases: ReleaseOutcome[] = [];
  let degraded = false;
  const limiter: Limiter = {
    acquire(p, force = false) {
      const admitted = inFlight[p] < capacity[p];
      if (!admitted && !force) return { admitted, degraded: false, token: null };
      inFlight[p]++;
      let released = false;
      const release = (o: ReleaseOutcome) => {
        if (released) return;
        released = true;
        inFlight[p]--;
        releases.push(o);
      };
      return { admitted, degraded, token: { release } };
    },
    snapshot: () => ({
      limit: 100,
      inFlight: 0,
      pressure: 0.5,
      eventLoopDelayMs: 0,
      bandLimits: capacity,
    }),
    start() {},
    stop() {},
  };
  const resolved = resolveOptions({ logger: false, metrics: false, ...options }, {});
  const table = createRouteTable(resolved.routes);
  const core = createAdmissionCore({
    options: resolved,
    limiter,
    resolver: table,
    sink: { emit() {} },
  });
  return {
    core,
    table,
    capacity,
    inFlight,
    releases,
    setDegraded: (d: boolean) => (degraded = d),
  };
}
