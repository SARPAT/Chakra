// Logger — Structured logging for CHAKRA components
// All console output from CHAKRA flows through this module.

const TAG = '[CHAKRA]';
const DIVIDER = '──────────────────────────────────────────';

/** Minimal structured logger interface */
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** Create a logger — all output prefixed with [CHAKRA] */
export function createLogger(): Logger {
  return {
    info:  (msg) => console.log(`${TAG} ${msg}`),
    warn:  (msg) => console.warn(`${TAG} WARN  ${msg}`),
    error: (msg) => console.error(`${TAG} ERROR ${msg}`),
  };
}

/** Module-level singleton — used by all CHAKRA components */
export const logger: Logger = createLogger();

/** Print the startup banner to stdout */
export function printStartupBanner(lines: {
  configPath: string;
  endpointCount: number;
  blockCount: number;
  mode: 'manual' | 'auto';
  shadowModeAvailable: boolean;
  sessionCacheAvailable: boolean;
  dashboardAvailable: boolean;
  dashboardPort: number;
  disabled: boolean;
}): void {
  const version = '0.1.0';

  console.log(`${TAG} ${DIVIDER}`);
  console.log(`${TAG}  Initializing CHAKRA v${version}`);
  console.log(`${TAG} ${DIVIDER}`);

  if (lines.disabled) {
    console.log(`${TAG} ✗ CHAKRA is disabled — see errors above`);
    console.log(`${TAG} ${DIVIDER}`);
    return;
  }

  console.log(`${TAG} ✓ Config loaded           ${lines.configPath}`);
  console.log(
    `${TAG} ✓ Ring Map compiled       ${lines.endpointCount} endpoints → ${lines.blockCount} blocks`,
  );
  console.log(
    `${TAG} ${lines.shadowModeAvailable ? '✓' : '○'} Shadow Mode             ${lines.shadowModeAvailable ? 'collecting observations' : 'not yet available'}`,
  );
  console.log(`${TAG} ✓ RPM Engine started      cold start (no baseline yet)`);
  console.log(
    `${TAG} ${lines.sessionCacheAvailable ? '✓' : '○'} Session Cache           ${lines.sessionCacheAvailable ? 'ready' : 'not yet available'}`,
  );
  console.log(`${TAG} ✓ Dispatcher ready        status: SLEEPING`);
  console.log(
    `${TAG} ${lines.dashboardAvailable ? '✓' : '○'} Dashboard               ${lines.dashboardAvailable ? `http://localhost:${lines.dashboardPort}` : 'not yet available'}`,
  );
  console.log(`${TAG} ${DIVIDER}`);
  console.log(`${TAG}  Mode:    ${lines.mode.toUpperCase()}`);
  console.log(`${TAG}  Status:  SLEEPING — full pass-through active`);
  console.log(`${TAG} ${DIVIDER}`);

  if (lines.mode === 'manual') {
    console.log(`${TAG}  CHAKRA will not activate until you initiate manually.`);
  } else {
    console.log(`${TAG}  CHAKRA will auto-activate when RPM thresholds are met.`);
  }
  console.log(`${TAG} ${DIVIDER}`);
}
