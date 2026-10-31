import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { APP_CONFIG } from '../../core/config/app-config';
import { StreamService } from '../../core/stream/stream.service';
import { SortKey, StatusFilter, applyQuery, parseQuery, toQueryParams } from './fleet-view';

interface Column {
  readonly key: SortKey;
  readonly label: string;
  readonly numeric: boolean;
}

@Component({
  selector: 'fp-fleet-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatFormFieldModule, MatInputModule, MatButtonModule],
  styleUrl: './fleet.page.scss',
  template: `
    <h1>Fleet</h1>

    @switch (stream.initialLoad()) {
      @case ('error') {
        <p role="alert">Could not load the fleet.</p>
        <button mat-stroked-button type="button" (click)="stream.retryInitialLoad()">Retry</button>
      }
      @case ('ready') {
        <div class="controls">
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Search</mat-label>
            <input matInput type="search" #searchBox [value]="search()" (input)="onSearch(searchBox.value)" />
          </mat-form-field>

          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Status</mat-label>
            <select matNativeControl #statusBox [value]="query().status" (change)="setStatus(statusBox.value)">
              <option value="all">All</option>
              <option value="healthy">Healthy</option>
              <option value="degraded">Degraded</option>
              <option value="down">Down</option>
            </select>
          </mat-form-field>

          <p class="controls__count">Showing {{ list().length }} of {{ stream.store.rows.length }} services</p>
        </div>

        @if (stream.isStale()) {
          <p class="stale" role="status">
            Data is stale: no event for {{ stream.staleForSeconds() }} s. The numbers below may be out of date.
          </p>
        }

        <!-- the viewport is the single tab stop; arrow keys move the active row (aria-activedescendant) -->
        <div
          #viewport
          class="viewport"
          [class.is-stale]="stream.isStale()"
          role="grid"
          aria-label="Services"
          [attr.aria-rowcount]="list().length + 1"
          [attr.aria-activedescendant]="activeId() ? 'row-' + activeId() : null"
          tabindex="0"
          (scroll)="onScroll()"
          (keydown)="onKeydown($event)"
        >
          <table role="presentation">
            <thead>
              <tr role="row" aria-rowindex="1">
                @for (col of columns; track col.key) {
                  <th role="columnheader" scope="col" [class.num]="col.numeric" [attr.aria-sort]="ariaSort(col.key)">
                    <button type="button" class="th-btn" tabindex="-1" (click)="sortBy(col.key)">
                      {{ col.label }}
                      <span aria-hidden="true">{{ arrow(col.key) }}</span>
                    </button>
                  </th>
                }
              </tr>
            </thead>
            <tbody>
              <tr aria-hidden="true" class="spacer" [style.height.px]="topSpace()"><td colspan="5"></td></tr>
              @for (row of windowRows(); track row.id; let i = $index) {
                @let m = row.metrics();
                <tr
                  role="row"
                  class="row"
                  [id]="'row-' + row.id"
                  [class.is-active]="row.id === activeId()"
                  [attr.aria-rowindex]="startIndex() + i + 2"
                >
                  <td role="gridcell">
                    <a [routerLink]="['/services', row.id]" tabindex="-1">{{ row.name }}</a>
                    <span class="team">{{ row.team }}</span>
                  </td>
                  <td role="gridcell" class="num">{{ m.p95 }} ms</td>
                  <td role="gridcell" class="num">{{ m.errRate.toFixed(1) }} %</td>
                  <td role="gridcell" class="num">{{ m.rps }}</td>
                  <td role="gridcell">
                    <!-- a new element per status change restarts the flash animation -->
                    @for (change of [m.statusChanges]; track change) {
                      <span class="pill" [class.flash]="change > 0" [attr.data-status]="m.status">{{ m.status }}</span>
                    }
                  </td>
                </tr>
              }
              <tr aria-hidden="true" class="spacer" [style.height.px]="bottomSpace()"><td colspan="5"></td></tr>
            </tbody>
          </table>
        </div>

        <details class="debug">
          <summary>Stream debug counters</summary>
          <dl>
            @for (entry of statEntries(); track entry[0]) {
              <dt>{{ entry[0] }}</dt>
              <dd>{{ entry[1] }}</dd>
            }
          </dl>
        </details>
      }
      @default {
        <p>Loading services…</p>
      }
    }
  `,
})
export class FleetPage {
  protected readonly stream = inject(StreamService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly cfg = inject(APP_CONFIG).ui;

  // query parameters arrive as inputs (withComponentInputBinding)
  readonly q = input<string | undefined>(undefined);
  readonly status = input<string | undefined>(undefined);
  readonly sort = input<string | undefined>(undefined);
  readonly dir = input<string | undefined>(undefined);

  protected readonly columns: readonly Column[] = [
    { key: 'name', label: 'Service', numeric: false },
    { key: 'p95', label: 'p95 latency', numeric: true },
    { key: 'errRate', label: 'Error rate', numeric: true },
    { key: 'rps', label: 'Requests/s', numeric: true },
    { key: 'status', label: 'Status', numeric: false },
  ];

  private readonly urlQuery = computed(() =>
    parseQuery({ q: this.q(), status: this.status(), sort: this.sort(), dir: this.dir() }),
  );
  /** Text in the search box. Applied instantly; written to the URL after a short pause. */
  protected readonly search = signal('');
  protected readonly query = computed(() => ({ ...this.urlQuery(), q: this.search() }));

  /** Filtered and sorted rows. Depends on the store version, not on 2,000 row signals. */
  protected readonly list = computed(() => {
    this.stream.store.version();
    const query = this.query();
    return untracked(() => applyQuery(this.stream.store.rows, query));
  });

  // ---- windowing: only the rows in view (plus overscan) exist in the DOM
  private readonly scrollTop = signal(0);
  private readonly viewportHeight = signal(600);
  protected readonly startIndex = computed(() =>
    Math.max(0, Math.floor(this.scrollTop() / this.cfg.tableRowHeightPx) - this.cfg.tableOverscanRows),
  );
  private readonly endIndex = computed(() =>
    Math.min(
      this.list().length,
      Math.ceil((this.scrollTop() + this.viewportHeight()) / this.cfg.tableRowHeightPx) + this.cfg.tableOverscanRows,
    ),
  );
  protected readonly windowRows = computed(() => this.list().slice(this.startIndex(), this.endIndex()));
  protected readonly topSpace = computed(() => this.startIndex() * this.cfg.tableRowHeightPx);
  protected readonly bottomSpace = computed(() => (this.list().length - this.endIndex()) * this.cfg.tableRowHeightPx);

  protected readonly activeId = signal<string | null>(null);
  protected readonly statEntries = computed(() => Object.entries(this.stream.stats()));

  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // back/forward or a pasted link changes the URL: bring the search box in line
    effect(() => {
      const q = this.urlQuery().q;
      untracked(() => {
        if (q !== this.search()) this.search.set(q);
      });
    });

    // the viewport element only exists once the data has loaded
    effect(() => {
      const el = this.viewport()?.nativeElement;
      if (!el) return;
      this.viewportHeight.set(el.clientHeight || 600);
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => this.viewportHeight.set(el.clientHeight || 600));
      observer.observe(el);
      return () => observer.disconnect();
    });

