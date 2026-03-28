// CHAKRA Middleware — Entry point and public API
//
// Usage (Express):
//   const { chakra } = require('chakra-middleware');
//   const chakraInstance = chakra('./chakra.config.yaml');
//   app.use(chakraInstance.middleware());
//   app.post('/api/payment', chakraInstance.block('payment-block'), handler);

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { BlockState, DispatcherMetrics, RPMState } from './types';
import { RingMapper } from './core/ring-mapper';
import { Dispatcher } from './core/dispatcher';
import { WeightEngine } from './core/weight-engine';
import { PolicyEngine } from './core/policy-engine';
import { ActivationController } from './core/activation';
import RPMEngine from './background/rpm-engine';
import { loadConfig, type ChakraConfig } from './config/loader';
import { createExpressMiddleware, createRPMRecorder } from './integrations/express';
import { DashboardAPI } from './dashboard/api';
import { DashboardServer } from './dashboard/server';
import { logger, printStartupBanner } from './utils/logger';
import {
  DEFAULT_WEIGHT_HIGH,
  DEFAULT_WEIGHT_LOW,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_RPM_INTERVAL_SECONDS,
} from './config/defaults';

// ─── Public API types ─────────────────────────────────────────────────────────

/** Current status snapshot returned by chakraInstance.status() */
export interface ChakraStatus {
  active: boolean;
  mode: 'manual' | 'auto';
  currentLevel: number;
  rpm: number;
  rpmPhase: 1 | 2 | 3;
  disabled: boolean;
}

// ─── ChakraInstance ───────────────────────────────────────────────────────────

export class ChakraInstance {
  private readonly configPath: string;
  private config: ChakraConfig;

  // Core components
  private readonly ringMapper: RingMapper;
  private readonly weightEngine: WeightEngine;
  private readonly policyEngine: PolicyEngine;
  private readonly dispatcher: Dispatcher;
  private readonly rpmEngine: RPMEngine;
  private readonly activationController: ActivationController;
  private readonly dashboardAPI: DashboardAPI;
  private readonly dashboardServer: DashboardServer;

  // State
  private disabled = false;
  private registeredRoutes = new Set<string>();  // dedup for block() lazy registration

  // RPM → PolicyEngine sync interval
  private syncInterval: ReturnType<typeof setInterval> | null = null;

