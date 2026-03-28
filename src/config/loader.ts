// Config Loader — YAML config reader + validator
// Reads chakra.config.yaml, validates required fields, returns typed config.
// Throws on invalid config so ChakraInstance can disable itself cleanly.

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import type { UnmatchedEndpointMode } from '../types';

// ─── Config type ──────────────────────────────────────────────────────────────

export interface ChakraConfig {
  /** Required: 'manual' or 'auto' */
  mode: 'manual' | 'auto';

  shadow_mode?: {
    mode?: 'auto' | 'manual';
    min_learning_days?: number;
    force_activate_after_days?: number;
    historical_log_import?: {
      enabled?: boolean;
      format?: 'nginx' | 'apache' | 'cloudwatch' | 'json';
      path?: string;
    };
  };

  activate_when?: {
    rpm_threshold?: number;
    sustained_seconds?: number;
    error_rate_above?: number;
    latency_p95_above_ms?: number;
    condition_logic?: string;
  };

  deactivate_when?: {
    rpm_below?: number;
    sustained_seconds?: number;
    restore_sequence?: 'gradual' | 'immediate';
    restore_step_wait_seconds?: number;
  };

  abort_sleep_if?: {
    rpm_climbs_above?: number;
    action?: string;
  };

  weight_engine?: {
    serve_fully_threshold?: number;
    serve_limited_threshold?: number;
    user_tier?: {
      header?: string;
      tiers?: Record<string, number>;
    };
  };

  always_protect?: string[];
  degrade_first?: string[];

  user_overrides?: Record<string, {
    header?: string;
    value?: string;
    treatment?: string;
    detection?: string;
  }>;

  ring_mapper?: {
    source?: 'annotations' | 'file' | 'shadow-mode';
    ring_map_file?: string;
    unmatched_endpoint_handling?: UnmatchedEndpointMode;
  };

  dashboard?: {
    port?: number;
    enabled?: boolean;
    auth?: {
      type?: string;
      username?: string;
      password_env?: string;
    };
  };

  rpm_engine?: {
    update_interval_seconds?: number;
    smoothing_window?: number;
    signal_weights?: {
      request_arrival_rate?: number;
      response_latency_p95?: number;
      error_rate_delta?: number;
    };
  };
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Load and validate chakra.config.yaml.
 * Throws with a clear, specific message on any config error.
 * ChakraInstance catches and disables itself — never crashes the app.
 */
export function loadConfig(configPath: string): ChakraConfig {
  // Read file
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    throw new Error(`Config file not found: ${configPath}`);
  }

  // Parse YAML
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(
      `Invalid YAML in ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config must be a YAML object, got: ${typeof parsed}`);
  }

  const config = parsed as Record<string, unknown>;

  // Validate required fields
  if (!('mode' in config)) {
    throw new Error('Config is missing required field: mode. Add `mode: "manual"` to get started.');
  }

  const mode = config['mode'];
  if (mode !== 'manual' && mode !== 'auto') {
    throw new Error(
      `mode must be "manual" or "auto", got: ${JSON.stringify(mode)}`,
    );
  }

  // Validate numeric bounds (warn instead of throw — lenient for optional fields)
  const activateWhen = config['activate_when'] as Record<string, unknown> | undefined;
  if (activateWhen?.rpm_threshold !== undefined) {
    const v = activateWhen.rpm_threshold as number;
    if (typeof v !== 'number' || v < 0 || v > 100) {
      throw new Error(
        `activate_when.rpm_threshold must be between 0 and 100. Found: ${v}`,
      );
    }
  }

  const weightEngine = config['weight_engine'] as Record<string, unknown> | undefined;
  if (weightEngine?.serve_fully_threshold !== undefined) {
    const v = weightEngine.serve_fully_threshold as number;
    if (typeof v !== 'number' || v < 0 || v > 100) {
      throw new Error(
        `weight_engine.serve_fully_threshold must be between 0 and 100. Found: ${v}`,
      );
    }
  }
  if (weightEngine?.serve_limited_threshold !== undefined) {
    const v = weightEngine.serve_limited_threshold as number;
    if (typeof v !== 'number' || v < 0 || v > 100) {
      throw new Error(
        `weight_engine.serve_limited_threshold must be between 0 and 100. Found: ${v}`,
      );
    }
  }

  return config as unknown as ChakraConfig;
}
