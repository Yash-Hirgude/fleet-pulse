import { InjectionToken } from '@angular/core';

/**
 * Every timeout, retry cap, delay limit and threshold from the brief lives here, nowhere else.
 * Provided through DI so tests can override individual values.
 */
export interface AppConfig {
  readonly api: { readonly baseUrl: string; readonly wsUrl: string };
  readonly http: {
    readonly timeoutMs: number;
    readonly maxAttempts: number; // initial try + retries
    readonly retryableStatuses: readonly number[];
    readonly retryBaseDelayMs: number;
    readonly retryMaxDelayMs: number;
  };
  readonly stream: {
    readonly connectTimeoutMs: number;
    readonly failuresBeforeFallback: number;
    readonly climbBackIntervalMs: number;
    readonly backoff: { readonly baseMs: number; readonly maxMs: number };
    readonly pingIntervalMs: number;
    readonly missedPingsLimit: number;
    readonly heartbeatGraceMs: number;
    readonly pollingIntervalMs: number;
    readonly reorderWindowMs: number;
    readonly maxBufferedEvents: number;
    readonly gapCheckIntervalMs: number;
    readonly replayCooldownMs: number;
  };
  readonly freshness: { readonly staleAfterMs: number };
  readonly ui: {
    readonly flushIntervalMs: number;
    readonly tableRowHeightPx: number;
    readonly chartMaxPoints: number;
    readonly chartHistoryMinutes: number;
    readonly searchDebounceMs: number;
    readonly tableOverscanRows: number;
  };
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  api: { baseUrl: 'http://localhost:4000', wsUrl: 'ws://localhost:4000' },
  http: {
    timeoutMs: 10_000,
    maxAttempts: 3,
    retryableStatuses: [429, 502, 503, 504],
    retryBaseDelayMs: 300,
    retryMaxDelayMs: 30_000,
  },
  stream: {
    connectTimeoutMs: 5_000,
    failuresBeforeFallback: 3,
    climbBackIntervalMs: 30_000,
    backoff: { baseMs: 1_000, maxMs: 30_000 },
    pingIntervalMs: 5_000,
    missedPingsLimit: 2,
    heartbeatGraceMs: 500,
    pollingIntervalMs: 2_000,
    reorderWindowMs: 1_000,
    maxBufferedEvents: 20_000,
    gapCheckIntervalMs: 250,
    replayCooldownMs: 1_000,
  },
  freshness: { staleAfterMs: 10_000 },
  ui: {
    flushIntervalMs: 250,
    tableRowHeightPx: 40,
    chartMaxPoints: 300,
    chartHistoryMinutes: 15,
    searchDebounceMs: 200,
    tableOverscanRows: 8,
  },
};

export const APP_CONFIG = new InjectionToken<AppConfig>('APP_CONFIG', {
  providedIn: 'root',
  factory: () => DEFAULT_APP_CONFIG,
});