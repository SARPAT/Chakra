// Kubernetes Adapter — Reads K8s API (HPA status + pod states)
//
// Answers the three Container Bridge questions by reading:
//   - HorizontalPodAutoscaler status (desired vs current replicas, max)
//   - Pod list (pending + creating pods, for time estimation)
//
// Tracks historical pod start times to improve ETA estimates over time.
// Supports three auth modes: in-cluster, kubeconfig, and token.

import * as https from 'https';
import * as fs from 'fs';
import type {
  InfrastructureAdapter,
  InfrastructureSnapshot,
  BoolSignal,
  NumberSignal,
  Confidence,
} from '../adapter-interface';

// ─── K8s API response shapes (minimal — only fields CHAKRA uses) ──────────────

interface HPAStatus {
  currentReplicas: number;
  desiredReplicas: number;
}

interface HPASpec {
  maxReplicas: number;
}

interface HPAItem {
  metadata: { name: string };
  status: HPAStatus;
  spec: HPASpec;
}

interface HPAListResponse {
  items: HPAItem[];
}

interface PodCondition {
  type: string;
  status: string;
}

interface ContainerStateWaiting {
  reason?: string;
}

interface ContainerState {
  waiting?: ContainerStateWaiting;
}

interface ContainerStatus {
  state?: ContainerState;
}

interface PodStatus {
  phase?: string;
  conditions?: PodCondition[];
  containerStatuses?: ContainerStatus[];
  startTime?: string;
}

interface PodItem {
  metadata: { name: string; creationTimestamp?: string };
  status: PodStatus;
}

interface PodListResponse {
  items: PodItem[];
}

// ─── Configuration ─────────────────────────────────────────────────────────────

export type KubernetesAuthMode = 'in-cluster' | 'kubeconfig' | 'token';

export interface KubernetesAdapterConfig {
  namespace: string;
  /** Filter to specific deployment names. If empty, reads all HPAs. */
  deploymentNames?: string[];
  authMode: KubernetesAuthMode;
  /** Required when authMode is 'token'. Env var name holding the K8s host. */
  hostEnv?: string;
  /** Required when authMode is 'token'. Env var name holding the bearer token. */
  tokenEnv?: string;
  /** Required when authMode is 'kubeconfig'. Defaults to ~/.kube/config */
  kubeconfigPath?: string;
  /** How many historical pod start durations to average (default: 10) */
  podStartHistorySize?: number;
}

// ─── In-cluster token/CA paths ────────────────────────────────────────────────

const IN_CLUSTER_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const IN_CLUSTER_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
const IN_CLUSTER_HOST = 'https://kubernetes.default.svc';

const DEFAULT_POD_START_HISTORY_SIZE = 10;
// Fargate/K8s typical pod start time fallback estimate (seconds)
const FALLBACK_POD_START_SECONDS = 45;

// ─── KubernetesAdapter ─────────────────────────────────────────────────────────

export class KubernetesAdapter implements InfrastructureAdapter {
  private readonly config: KubernetesAdapterConfig;
  private readonly podStartHistory: number[] = [];
  private readonly historySize: number;

  // Resolved auth credentials (lazily loaded)
  private resolvedHost: string | null = null;
  private resolvedToken: string | null = null;
  private resolvedCA: string | null = null;

  constructor(config: KubernetesAdapterConfig) {
    this.config = config;
    this.historySize = config.podStartHistorySize ?? DEFAULT_POD_START_HISTORY_SIZE;
  }

