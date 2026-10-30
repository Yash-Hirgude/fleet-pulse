import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { ActivatedRoute } from '@angular/router';
import { ApiClient } from '../../core/http/api-client';
import { toApiFailure } from '../../core/http/api-error';

type ProbeState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; count: number }
  | { kind: 'error'; message: string };

/** Placeholder page. Optionally GETs a probe path so the auth/retry/timeout stack can be exercised with chaos. */
@Component({
  selector: 'fp-stub-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule],
  template: `
    <h1>{{ heading }}</h1>
    @switch (state().kind) {
      @case ('loading') {
        <p>Loading…</p>
      }
      @case ('ok') {
        <p>Loaded {{ okCount() }} items.</p>
      }
      @case ('error') {
        <p role="alert">{{ errorMessage() }}</p>
        <button mat-stroked-button type="button" (click)="load()">Retry</button>
      }
      @default {
        <p>Coming soon.</p>
      }
    }
  `,
})
export class StubPage {
  private readonly api = inject(ApiClient);
  private readonly data = inject(ActivatedRoute).snapshot.data as {
    heading: string;
    probe?: string;
  };

  readonly heading = this.data.heading;
  readonly state = signal<ProbeState>({ kind: 'idle' });

  constructor() {
    if (this.data.probe) this.load();
  }

  okCount = () => (this.state() as { count: number }).count;
  errorMessage = () => (this.state() as { message: string }).message;

  load(): void {
    if (!this.data.probe) return;
    this.state.set({ kind: 'loading' });
    this.api.get<unknown[]>(this.data.probe).subscribe({
      next: (items) => this.state.set({ kind: 'ok', count: items.length }),
      error: (err: unknown) =>
        this.state.set({ kind: 'error', message: toApiFailure(err).message }),
    });
  }
}
