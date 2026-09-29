// Console logger used when the developer does not pass their own.

import type { Logger } from '../types';

const TAG = '[CHAKRA]';

export const consoleLogger: Logger = Object.freeze({
  info: (msg: string) => console.log(`${TAG} ${msg}`),
  warn: (msg: string) => console.warn(`${TAG} ${msg}`),
  error: (msg: string) => console.error(`${TAG} ${msg}`),
});

/**
 * Wrap a logger so each distinct key is logged at most once.
 * Used on the hot path so a recurring failure cannot flood the host's logs.
 */
export function onceLogger(logger: Logger): Logger & { warnOnce(key: string, msg: string): void } {
  const seen = new Set<string>();
  return {
    info: (msg) => safe(() => logger.info(msg)),
    warn: (msg) => safe(() => logger.warn(msg)),
    error: (msg) => safe(() => logger.error(msg)),
    warnOnce(key, msg) {
      if (seen.has(key)) return;
      seen.add(key);
      safe(() => logger.warn(msg));
    },
  };
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* a broken logger must never break the request */
  }
}
