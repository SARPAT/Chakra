import type {
  RouteInfo, BlockState, BlockDefinition, RingMapConfig,
  LevelState, SuspendedBlockConfig, UnmatchedEndpointMode,
} from '../types';

// --- Internal types ---

interface PrefixRule {
  readonly prefix: string;
  readonly info: Readonly<RouteInfo>;
}

interface ParamRule {
  readonly pattern: RegExp;
  readonly info: Readonly<RouteInfo>;
}

interface CompiledRingMap {
  readonly version: number;
  readonly exactRoutes: ReadonlyMap<string, Readonly<RouteInfo>>;
  readonly prefixRoutes: readonly PrefixRule[];
  readonly paramRoutes: readonly ParamRule[];
  readonly catchAll: Readonly<RouteInfo>;
  readonly levelMap: readonly Readonly<LevelState>[];
  readonly suspendedConfigs: ReadonlyMap<string, Readonly<SuspendedBlockConfig>>;
  /** Pre-computed block states per level — blockName → BlockState[level]. Zero allocation on read. */
  readonly blockStates: ReadonlyMap<string, readonly Readonly<BlockState>[]>;
  readonly compiledAt: number;
}

// --- Constants ---

const MAX_LEVEL = 3;
const DEFAULT_MAX_VERSION_HISTORY = 10;
const DEFAULT_CATCH_ALL_WEIGHT = 50;
const MAX_UNMATCHED_ENTRIES = 10_000;

// --- Helpers ---

/** Normalize METHOD:PATH key — uppercase method, strip trailing slash */
function normalizeKey(method: string, path: string): string {
  const m = method.toUpperCase();
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return `${m}:${p}`;
}

/** Parse endpoint string like "GET /api/products" into [method, path] */
function parseEndpoint(endpoint: string): [string, string] {
  const parts = endpoint.trim().split(/\s+/);
  if (parts.length < 2) {
    throw new Error(`Invalid endpoint format: "${endpoint}". Expected "METHOD /path".`);
  }
  return [parts[0].toUpperCase(), parts[1]];
}

/**
 * Classify an endpoint into exact, prefix (wildcard), or parameterized.
 * Returns the type and the compiled lookup data.
 */
function classifyEndpoint(method: string, path: string, info: Readonly<RouteInfo>): {
  type: 'exact' | 'prefix' | 'param';
  key?: string;
  prefix?: string;
  pattern?: RegExp;
  info: Readonly<RouteInfo>;
} {
  if (path.endsWith('/*')) {
    // Wildcard: "POST /api/payment/*" → prefix match on "POST:/api/payment/"
    const base = path.slice(0, -1); // remove the '*', keep the trailing '/'
    return { type: 'prefix', prefix: normalizeKey(method, base), info };
  }

  if (path.includes(':')) {
    // Parameterized: "/api/products/:id" → regex "GET:/api/products/[^/]+"
    const regexPath = path.replace(/:[\w]+/g, '[^/]+');
    const pattern = new RegExp(`^${normalizeKey(method, regexPath)}$`);
    return { type: 'param', pattern, info };
  }

  // Exact match
  return { type: 'exact', key: normalizeKey(method, path), info };
}

/**
 * Determine if a block is suspended at a given system level.
 * Formula: suspended when currentLevel + minLevel > MAX_LEVEL (3)
 *
 * Higher minLevel = lower priority = suspended sooner:
 *   minLevel=0 (payment):         never suspended (0+L never > 3 for L≤3)
 *   minLevel=1 (cart):            suspended at level 3
 *   minLevel=2 (browse):          suspended at levels 2, 3
 *   minLevel=3 (recommendations): suspended at levels 1, 2, 3
 */
function isBlockSuspended(minLevel: number, currentLevel: number): boolean {
  return currentLevel + minLevel > MAX_LEVEL;
}

// --- RingMapper class ---

