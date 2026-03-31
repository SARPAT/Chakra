// Prometheus Adapter — Reads any Prometheus /api/v1/query endpoint
//
// Near-universal coverage: K8s, ECS, GKE, bare metal, custom setups.
// If the infrastructure team has Prometheus, this adapter works.
// Metric names are configurable for non-standard setups.

import * as http from 'http';
import * as https from 'https';
import type {
  InfrastructureAdapter,
  InfrastructureSnapshot,
  BoolSignal,
  NumberSignal,
  Confidence,
} from '../adapter-interface';

// ─── Prometheus API response shapes ───────────────────────────────────────────

interface PrometheusResult {
  metric: Record<string, string>;
  value: [number, string];   // [timestamp, stringValue]
}

interface PrometheusQueryResponse {
  status: 'success' | 'error';
  data: {
    resultType: 'vector';
    result: PrometheusResult[];
  };
  errorType?: string;
  error?: string;
}

// ─── Configuration ─────────────────────────────────────────────────────────────

export interface PrometheusMetricNames {
  /** Replicas currently in Ready state */
  readyReplicas?: string;
  /** Replicas that are not yet Ready */
  unavailableReplicas?: string;
  /** HPA desired replica count */
  desiredReplicas?: string;
  /** HPA current replica count */
  currentReplicas?: string;
  /** HPA max replicas ceiling */
  maxReplicas?: string;
}

const DEFAULT_METRICS: Required<PrometheusMetricNames> = {
  readyReplicas:        'kube_deployment_status_replicas_ready',
  unavailableReplicas:  'kube_deployment_status_replicas_unavailable',
  desiredReplicas:      'kube_horizontalpodautoscaler_status_desired_replicas',
  currentReplicas:      'kube_horizontalpodautoscaler_status_current_replicas',
  maxReplicas:          'kube_horizontalpodautoscaler_spec_max_replicas',
};

export interface PrometheusAdapterConfig {
  /** Prometheus base URL, e.g. http://prometheus.monitoring.svc:9090 */
  endpoint: string;
  /** Optional env var name holding a bearer token for auth */
  bearerTokenEnv?: string;
  /** Override any default metric names */
  metrics?: PrometheusMetricNames;
  /** Request timeout in ms (default: 5000) */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
// Fallback ETA estimate when unavailable replicas exist but we have no history
const FALLBACK_ETA_SECONDS = 45;

// ─── PrometheusAdapter ─────────────────────────────────────────────────────────

export class PrometheusAdapter implements InfrastructureAdapter {
  private readonly config: PrometheusAdapterConfig;
  private readonly metrics: Required<PrometheusMetricNames>;
  private readonly timeoutMs: number;

  constructor(config: PrometheusAdapterConfig) {
    this.config = config;
    this.metrics = { ...DEFAULT_METRICS, ...config.metrics };
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ─── InfrastructureAdapter implementation ────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    try {
      await this.query(this.metrics.currentReplicas);
      return true;
    } catch {
      return false;
    }
  }

  async isScalingInProgress(): Promise<BoolSignal> {
    try {
      const [desired, current] = await Promise.all([
        this.querySum(this.metrics.desiredReplicas),
        this.querySum(this.metrics.currentReplicas),
      ]);
      if (desired === null || current === null) return { value: null, confidence: 'unknown' };
      return { value: desired > current, confidence: 'high' };
    } catch {
      return { value: null, confidence: 'unknown' };
    }
  }

  async estimatedReadySeconds(): Promise<NumberSignal> {
    try {
      const unavailable = await this.querySum(this.metrics.unavailableReplicas);
      if (unavailable === null) return { value: null, confidence: 'unknown' };
      if (unavailable === 0) return { value: null, confidence: 'unknown' };
      // We can't derive ETA from a single Prometheus snapshot without history.
      // Return a conservative estimate at low confidence.
      return { value: FALLBACK_ETA_SECONDS, confidence: 'low' };
    } catch {
      return { value: null, confidence: 'unknown' };
    }
  }

  async isAtCapacityLimit(): Promise<BoolSignal> {
    try {
      const [current, max] = await Promise.all([
        this.querySum(this.metrics.currentReplicas),
        this.querySum(this.metrics.maxReplicas),
      ]);
      if (current === null || max === null) return { value: null, confidence: 'unknown' };
      return { value: current >= max, confidence: 'high' };
    } catch {
      return { value: null, confidence: 'unknown' };
    }
  }

  async getSnapshot(): Promise<InfrastructureSnapshot> {
    const now = Date.now();
    try {
      const [desired, current, max, unavailable] = await Promise.all([
        this.querySum(this.metrics.desiredReplicas),
        this.querySum(this.metrics.currentReplicas),
        this.querySum(this.metrics.maxReplicas),
        this.querySum(this.metrics.unavailableReplicas),
      ]);

      const scalingInProgress = desired !== null && current !== null
        ? desired > current
        : null;

      const atCapacityLimit = current !== null && max !== null
        ? current >= max
        : null;

      let etaValue: number | null = null;
      let etaConfidence: Confidence = 'unknown';
      if (scalingInProgress && unavailable !== null && unavailable > 0) {
        etaValue = FALLBACK_ETA_SECONDS;
        etaConfidence = 'low';
      }

      const currentStr = current !== null ? String(current) : '?';
      const desiredStr = desired !== null ? String(desired) : '?';
      const maxStr = max !== null ? String(max) : '?';

      return {
        scalingInProgress: {
          value: scalingInProgress,
          confidence: scalingInProgress !== null ? 'high' : 'unknown',
        },
        estimatedReadySeconds: { value: etaValue, confidence: etaConfidence },
        atCapacityLimit: {
          value: atCapacityLimit,
          confidence: atCapacityLimit !== null ? 'high' : 'unknown',
        },
        capturedAt: now,
        summary: `Prometheus: ${currentStr}/${desiredStr} replicas ready (max: ${maxStr})`,
      };
    } catch (err) {
      return {
        scalingInProgress: { value: null, confidence: 'unknown' },
        estimatedReadySeconds: { value: null, confidence: 'unknown' },
        atCapacityLimit: { value: null, confidence: 'unknown' },
        capturedAt: now,
        summary: `Prometheus adapter error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ─── Prometheus query helpers ─────────────────────────────────────────────────

  /** Query a metric and return the sum of all returned values (aggregated across series). */
  private async querySum(metricName: string): Promise<number | null> {
    const results = await this.query(metricName);
    if (results.length === 0) return null;
    const sum = results.reduce((acc, r) => acc + parseFloat(r.value[1]), 0);
    return isNaN(sum) ? null : sum;
  }

  private async query(metricName: string): Promise<PrometheusResult[]> {
    const url = new URL('/api/v1/query', this.config.endpoint);
    url.searchParams.set('query', metricName);

    const token = this.config.bearerTokenEnv
      ? process.env[this.config.bearerTokenEnv]
      : undefined;

    const response = await this.httpGet(url, token);
    const parsed = JSON.parse(response) as PrometheusQueryResponse;

    if (parsed.status !== 'success') {
      throw new Error(`Prometheus query failed: ${parsed.error ?? 'unknown error'}`);
    }

    return parsed.data.result;
  }

  private httpGet(url: URL, bearerToken?: string): Promise<string> {
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    return new Promise<string>((resolve, reject) => {
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
        },
      };

      const req = transport.request(options, res => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Prometheus returned ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          resolve(body);
        });
      });

      req.on('error', reject);
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error('Prometheus request timed out'));
      });
      req.end();
    });
  }
}
