// ECS Adapter — Reads AWS ECS DescribeServices API
//
// For teams running on AWS ECS / Fargate without Prometheus.
// Reads runningCount, desiredCount, pendingCount from ECS service status.
// Credentials via standard AWS env vars or attached IAM role.
//
// Uses the AWS SDK v3 ECS client (@aws-sdk/client-ecs).
// If the SDK is not installed, the adapter will fail gracefully at construction.

import type {
  InfrastructureAdapter,
  InfrastructureSnapshot,
  BoolSignal,
  NumberSignal,
  Confidence,
} from '../adapter-interface';

// ─── ECS SDK types (subset — avoids hard dep on @aws-sdk at type level) ───────

interface ECSServiceDeployment {
  runningCount?: number;
  desiredCount?: number;
  pendingCount?: number;
}

interface ECSService {
  serviceName?: string;
  runningCount?: number;
  desiredCount?: number;
  pendingCount?: number;
  deployments?: ECSServiceDeployment[];
}

interface DescribeServicesOutput {
  services?: ECSService[];
}

// ─── Configuration ─────────────────────────────────────────────────────────────

export interface ECSAdapterConfig {
  region: string;
  cluster: string;
  serviceNames: string[];
  /** Request timeout in ms (default: 5000) */
  timeoutMs?: number;
  /** Historical task start time samples for ETA estimation (default: 10) */
  taskStartHistorySize?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
// AWS Fargate typical task start time estimate when no history available
const FARGATE_FALLBACK_ETA_SECONDS = 60;
const DEFAULT_TASK_START_HISTORY_SIZE = 10;

// ─── ECSAdapter ────────────────────────────────────────────────────────────────

export class ECSAdapter implements InfrastructureAdapter {
  private readonly config: ECSAdapterConfig;
  private readonly historySize: number;
  private readonly taskStartHistory: number[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ecsClient: any | null = null;
  private clientInitError: string | null = null;

  constructor(config: ECSAdapterConfig) {
    this.config = config;
    this.historySize = config.taskStartHistorySize ?? DEFAULT_TASK_START_HISTORY_SIZE;
    this.initClient();
  }

  // ─── InfrastructureAdapter implementation ────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    if (this.ecsClient === null) return false;
    try {
      await this.describeServices();
      return true;
    } catch {
      return false;
    }
  }

  async isScalingInProgress(): Promise<BoolSignal> {
    if (this.ecsClient === null) return { value: null, confidence: 'unknown' };
    try {
      const services = await this.describeServices();
      const scaling = services.some(s => (s.desiredCount ?? 0) > (s.runningCount ?? 0));
      return { value: scaling, confidence: 'high' };
    } catch {
      return { value: null, confidence: 'unknown' };
    }
  }

  async estimatedReadySeconds(): Promise<NumberSignal> {
    if (this.ecsClient === null) return { value: null, confidence: 'unknown' };
    try {
      const services = await this.describeServices();
      const totalPending = services.reduce((s, svc) => s + (svc.pendingCount ?? 0), 0);
      if (totalPending === 0) return { value: null, confidence: 'unknown' };

      const eta = this.averageTaskStartSeconds();
      const confidence: Confidence = this.taskStartHistory.length >= 3 ? 'medium' : 'low';
      return { value: eta, confidence };
    } catch {
      return { value: null, confidence: 'unknown' };
    }
  }

  async isAtCapacityLimit(): Promise<BoolSignal> {
    // ECS does not surface quota limits directly in DescribeServices.
    // We detect it by checking if desired > running AND pending === 0
    // (desired tasks not starting means something is blocking them).
    if (this.ecsClient === null) return { value: null, confidence: 'unknown' };
    try {
      const services = await this.describeServices();
      const stalled = services.some(
        s => (s.desiredCount ?? 0) > (s.runningCount ?? 0) && (s.pendingCount ?? 0) === 0,
      );
      // This is a heuristic — confidence is lower than K8s which has maxReplicas
      return { value: stalled, confidence: 'low' };
    } catch {
      return { value: null, confidence: 'unknown' };
    }
  }