  constructor(configPath: string) {
    this.configPath = configPath;

    // ── Step 1: Load config ──────────────────────────────────────────────────
    let config: ChakraConfig = { mode: 'manual' };
    try {
      config = loadConfig(configPath);
    } catch (err) {
      logger.error(`Config error: ${err instanceof Error ? err.message : String(err)}`);
      logger.error('CHAKRA disabled. App running without CHAKRA protection.');
      this.disabled = true;
    }
    this.config = config;

    // ── Step 2: Build Ring Map ───────────────────────────────────────────────
    this.ringMapper = new RingMapper({
      unmatchedEndpointHandling: config.ring_mapper?.unmatched_endpoint_handling ?? 'default-block',
    });

    // Register always_protect and degrade_first paths from config
    this.applyProtectionConfig(config);

    // ── Step 3: Build core components ───────────────────────────────────────
    this.weightEngine = new WeightEngine({
      tierConfig: config.weight_engine?.user_tier?.tiers,
    });

    this.policyEngine = new PolicyEngine({ rules: [] });

    // Apply always_protect as PolicyEngine rules (serve_fully override for protected paths)
    this.applyAlwaysProtectRules(config);

    this.dispatcher = new Dispatcher({
      ringMapper: this.ringMapper,
      weightOverrideHigh: config.weight_engine?.serve_fully_threshold ?? DEFAULT_WEIGHT_HIGH,
      weightOverrideLow: config.weight_engine?.serve_limited_threshold ?? DEFAULT_WEIGHT_LOW,
      weightProvider: this.weightEngine,
      policyProvider: this.policyEngine,
      sessionProvider: undefined,  // Session Cache not yet built (CP1)
    });

    // ── Step 4: RPM Engine ───────────────────────────────────────────────────
    this.rpmEngine = new RPMEngine();

    // ── Step 5: Activation Controller ───────────────────────────────────────
    this.activationController = new ActivationController({
      dispatcher: this.dispatcher,
      rpmEngine: this.rpmEngine,
      chakraConfig: config,
    });

    // ── Step 6: Dashboard ────────────────────────────────────────────────────
    this.dashboardAPI = new DashboardAPI({
      getStatus: () => this.status(),
      getRPMState: () => this.rpmEngine.getState(),
      getBlockStates: () => this.getBlockStates(),
      getActivationLog: () => this.activationController.getLog(),
      getMetrics: () => this.dispatcher.getMetrics(),
      getConfig: () => this.config,
      initialPolicies: [],
      onPoliciesUpdated: (rules) => this.policyEngine.updateRules(rules),
      activate: (level, initiatedBy) => this.activationController.activate(level, initiatedBy),
      initiateSleep: (sequence, initiatedBy) =>
        this.activationController.initiateSleep(sequence, initiatedBy),
      updateConfig: (patch) => this.updateConfig(patch),
    });

    this.dashboardServer = new DashboardServer({
      api: this.dashboardAPI,
      port: config.dashboard?.port ?? DEFAULT_DASHBOARD_PORT,
    });

    if (!this.disabled) {
      this.rpmEngine.start();
      this.activationController.start();
      this.startRPMSyncInterval();
      this.dashboardServer.start();
    }

    // ── Step 7: Startup banner ───────────────────────────────────────────────
    printStartupBanner({
      configPath,
      endpointCount: countRegisteredEndpoints(this.ringMapper),
      blockCount: countRegisteredBlocks(this.ringMapper),
      mode: config.mode,
      shadowModeAvailable: false,    // CP1 — not yet built
      sessionCacheAvailable: false,  // CP1 — not yet built
      dashboardAvailable: !this.disabled,
      dashboardPort: config.dashboard?.port ?? DEFAULT_DASHBOARD_PORT,
      disabled: this.disabled,
    });
  }

  // ─── Framework integration ─────────────────────────────────────────────────

  /**
   * Returns the Express middleware function.
   * Mount before all routes: app.use(chakraInstance.middleware())
   */
  middleware(): RequestHandler {
    if (this.disabled) {
      // Pass-through — CHAKRA disabled due to config error
      return (_req: Request, _res: Response, next: NextFunction) => next();
    }

    const dispatchMw = createExpressMiddleware(this.dispatcher);
    const rpmRecorder = createRPMRecorder(
      this.rpmEngine,
      (method, path) => this.ringMapper.lookup(method, path).block,
    );

    // RPM recording wraps dispatch: recorder starts timing, then dispatcher decides
    return (req: Request, res: Response, next: NextFunction): void => {
      rpmRecorder(req, res, () => {
        dispatchMw(req, res, next);
      });
    };
  }

  /**
   * Returns a route-level middleware that registers this endpoint with the Ring Map.
   * Add per route: app.get('/api/products', chakraInstance.block('browse-block'), handler)
   *
   * Registration is lazy (happens on first request). The first request to an unregistered
   * route always passes through (default-block is never suspended).
   */
  block(blockName: string): RequestHandler {
    return (req: Request, _res: Response, next: NextFunction): void => {
      try {
        const method = req.method?.toUpperCase();
        const reqPath = req.path;
        if (method && reqPath) {
          const routeKey = `${method} ${reqPath}`;
          if (!this.registeredRoutes.has(routeKey)) {
            this.registeredRoutes.add(routeKey);
            this.ringMapper.registerRoute(method, reqPath, blockName);
            this.ringMapper.compile();
          }
        }
      } catch {
        /* registration failure must never surface to the app */
      }
      next();
    };
  }

  // ─── Activation controls ──────────────────────────────────────────────────

  /**
   * Activate CHAKRA at the given level (default: 1).
   * @param level  1–3 (clamped). Higher = more aggressive degradation.
   * @param initiatedBy  Optional identifier for audit log.
   */
  activate(level = 1, initiatedBy?: string): void {
    this.activationController.activate(level, initiatedBy);
    logger.info(`Activated at level ${Math.min(Math.max(Math.round(level), 1), 3)}.`);
  }

