import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { ChartBox, ChartPoint, buildChartModel } from './chart-model';

const BOX: ChartBox = { width: 640, height: 190, left: 48, right: 12, top: 10, bottom: 24 };

type View =
  | { readonly kind: 'empty' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ok'; readonly model: NonNullable<ReturnType<typeof buildChartModel>> };

/**
 * A small hand-written SVG line chart. It owns its failure mode: bad data makes THIS panel show an error with a
 * Retry button, and nothing else on the page is affected.
 */
@Component({
  selector: 'fp-line-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule],
  styleUrl: './line-chart.scss',
  template: `
    <figure class="chart" [class.is-stale]="stale()">
      <figcaption>
        <span class="chart__title">{{ title() }}</span>
        @if (summary(); as s) {
          <span class="chart__last">{{ s.last }} {{ unit() }}</span>
        }
        @if (stale()) {
          <span class="chart__stale">stale</span>
        }
      </figcaption>

      @switch (view().kind) {
        @case ('error') {
          <div class="chart__error" role="alert">
            <p>This chart could not be drawn.</p>
            <button mat-stroked-button type="button" (click)="retry.emit()">Retry</button>
          </div>
        }
        @case ('ok') {
          @if (model(); as m) {
            <svg
              viewBox="0 0 640 190"
              role="img"
              [attr.aria-label]="ariaLabel()"
              preserveAspectRatio="none"
            >
              @for (tick of m.yTicks; track tick.y) {
                <line
                  class="grid"
                  [attr.x1]="48"
                  [attr.x2]="628"
                  [attr.y1]="tick.y"
                  [attr.y2]="tick.y"
                />
                <text class="axis" x="44" text-anchor="end" [attr.y]="tick.y + 4">
                  {{ tick.label }}
                </text>
              }
              <path class="line" [attr.d]="m.path" />
              <text class="axis" x="48" y="186">{{ time(m.firstTs) }}</text>
              <text class="axis" x="628" y="186" text-anchor="end">{{ time(m.lastTs) }}</text>
            </svg>
          }
        }
        @default {
          <p class="chart__empty">No data yet.</p>
        }
      }
    </figure>
  `,
})
export class LineChart {
  readonly title = input.required<string>();
  readonly unit = input('');
  readonly decimals = input(0);
  readonly points = input.required<readonly ChartPoint[]>();
  readonly stale = input(false);
  readonly retry = output<void>();

  protected readonly view = computed<View>(() => {
    try {
      const model = buildChartModel(this.points(), BOX, this.decimals());
      return model ? { kind: 'ok', model } : { kind: 'empty' };
    } catch {
      return { kind: 'error' };
    }
  });

  protected readonly model = computed(() => {
    const v = this.view();
    return v.kind === 'ok' ? v.model : null;
  });

  protected readonly summary = computed(() => {
    const m = this.model();
    return m ? { last: m.last.toFixed(this.decimals()) } : null;
  });

  protected readonly ariaLabel = computed(() => {
    const m = this.model();
    if (!m) return this.title();
    const d = this.decimals();
    return `${this.title()}: latest ${m.last.toFixed(d)} ${this.unit()}, range ${m.min.toFixed(d)} to ${m.max.toFixed(d)} ${this.unit()}`;
  });

  protected time(ts: number): string {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
}