export class RingMapper {
  private blockRegistry = new Map<string, BlockDefinition>();
  private currentMap: Readonly<CompiledRingMap>;
  private currentRegistrySnapshot = new Map<string, BlockDefinition>();
  private versionHistory: { map: CompiledRingMap; registry: Map<string, BlockDefinition> }[] = [];
  private unmatchedHits = new Map<string, number>();
  private readonly unmatchedMode: UnmatchedEndpointMode;
  private readonly maxVersionHistory: number;
  private nextVersion = 1;

  constructor(config?: RingMapConfig) {
    this.unmatchedMode = config?.unmatchedEndpointHandling ?? 'default-block';
    this.maxVersionHistory = config?.maxVersionHistory ?? DEFAULT_MAX_VERSION_HISTORY;

    // Register blocks from config if provided
    if (config?.blocks) {
      for (const [name, def] of Object.entries(config.blocks)) {
        this.blockRegistry.set(name, def);
      }
    }

    // Build initial compiled map — never throw from constructor (CHAKRA Rule #1)
    try {
      this.currentMap = Object.freeze(this.compileMap());
    } catch {
      // Fall back to empty catch-all-only map so the app keeps running
      this.blockRegistry.clear();
      this.currentMap = Object.freeze(this.compileMap());
    }
    this.currentRegistrySnapshot = new Map(this.blockRegistry);
  }

  // --- Hot path ---

  /** Lookup route info for a request. Called by Dispatcher on every request. Never throws. */
  lookup(method: string, path: string): Readonly<RouteInfo> {
    try {
      const key = normalizeKey(method, path);
      const map = this.currentMap;

      // 1. Exact match (fastest — Map.get is O(1))
      const exact = map.exactRoutes.get(key);
      if (exact) return exact;

      // 2. Prefix match (sorted longest-first)
      for (const rule of map.prefixRoutes) {
        if (key.startsWith(rule.prefix)) return rule.info;
      }

      // 3. Parameterized match (regex)
      for (const rule of map.paramRoutes) {
        if (rule.pattern.test(key)) return rule.info;
      }

      // 4. Catch-all — track unmatched endpoint
      this.trackUnmatched(key);
      return map.catchAll;
    } catch {
      // Never throw from hot path
      return this.currentMap.catchAll;
    }
  }

  // --- Block registration ---

  /** Register a block definition. Call compile() after all blocks are registered. */
  registerBlock(blockName: string, definition: BlockDefinition): void {
    this.blockRegistry.set(blockName, definition);
  }

  /** Register a single route to a block. Creates the block if it doesn't exist. */
  registerRoute(method: string, path: string, blockName: string): void {
    const existing = this.blockRegistry.get(blockName);
    if (existing) {
      existing.endpoints.push(`${method.toUpperCase()} ${path}`);
    } else {
      this.blockRegistry.set(blockName, {
        endpoints: [`${method.toUpperCase()} ${path}`],
        minLevel: 0,
        weightBase: DEFAULT_CATCH_ALL_WEIGHT,
      });
    }
  }

  // --- Level queries ---

  /** Get the state of a specific block at a given system level. Reads from pre-computed snapshot. */
  getBlockState(blockName: string, currentLevel: number): Readonly<BlockState> {
    if (currentLevel >= 0 && currentLevel <= MAX_LEVEL) {
      const states = this.currentMap.blockStates.get(blockName);
      if (states) return states[currentLevel];
    }
    // Unknown block or out-of-range level — always active (minLevel=0 default)
    return Object.freeze({
      block: blockName,
      currentLevel,
      isActive: true,
      isSuspended: false,
    });
  }

  /** Get all active block names at a given level. */
  getActiveBlocks(currentLevel: number): string[] {
    if (currentLevel >= 0 && currentLevel <= MAX_LEVEL) {
      return [...this.currentMap.levelMap[currentLevel].activeBlocks];
    }
    return [];
  }

