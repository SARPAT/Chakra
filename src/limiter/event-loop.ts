import { monitorEventLoopDelay, performance } from 'perf_hooks';
import type { LagSource } from './types';

/**
 * Samples event-loop delay every `intervalMs` and calls `onSample(lagMs)`.
 *
 * Two signals, whichever is larger: the max of perf_hooks'
 * monitorEventLoopDelay histogram over the interval (minus its resolution,
 * which an idle loop reports as delay), and how late our own timer fired.
 * The histogram alone misses a block that spans its reset(); the timer alone
 * misses one that ends before the tick is due. A spike is reported at once
 * and decays by half per tick. The timer is unref'd and nothing here throws.
 */
export function monitorEventLoop(
  onSample: (lagMs: number) => void,
  intervalMs = 50,
  now: () => number = () => performance.now(),
): LagSource {
  const resolution = 10;
  let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
  try {
    histogram = monitorEventLoopDelay({ resolution });
    histogram.enable();
  } catch {
    histogram = undefined;
  }
  let lag = 0;
  let last = now();
  const timer = setInterval(() => {
    const t = now();
    const late = t - last - intervalMs;
    last = t;
    const delayed = histogram && histogram.count > 0 ? histogram.max / 1e6 - resolution : 0;
    histogram?.reset();
    const sample = Math.max(0, late, delayed);
    lag = sample >= lag ? sample : (lag + sample) / 2;
    try {
      onSample(lag);
    } catch {
      // A broken listener must not stop sampling.
    }
  }, intervalMs);
  timer.unref();
  return {
    lagMs: () => lag,
    close() {
      clearInterval(timer);
      histogram?.disable();
      lag = 0;
    },
  };
}
