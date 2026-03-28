// Config Defaults — All default configuration values documented in one place

/** Default weight thresholds — match CP5 spec */
export const DEFAULT_WEIGHT_HIGH = 65;
export const DEFAULT_WEIGHT_LOW  = 40;

/** Default user tier bonuses */
export const DEFAULT_TIER_CONFIG: Readonly<Record<string, number>> = Object.freeze({
  standard:   0,
  premium:   40,
  enterprise: 50,
});

/** Default RPM activation thresholds */
export const DEFAULT_RPM_ACTIVATE_THRESHOLD  = 72;
export const DEFAULT_RPM_DEACTIVATE_THRESHOLD = 55;
export const DEFAULT_ACTIVATE_SUSTAINED_SECONDS   = 90;
export const DEFAULT_DEACTIVATE_SUSTAINED_SECONDS = 60;

/** Default dashboard port */
export const DEFAULT_DASHBOARD_PORT = 4242;

/** Default ring map behaviour for unmatched routes */
export const DEFAULT_UNMATCHED_HANDLING = 'default-block' as const;

/** RPM Engine defaults */
export const DEFAULT_RPM_INTERVAL_SECONDS = 5;