  /** Get all suspended block names at a given level. */
  getSuspendedBlocks(currentLevel: number): string[] {
    if (currentLevel >= 0 && currentLevel <= MAX_LEVEL) {
      return [...this.currentMap.levelMap[currentLevel].suspendedBlocks];
    }
    return [];
  }

  /** Get the full level map. */
  getLevelMap(): readonly Readonly<LevelState>[] {
    return this.currentMap.levelMap;
  }

  /** Get suspension config for a block. Reads from compiled snapshot for concurrency safety. */
  getSuspendedBlockConfig(blockName: string): Readonly<SuspendedBlockConfig> | undefined {
    return this.currentMap.suspendedConfigs.get(blockName);
  }

  // --- Compilation & versioning ---

  /** Compile the current block registry into a new lookup table. Validates and swaps atomically. */
  compile(): void {
    const newMap = this.compileMap();

    // Store the registry snapshot that corresponds to the CURRENT active map
    this.versionHistory.push({
      map: this.currentMap,
      registry: this.currentRegistrySnapshot,
    });
    if (this.versionHistory.length > this.maxVersionHistory) {
      this.versionHistory.shift();
    }

    this.currentMap = Object.freeze(newMap);
    this.currentRegistrySnapshot = new Map(this.blockRegistry);
  }

  /** Get the current ring map version number. */
  getVersion(): number {
    return this.currentMap.version;
  }

  /** Rollback to a previous version. Restores both the compiled map and block registry. */
  rollback(version: number): boolean {
    const idx = this.versionHistory.findIndex(entry => entry.map.version === version);
    if (idx === -1) return false;

    const target = this.versionHistory[idx];
    // Push current state to history before rollback
    this.versionHistory.push({
      map: this.currentMap,
      registry: this.currentRegistrySnapshot,
    });
    // Remove the target from history (it's now active)
    this.versionHistory.splice(idx, 1);
    if (this.versionHistory.length > this.maxVersionHistory) {
      this.versionHistory.shift();
    }

    // Restore the compiled map, block registry, and registry snapshot
    this.currentMap = Object.freeze(target.map);
    this.blockRegistry = new Map(target.registry);
    this.currentRegistrySnapshot = new Map(target.registry);
    return true;
  }

  // --- Unmatched endpoint tracking ---

  /** Get hit counts for unmatched endpoints. Returns a copy. */
  getUnmatchedEndpoints(): Map<string, number> {
    return new Map(this.unmatchedHits);
  }

  /** Reset unmatched endpoint counts. */
  resetUnmatchedEndpoints(): void {
    this.unmatchedHits.clear();
  }

  // --- Shadow Mode bridge (stub) ---

  /** Apply a Shadow Mode suggestion as the ring map. Compiles and activates immediately. */
  applySuggestion(suggestion: RingMapConfig): void {
    for (const [name, def] of Object.entries(suggestion.blocks)) {
      this.blockRegistry.set(name, def);
    }
    this.compile();
  }

  // --- Private methods ---

  private trackUnmatched(key: string): void {
    // Only track for default-block and alert-only modes
    if (this.unmatchedMode === 'outermost-level') return;
    // Cap size to prevent unbounded growth under adversarial URL enumeration
    if (!this.unmatchedHits.has(key) && this.unmatchedHits.size >= MAX_UNMATCHED_ENTRIES) return;
    this.unmatchedHits.set(key, (this.unmatchedHits.get(key) ?? 0) + 1);
  }