  /**
   * Initiate the sleep sequence (gradual restoration by default).
   * @param sequence  'gradual' steps down one level at a time; 'immediate' snaps back instantly.
   * @param initiatedBy  Optional identifier for audit log.
   */
  initiateSleep(sequence?: 'gradual' | 'immediate', initiatedBy?: string): void {
    this.activationController.initiateSleep(sequence, initiatedBy);
  }

  /** Immediate deactivation alias — equivalent to initiateSleep('immediate'). */
  deactivate(): void {
    this.activationController.initiateSleep('immediate');
    this.dashboardAPI.generateIncidentReport();
    logger.info('Deactivated. Full pass-through restored.');
  }

  // ─── Observability ─────────────────────────────────────────────────────────

  /** Current operational status snapshot. */
  status(): ChakraStatus {
    const activation = this.dispatcher.getActivationState();
    const rpmState = this.rpmEngine.getState();
    return {
      active: activation.active,
      mode: this.config.mode,
      currentLevel: activation.currentLevel,
      rpm: rpmState.global,
      rpmPhase: rpmState.phase,
      disabled: this.disabled,
    };
  }

  /** Current dispatcher metrics snapshot. */
  getMetrics(): DispatcherMetrics {
    return this.dispatcher.getMetrics();
  }

  /** Current RPM Engine state snapshot. */
  getRPM(): RPMState {
    return this.rpmEngine.getState();
  }

  /** Full activation audit log — most recent entry last. */
  getActivationLog(): ReturnType<ActivationController['getLog']> {
    return this.activationController.getLog();
  }

  /** State of all known blocks at the current activation level. */
  getBlockStates(): BlockState[] {
    const level = this.dispatcher.getActivationState().currentLevel;
    const levelMap = this.ringMapper.getLevelMap();
    if (level < 0 || level >= levelMap.length) return [];

    const allBlocks = [
      ...levelMap[level].activeBlocks,
      ...levelMap[level].suspendedBlocks,
    ];
    return allBlocks.map(b => ({ ...this.ringMapper.getBlockState(b, level) }));
  }

  // ─── Config management ─────────────────────────────────────────────────────

  /** Apply a partial config update without restart. Takes effect on next evaluation cycle. */
  updateConfig(patch: Partial<ChakraConfig>): void {
    this.config = { ...this.config, ...patch };
    this.activationController.updateConfig(this.config);
  }

  /** Reload config file from disk. Keeps existing config on failure (CHAKRA Rule #4). */
  reloadConfig(): void {
    try {
      this.config = loadConfig(this.configPath);
    } catch (err) {
      logger.warn(`Config reload failed, keeping existing config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /** Gracefully shut down all background services. */
  shutdown(): void {
    this.activationController.stop();
    if (this.syncInterval !== null) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this.rpmEngine.stop();
    this.dashboardServer.stop();
    this.dispatcher.setActivationState({ active: false, currentLevel: 0 });
    logger.info('Shut down.');
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Register degrade_first paths as low-priority blocks in the Ring Map.
   * always_protect is handled via PolicyEngine rules (see applyAlwaysProtectRules).
   */
  private applyProtectionConfig(config: ChakraConfig): void {
    if (!config.degrade_first || config.degrade_first.length === 0) return;

    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
    for (const pathPattern of config.degrade_first) {
      for (const method of methods) {
        try {
          this.ringMapper.registerRoute(method, pathPattern, 'degrade-first-block');
          // Also register prefix variant to cover sub-paths
          this.ringMapper.registerRoute(method, `${pathPattern}/*`, 'degrade-first-block');
        } catch { /* skip duplicate/invalid entries */ }
      }
    }

    // Register the block definition with minLevel=3 (first to be suspended)
    this.ringMapper.registerBlock('degrade-first-block', {
      endpoints: [],   // endpoints already registered via registerRoute above
      minLevel: 3,
      weightBase: 10,
    });