  // ─── InfrastructureAdapter implementation ────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    try {
      await this.fetchHPAList();
      return true;
    } catch {
      return false;
    }
  }

  async isScalingInProgress(): Promise<BoolSignal> {
    try {
      const hpas = await this.fetchHPAList();
      const relevant = this.filterHPAs(hpas);
      const scaling = relevant.some(h => h.status.desiredReplicas > h.status.currentReplicas);
      return { value: scaling, confidence: 'high' };
    } catch {
      return { value: null, confidence: 'unknown' };
    }
  }

  async estimatedReadySeconds(): Promise<NumberSignal> {
    try {
      const [hpas, pods] = await Promise.all([
        this.fetchHPAList(),
        this.fetchPods(),
      ]);

      const relevant = this.filterHPAs(hpas);
      const scaling = relevant.some(h => h.status.desiredReplicas > h.status.currentReplicas);
      if (!scaling) return { value: null, confidence: 'unknown' };

      const notReadyCount = this.countNotReadyPods(pods);
      if (notReadyCount === 0) return { value: null, confidence: 'unknown' };

      const avgStartSeconds = this.averagePodStartSeconds();
      const confidence: Confidence = this.podStartHistory.length >= 3 ? 'medium' : 'low';
      return { value: avgStartSeconds, confidence };
    } catch {
      return { value: null, confidence: 'unknown' };
    }
  }

  async isAtCapacityLimit(): Promise<BoolSignal> {
    try {
      const hpas = await this.fetchHPAList();
      const relevant = this.filterHPAs(hpas);
      if (relevant.length === 0) return { value: null, confidence: 'unknown' };

      const atMax = relevant.some(h => h.status.currentReplicas >= h.spec.maxReplicas);
      return { value: atMax, confidence: 'high' };
    } catch {
      return { value: null, confidence: 'unknown' };
    }
  }

  async getSnapshot(): Promise<InfrastructureSnapshot> {
    const now = Date.now();
    try {
      const [hpas, pods] = await Promise.all([
        this.fetchHPAList(),
        this.fetchPods(),
      ]);

      const relevant = this.filterHPAs(hpas);
      const scalingInProgress = relevant.some(
        h => h.status.desiredReplicas > h.status.currentReplicas,
      );
      const atCapacityLimit = relevant.some(
        h => h.status.currentReplicas >= h.spec.maxReplicas,
      );

      let estimatedReadySeconds: number | null = null;
      let etaConfidence: Confidence = 'unknown';

      if (scalingInProgress) {
        const notReadyCount = this.countNotReadyPods(pods);
        if (notReadyCount > 0) {
          estimatedReadySeconds = this.averagePodStartSeconds();
          etaConfidence = this.podStartHistory.length >= 3 ? 'medium' : 'low';
        }
      }

      // Record completed pod start durations for history
      this.recordReadyPodStartTimes(pods);

      const totalCurrent = relevant.reduce((s, h) => s + h.status.currentReplicas, 0);
      const totalDesired = relevant.reduce((s, h) => s + h.status.desiredReplicas, 0);
      const totalMax = relevant.reduce((s, h) => s + h.spec.maxReplicas, 0);

      return {
        scalingInProgress: { value: scalingInProgress, confidence: 'high' },
        estimatedReadySeconds: { value: estimatedReadySeconds, confidence: etaConfidence },
        atCapacityLimit: { value: atCapacityLimit, confidence: 'high' },
        capturedAt: now,
        summary: `K8s: ${totalCurrent}/${totalDesired} pods ready (max: ${totalMax})`,
      };
    } catch (err) {
      return {
        scalingInProgress: { value: null, confidence: 'unknown' },
        estimatedReadySeconds: { value: null, confidence: 'unknown' },
        atCapacityLimit: { value: null, confidence: 'unknown' },
        capturedAt: now,
        summary: `K8s adapter error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ─── Pod start time tracking ──────────────────────────────────────────────────

  /**
   * Walk ready pods and record their start durations for future estimates.
   * Called inside getSnapshot() to learn from each poll cycle.
   */
  private recordReadyPodStartTimes(pods: PodListResponse): void {
    const now = Date.now();
    for (const pod of pods.items) {
      const isReady = pod.status.conditions?.some(
        c => c.type === 'Ready' && c.status === 'True',
      );
      if (!isReady) continue;

      const startTime = pod.status.startTime ?? pod.metadata.creationTimestamp;
      if (!startTime) continue;

      const startMs = new Date(startTime).getTime();
      if (isNaN(startMs)) continue;

      const durationSeconds = Math.round((now - startMs) / 1000);
      if (durationSeconds <= 0 || durationSeconds > 600) continue;

      this.podStartHistory.push(durationSeconds);
      if (this.podStartHistory.length > this.historySize) {
        this.podStartHistory.splice(0, this.podStartHistory.length - this.historySize);
      }
    }
  }

  private averagePodStartSeconds(): number {
    if (this.podStartHistory.length === 0) return FALLBACK_POD_START_SECONDS;
    const sum = this.podStartHistory.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.podStartHistory.length);
  }

  private countNotReadyPods(pods: PodListResponse): number {
    return pods.items.filter(pod => {
      const phase = pod.status.phase;
      if (phase === 'Pending') return true;
      const isCreating = pod.status.containerStatuses?.some(
        cs => cs.state?.waiting?.reason === 'ContainerCreating',
      );
      return isCreating === true;
    }).length;
  }

  // ─── HPA filtering ────────────────────────────────────────────────────────────

  private filterHPAs(hpas: HPAListResponse): HPAItem[] {
    if (!this.config.deploymentNames || this.config.deploymentNames.length === 0) {
      return hpas.items;
    }
    return hpas.items.filter(h =>
      this.config.deploymentNames!.some(name => h.metadata.name.includes(name)),
    );
  }

  // ─── K8s API calls ────────────────────────────────────────────────────────────

  private async fetchHPAList(): Promise<HPAListResponse> {
    const ns = this.config.namespace;
    const path = `/apis/autoscaling/v2/namespaces/${ns}/horizontalpodautoscalers`;
    return this.k8sGet<HPAListResponse>(path);
  }

  private async fetchPods(): Promise<PodListResponse> {
    const ns = this.config.namespace;
    const path = `/api/v1/namespaces/${ns}/pods`;
    return this.k8sGet<PodListResponse>(path);
  }

  private async k8sGet<T>(path: string): Promise<T> {
    const { host, token, ca } = await this.resolveAuth();
    const url = new URL(path, host);

    return new Promise<T>((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        ...(ca ? { ca } : { rejectUnauthorized: false }),
      };

      const req = https.request(options, res => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`K8s API returned ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (parseErr) {
            reject(new Error(`Failed to parse K8s response: ${String(parseErr)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(5_000, () => {
        req.destroy(new Error('K8s API request timed out'));
      });
      req.end();
    });
  }

  // ─── Auth resolution ──────────────────────────────────────────────────────────

  private async resolveAuth(): Promise<{ host: string; token: string; ca: string | null }> {
    if (this.resolvedHost !== null && this.resolvedToken !== null) {
      return { host: this.resolvedHost, token: this.resolvedToken, ca: this.resolvedCA };
    }

    const mode = this.config.authMode;

    if (mode === 'in-cluster') {
      const token = fs.readFileSync(IN_CLUSTER_TOKEN_PATH, 'utf8').trim();
      const ca = fs.readFileSync(IN_CLUSTER_CA_PATH, 'utf8');
      this.resolvedHost = IN_CLUSTER_HOST;
      this.resolvedToken = token;
      this.resolvedCA = ca;
      return { host: this.resolvedHost, token, ca };
    }

    if (mode === 'token') {
      const hostEnv = this.config.hostEnv ?? 'CHAKRA_K8S_HOST';
      const tokenEnv = this.config.tokenEnv ?? 'CHAKRA_K8S_TOKEN';
      const host = process.env[hostEnv];
      const token = process.env[tokenEnv];
      if (!host) throw new Error(`K8s host env var ${hostEnv} is not set`);
      if (!token) throw new Error(`K8s token env var ${tokenEnv} is not set`);
      this.resolvedHost = host;
      this.resolvedToken = token;
      this.resolvedCA = null;
      return { host, token, ca: null };
    }

    // kubeconfig mode — minimal: read server + token from kubeconfig
    const kubeconfigPath = this.config.kubeconfigPath
      ?? `${process.env['HOME'] ?? '~'}/.kube/config`;
    const raw = fs.readFileSync(kubeconfigPath, 'utf8');
    const { host, token } = this.parseKubeconfig(raw);
    this.resolvedHost = host;
    this.resolvedToken = token;
    this.resolvedCA = null;
    return { host, token, ca: null };
  }

  /**
   * Minimal kubeconfig parser — extracts server URL and user token.
   * Handles only token-based auth from kubeconfig (covers the common case).
   */
  private parseKubeconfig(raw: string): { host: string; token: string } {
    const serverMatch = raw.match(/server:\s*(\S+)/);
    const tokenMatch = raw.match(/token:\s*(\S+)/);

    if (!serverMatch) throw new Error('Could not parse server from kubeconfig');
    if (!tokenMatch) throw new Error('Could not parse token from kubeconfig');

    return { host: serverMatch[1], token: tokenMatch[1] };
  }
}
