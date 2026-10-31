import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { APP_CONFIG } from '../../core/config/app-config';
import { ApiClient } from '../../core/http/api-client';
import { StreamService } from '../../core/stream/stream.service';
import { LineChart } from './line-chart';
import { SeriesSession } from './series-session';

@Component({
  selector: 'fp-service-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatButtonModule, LineChart],
  styleUrl: './service-detail.page.scss',
  template: `
    <p><a routerLink="/fleet">← Back to fleet</a></p>

    @if (stream.initialLoad() !== 'ready') {
      <p>Loading service…</p>
    } @else if (!row()) {
      <h1>Service not found</h1>
      <p>There is no service with id {{ id() }}.</p>
    } @else {
      @let r = row();
      @let m = r!.metrics();
      <header class="head">
        <h1>{{ r!.name }}</h1>
        <span class="head__id">{{ r!.id }} · {{ r!.team }}</span>
        <span class="pill" [attr.data-status]="m.status">{{ m.status }}</span>
      </header>

      @if (stream.isStale()) {
        <p class="stale" role="status">
          Live data is stale: no event for {{ stream.staleForSeconds() }} s.
        </p>
      }

      <!-- the charts panel is isolated: a failure here is shown here, and the rest of the app keeps working -->
      <section class="charts" aria-label="Metrics, last {{ minutes }} minutes">
        @if (session(); as s) {
          @switch (s.state()) {
            @case ('error') {
              <div class="panel-error" role="alert">
                <p>Could not load the history: {{ s.errorMessage() }}</p>
                <button mat-stroked-button type="button" (click)="s.loadHistory()">Retry</button>
              </div>
            }
            @case ('loading') {
              <p>Loading history…</p>
            }
            @default {
              <fp-line-chart
                title="p95 latency"
                unit="ms"
                [points]="p95()"
                [stale]="stream.isStale()"
                (retry)="reset()"
              />
              <fp-line-chart
                title="Error rate"
                unit="%"
                [decimals]="1"
                [points]="errRate()"
                [stale]="stream.isStale()"
                (retry)="reset()"
              />
              <fp-line-chart
                title="Requests per second"
                unit="req/s"
                [points]="rps()"
                [stale]="stream.isStale()"
                (retry)="reset()"
              />
              <p class="note">
                {{ p95().length }} points per series (max {{ maxPoints }}, {{ bucketSeconds }} s
                buckets). Latency and error rate show the worst value in each bucket.
              </p>
            }
          }
        } @else {
          <p>Loading history…</p>
        }
      </section>
    }
  `,
})
export class ServiceDetailPage {
  /** Bound from the route parameter :id (withComponentInputBinding). */
  readonly id = input.required<string>();

  protected readonly stream = inject(StreamService);
  private readonly api = inject(ApiClient);
  private readonly ui = inject(APP_CONFIG).ui;

  protected readonly minutes = this.ui.chartHistoryMinutes;
  protected readonly maxPoints = this.ui.chartMaxPoints;
  protected readonly bucketSeconds = (this.ui.chartHistoryMinutes * 60) / this.ui.chartMaxPoints;

  protected readonly row = computed(() => {
    this.stream.store.version();
    return this.stream.store.row(this.id());
  });

  /** Only a service that is in the fleet gets a session (an unknown id must not trigger a request). */
  private readonly exists = computed(() => this.stream.initialLoad() === 'ready' && !!this.row());

  private readonly attempt = signal(0);
  private readonly current = signal<SeriesSession | null>(null);

  /**
   * The session, but only if it belongs to the id in the URL right now. When the id changes, this is null in
   * the same change-detection pass, so another service's data can never be on screen, not even for one frame.
   */
  protected readonly session = computed(() => {
    const s = this.current();
    return s && s.serviceId === this.id() ? s : null;
  });

  private readonly points = computed(() => {
    const s = this.session();
    s?.version();
    return s ? s.points() : [];
  });
  protected readonly p95 = computed(() => this.points().map((p) => ({ ts: p.ts, v: p.p95 })));
  protected readonly errRate = computed(() =>
    this.points().map((p) => ({ ts: p.ts, v: p.errRate })),
  );
  protected readonly rps = computed(() => this.points().map((p) => ({ ts: p.ts, v: p.rps })));

  constructor() {
    // (re)open a session whenever the id changes, or after "Retry" on a broken chart; the old one is disposed
    effect((onCleanup) => {
      const id = this.id();
      this.attempt();
      if (!this.exists()) {
        this.current.set(null);
        return;
      }
      const session = untracked(() => new SeriesSession(id, this.api, this.stream.store, this.ui));
      session.start();
      this.current.set(session);
      onCleanup(() => session.dispose());
    });

    // the stream was reloaded from a snapshot (replay_too_old): the history now has a hole, so fetch it again
    effect(() => {
      const resyncs = this.stream.store.resyncs();
      untracked(() => {
        const s = this.current();
        if (s && s.resyncSeen !== resyncs) {
          s.resyncSeen = resyncs;
          s.loadHistory();
        }
      });
    });
  }

  protected reset(): void {
    this.attempt.update((n) => n + 1);
  }
}
