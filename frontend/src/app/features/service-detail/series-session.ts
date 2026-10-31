import { signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { AppConfig } from '../../core/config/app-config';
import { ApiClient } from '../../core/http/api-client';
import { toApiFailure } from '../../core/http/api-error';
import { MetricsStore } from '../../core/stream/metrics-store';
import { SeriesBuffer, SeriesPoint } from './series-buffer';

export interface HistoryResponse {
  readonly serviceId: string;
  readonly points: readonly SeriesPoint[];
}

export type SessionState = 'loading' | 'ready' | 'error';

function isHistory(value: unknown): value is HistoryResponse {
  const v = value as HistoryResponse | null;
  return typeof v?.serviceId === 'string' && Array.isArray(v.points);
}

/**
 * Everything the detail page knows about ONE service: its history request, its live subscription and its buffer.
 * Switching services disposes the session and creates a new one, so state can never leak from one service to the
 * next: a late response, or an event of another service, has nowhere to go.
 */
export class SeriesSession {
  readonly state = signal<SessionState>('loading');
  readonly errorMessage = signal('');
  /** Bumps whenever the buffer changed, so the charts recompute. */
  readonly version = signal(0);

  /** The store's resync counter this session has already dealt with. */
  resyncSeen: number;

  private readonly buffer: SeriesBuffer;
  private request: Subscription | null = null;
  private unlisten: (() => void) | null = null;
  private disposed = false;

  constructor(
    readonly serviceId: string,
    private readonly api: ApiClient,
    private readonly store: MetricsStore,
    private readonly ui: AppConfig['ui'],
  ) {
    const windowMs = ui.chartHistoryMinutes * 60_000;
    this.buffer = new SeriesBuffer(windowMs / ui.chartMaxPoints, ui.chartMaxPoints);
    this.resyncSeen = store.resyncs();
  }

  start(): void {
    this.unlisten = this.store.onEvent((e) => {
      if (this.disposed || e.serviceId !== this.serviceId) return;
      this.buffer.add(e.ts, e.p95, e.errRate, e.rps);
      this.version.update((v) => v + 1);
    });
    this.loadHistory();
  }

  /** (Re)loads the REST history. A request still in flight is cancelled first. */
  loadHistory(): void {
    this.request?.unsubscribe();
    if (this.buffer.points().length === 0) this.state.set('loading');
    this.request = this.api
      .get<unknown>('/metrics/history', {
        serviceId: this.serviceId,
        minutes: this.ui.chartHistoryMinutes,
      })
      .subscribe({
        next: (res) => {
          if (this.disposed) return;
          // belt and braces: never accept data that is about another service
          if (!isHistory(res) || res.serviceId !== this.serviceId) {
            return this.fail('The server returned history that does not belong to this service.');
          }
          this.buffer.addMany(res.points);
          this.state.set('ready');
          this.version.update((v) => v + 1);
        },
        error: (err: unknown) => {
          if (!this.disposed) this.fail(toApiFailure(err).message);
        },
      });
  }

  points(): SeriesPoint[] {
    return this.buffer.points();
  }

  get rejectedSamples(): number {
    return this.buffer.rejected;
  }

  dispose(): void {
    this.disposed = true;
    this.request?.unsubscribe();
    this.unlisten?.();
    this.unlisten = null;
  }

  private fail(message: string): void {
    this.errorMessage.set(message);
    this.state.set('error');
  }
}
