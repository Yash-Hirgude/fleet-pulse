export type MetricStatus = 'healthy' | 'degraded' | 'down';
export const METRIC_STATUSES: readonly MetricStatus[] = ['healthy', 'degraded', 'down'];

/** One metric event, exactly as the server sends it. `offset` is global, `seq` is per service. */
export interface MetricEvent {
  readonly type: 'metric';
  readonly offset: number;
  readonly serviceId: string;
  readonly seq: number;
  readonly ts: number;
  readonly p95: number;
  readonly errRate: number;
  readonly rps: number;
  readonly status: MetricStatus;
}

export interface ServiceInfo {
  readonly id: string;
  readonly name: string;
  readonly team: string;
  readonly status: MetricStatus;
}

export interface MetricsSnapshot {
  readonly offset: number;
  readonly ts: number;
  readonly metrics: readonly MetricEvent[];
}

export interface ReplayResponse {
  readonly events: readonly MetricEvent[];
  readonly offset: number;
}