  private compileMap(): CompiledRingMap {
    const exactRoutes = new Map<string, Readonly<RouteInfo>>();
    const prefixRoutes: PrefixRule[] = [];
    const paramRoutes: ParamRule[] = [];
    const seenEndpoints = new Map<string, string>(); // endpoint key → block name (for duplicate detection)

    for (const [blockName, def] of this.blockRegistry) {
      // Validation
      if (def.minLevel < 0 || def.minLevel > MAX_LEVEL) {
        throw new Error(`Block "${blockName}": minLevel ${def.minLevel} out of range 0-${MAX_LEVEL}.`);
      }
      if (def.weightBase < 0 || def.weightBase > 100) {
        throw new Error(`Block "${blockName}": weightBase ${def.weightBase} out of range 0-100.`);
      }

      const info: Readonly<RouteInfo> = Object.freeze({
        block: blockName,
        minLevel: def.minLevel,
        weightBase: def.weightBase,
      });

      for (const endpoint of def.endpoints) {
        const [method, path] = parseEndpoint(endpoint);
        const classified = classifyEndpoint(method, path, info);

        // Duplicate detection (exact routes only)
        if (classified.type === 'exact' && classified.key) {
          const existing = seenEndpoints.get(classified.key);
          if (existing) {
            throw new Error(
              `Duplicate endpoint "${classified.key}" in blocks "${existing}" and "${blockName}".`
            );
          }
          seenEndpoints.set(classified.key, blockName);
          exactRoutes.set(classified.key, classified.info);
        } else if (classified.type === 'prefix' && classified.prefix) {
          prefixRoutes.push({ prefix: classified.prefix, info: classified.info });
        } else if (classified.type === 'param' && classified.pattern) {
          paramRoutes.push({ pattern: classified.pattern, info: classified.info });
        }
      }
    }

    // Sort prefix routes longest-first for correct matching
    prefixRoutes.sort((a, b) => b.prefix.length - a.prefix.length);

    // Build catch-all based on unmatched handling mode
    const catchAll: Readonly<RouteInfo> = Object.freeze(
      this.unmatchedMode === 'outermost-level'
        ? { block: 'default-block', minLevel: MAX_LEVEL, weightBase: 10 }
        : { block: 'default-block', minLevel: 0, weightBase: DEFAULT_CATCH_ALL_WEIGHT }
    );

    // Build level map
    const levelMap: LevelState[] = [];
    for (let level = 0; level <= MAX_LEVEL; level++) {
      const activeBlocks: string[] = [];
      const suspendedBlocks: string[] = [];

      for (const [blockName, def] of this.blockRegistry) {
        if (isBlockSuspended(def.minLevel, level)) {
          suspendedBlocks.push(blockName);
        } else {
          activeBlocks.push(blockName);
        }
      }

      levelMap.push(Object.freeze({
        level,
        activeBlocks: Object.freeze(activeBlocks),
        suspendedBlocks: Object.freeze(suspendedBlocks),
      }));
    }

    // Bake suspended configs into compiled map for immutable snapshot reads
    const suspendedConfigs = new Map<string, Readonly<SuspendedBlockConfig>>();
    for (const [blockName, def] of this.blockRegistry) {
      if (def.whenSuspended) {
        suspendedConfigs.set(blockName, Object.freeze({ ...def.whenSuspended }));
      }
    }

    // Pre-compute block states per level — zero allocation on getBlockState() reads
    const blockStates = new Map<string, readonly Readonly<BlockState>[]>();
    for (const [blockName, def] of this.blockRegistry) {
      const states: Readonly<BlockState>[] = [];
      for (let level = 0; level <= MAX_LEVEL; level++) {
        const suspended = isBlockSuspended(def.minLevel, level);
        states.push(Object.freeze({
          block: blockName,
          currentLevel: level,
          isActive: !suspended,
          isSuspended: suspended,
        }));
      }
      blockStates.set(blockName, Object.freeze(states));
    }

    const version = this.nextVersion++;

    return {
      version,
      exactRoutes,
      prefixRoutes: Object.freeze(prefixRoutes),
      paramRoutes: Object.freeze(paramRoutes),
      catchAll,
      levelMap: Object.freeze(levelMap),
      suspendedConfigs,
      blockStates,
      compiledAt: Date.now(),
    };
  }
}

export default RingMapper;