    // a new filter or sort starts at the top
    effect(() => {
      this.query();
      untracked(() => {
        const el = this.viewport()?.nativeElement;
        if (el) el.scrollTop = 0;
        this.scrollTop.set(0);
      });
    });

    inject(DestroyRef).onDestroy(() => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
    });
    afterNextRender(() => this.scrollTop.set(this.viewport()?.nativeElement.scrollTop ?? 0));
  }

  // ---------------------------------------------------------------- controls

  protected onSearch(value: string): void {
    this.search.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.writeUrl({ ...this.query(), q: value }), this.cfg.searchDebounceMs);
  }

  protected setStatus(value: string): void {
    this.writeUrl({ ...this.query(), status: value as StatusFilter });
  }

  protected sortBy(key: SortKey): void {
    const q = this.query();
    this.writeUrl({ ...q, sort: key, dir: q.sort === key && q.dir === 'asc' ? 'desc' : 'asc' });
  }

  protected ariaSort(key: SortKey): 'ascending' | 'descending' | 'none' {
    const q = this.query();
    return q.sort !== key ? 'none' : q.dir === 'asc' ? 'ascending' : 'descending';
  }

  protected arrow(key: SortKey): string {
    const sort = this.ariaSort(key);
    return sort === 'none' ? '' : sort === 'ascending' ? '▲' : '▼';
  }

  private writeUrl(query: ReturnType<typeof this.query>): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toQueryParams(query),
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  // ---------------------------------------------------------------- scrolling and keyboard

  protected onScroll(): void {
    this.scrollTop.set(this.viewport()?.nativeElement.scrollTop ?? 0);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const rows = this.list();
    if (rows.length === 0) return;
    const page = Math.max(1, Math.floor(this.viewportHeight() / this.cfg.tableRowHeightPx) - 1);
    const current = this.activeId() === null ? -1 : rows.findIndex((r) => r.id === this.activeId());

    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = current + 1;
        break;
      case 'ArrowUp':
        next = current - 1;
        break;
      case 'PageDown':
        next = current + page;
        break;
      case 'PageUp':
        next = current - page;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = rows.length - 1;
        break;
      case 'Enter':
        if (current >= 0) void this.router.navigate(['/services', rows[current].id]);
        return;
      default:
        return;
    }
    event.preventDefault();
    next = Math.min(rows.length - 1, Math.max(0, next));
    this.activeId.set(rows[next].id);
    this.scrollIntoView(next);
  }

  private scrollIntoView(index: number): void {
    const el = this.viewport()?.nativeElement;
    if (!el) return;
    const rowH = this.cfg.tableRowHeightPx;
    const headerH = el.querySelector('thead')?.clientHeight ?? 0;
    const top = index * rowH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH + headerH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH + headerH - el.clientHeight;
    this.scrollTop.set(el.scrollTop);
  }
}