  async getSnapshot(): Promise<InfrastructureSnapshot> {
    const now = Date.now();

    if (this.ecsClient === null) {
      return {
        scalingInProgress: { value: null, confidence: 'unknown' },
        estimatedReadySeconds: { value: null, confidence: 'unknown' },
        atCapacityLimit: { value: null, confidence: 'unknown' },
        capturedAt: now,
        summary: `ECS adapter unavailable: ${this.clientInitError ?? 'unknown error'}`,
      };
    }

    try {
      const services = await this.describeServices();

      const totalRunning = services.reduce((s, svc) => s + (svc.runningCount ?? 0), 0);
      const totalDesired = services.reduce((s, svc) => s + (svc.desiredCount ?? 0), 0);
      const totalPending = services.reduce((s, svc) => s + (svc.pendingCount ?? 0), 0);

      const scalingInProgress = totalDesired > totalRunning;
      const stalled = scalingInProgress && totalPending === 0;

      let etaValue: number | null = null;
      let etaConfidence: Confidence = 'unknown';

      if (scalingInProgress && totalPending > 0) {
        etaValue = this.averageTaskStartSeconds();
        etaConfidence = this.taskStartHistory.length >= 3 ? 'medium' : 'low';
      }

      return {
        scalingInProgress: { value: scalingInProgress, confidence: 'high' },
        estimatedReadySeconds: { value: etaValue, confidence: etaConfidence },
        atCapacityLimit: { value: stalled, confidence: 'low' },
        capturedAt: now,
        summary: `ECS: ${totalRunning}/${totalDesired} tasks running (${totalPending} pending)`,
      };
    } catch (err) {
      return {
        scalingInProgress: { value: null, confidence: 'unknown' },
        estimatedReadySeconds: { value: null, confidence: 'unknown' },
        atCapacityLimit: { value: null, confidence: 'unknown' },
        capturedAt: now,
        summary: `ECS adapter error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ─── ECS API call ─────────────────────────────────────────────────────────────

  private async describeServices(): Promise<ECSService[]> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const output: DescribeServicesOutput = await this.ecsClient.send(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      new this.ecsClient._DescribeServicesCommand({
        cluster: this.config.cluster,
        services: this.config.serviceNames,
      }),
    );
    return output.services ?? [];
  }

  // ─── ETA estimation ───────────────────────────────────────────────────────────

  /**
   * Record a completed task start duration (seconds) for future estimates.
   * Called externally when a task is observed to become RUNNING.
   */
  recordTaskStartDuration(durationSeconds: number): void {
    if (durationSeconds <= 0 || durationSeconds > 600) return;
    this.taskStartHistory.push(durationSeconds);
    if (this.taskStartHistory.length > this.historySize) {
      this.taskStartHistory.splice(0, this.taskStartHistory.length - this.historySize);
    }
  }

  private averageTaskStartSeconds(): number {
    if (this.taskStartHistory.length === 0) return FARGATE_FALLBACK_ETA_SECONDS;
    const sum = this.taskStartHistory.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.taskStartHistory.length);
  }

  // ─── Client initialisation ────────────────────────────────────────────────────

  private initClient(): void {
    try {
      // Dynamic require — @aws-sdk/client-ecs is an optional peer dependency.
      // If not installed, this adapter silently becomes unavailable.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sdk = require('@aws-sdk/client-ecs') as {
        ECSClient: new (opts: { region: string; requestTimeout?: number }) => unknown;
        DescribeServicesCommand: new (input: unknown) => unknown;
      };

      const client = new sdk.ECSClient({
        region: this.config.region,
        requestTimeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }) as Record<string, unknown>;

      // Attach DescribeServicesCommand constructor onto client for use in describeServices()
      client['_DescribeServicesCommand'] = sdk.DescribeServicesCommand;
      this.ecsClient = client;
    } catch (err) {
      this.clientInitError = err instanceof Error ? err.message : String(err);
      this.ecsClient = null;
    }
  }
}