    this.ringMapper.compile();
  }

  /**
   * Apply always_protect paths as high-priority PolicyEngine rules.
   * Rule: if path starts with protected prefix → serve_fully, regardless of block state.
   */
  private applyAlwaysProtectRules(config: ChakraConfig): void {
    if (!config.always_protect || config.always_protect.length === 0) return;

    const rules = config.always_protect.map((pathPrefix, i) => ({
      name: `always-protect-${i}`,
      if: { path_matches: `${pathPrefix}**` },
      then: { action: 'serve_fully' as const },
      priority: 10_000 - i,  // highest priority — evaluated before all user rules
    }));

    this.policyEngine.updateRules(rules);
  }

  /** Push RPM state to Policy Engine and Dashboard every tick. */
  private startRPMSyncInterval(): void {
    const intervalMs = (this.config.rpm_engine?.update_interval_seconds ?? DEFAULT_RPM_INTERVAL_SECONDS) * 1000;

    this.syncInterval = setInterval(() => {
      try {
        const rpmState = this.rpmEngine.getState();
        this.policyEngine.setRPMState(rpmState);
        this.dashboardServer.broadcastRPMUpdate(rpmState);
      } catch {
        /* background timer must never propagate exceptions */
      }
    }, intervalMs);

    if (typeof this.syncInterval.unref === 'function') {
      this.syncInterval.unref();
    }
  }
}

// ─── Factory function ─────────────────────────────────────────────────────────

/**
 * Create a CHAKRA middleware instance.
 *
 * @param configPath Path to chakra.config.yaml
 * @returns ChakraInstance ready to mount as middleware
 *
 * @example
 * const chakraInstance = chakra('./chakra.config.yaml');
 * app.use(chakraInstance.middleware());
 */
export function chakra(configPath: string): ChakraInstance {
  return new ChakraInstance(configPath);
}

// ─── Re-exports ───────────────────────────────────────────────────────────────

export type {
  SessionContext, RouteInfo, SuspendedResponse, DispatchOutcome,
  RPMState, BlockState, RecordRequestParams, BaselineConfig,
  UnmatchedEndpointMode, SuspendedBlockResponseType, SuspendedBlockConfig,
  BlockDefinition, RingMapConfig, LevelState,
  ActivationState, DispatcherMetrics,
  RPMHistoryEntry, IncidentReport,
} from './types';
export {
  DashboardAPI,
  type DashboardAPIConfig,
  type PoliciesResponse,
  type PolicySuggestion,
  type RPMResponse,
  type BlocksResponse,
  type LearningResponse,
  type HistoryResponse,
} from './dashboard/api';
export { DashboardServer, type DashboardServerConfig } from './dashboard/server';

export { RingMapper } from './core/ring-mapper';
export { Dispatcher } from './core/dispatcher';
export { WeightEngine } from './core/weight-engine';
export {
  PolicyEngine,
  type PolicyRule,
  type PolicyConditions,
  type PolicyAction,
  type PolicyEngineConfig,
} from './core/policy-engine';
export {
  ActivationController,
  type ActivationLogEntry,
  type ActivationControllerConfig,
  type RestoreSequence,
  type LogEntryKind,
} from './core/activation';
export { default as RPMEngine } from './background/rpm-engine';
export type { ChakraConfig } from './config/loader';

// ─── Internal helpers (module-level) ─────────────────────────────────────────

function countRegisteredEndpoints(ringMapper: RingMapper): number {
  let count = 0;
  for (const level of ringMapper.getLevelMap()) {
    count = Math.max(count, level.activeBlocks.length + level.suspendedBlocks.length);
  }
  // Use the unmatched map size as a proxy for registered endpoint count
  // (actual count is internal to RingMapper — using block count as approximation)
  return count;
}

function countRegisteredBlocks(ringMapper: RingMapper): number {
  const levelMap = ringMapper.getLevelMap();
  if (levelMap.length === 0) return 0;
  return levelMap[0].activeBlocks.length + levelMap[0].suspendedBlocks.length;
}
