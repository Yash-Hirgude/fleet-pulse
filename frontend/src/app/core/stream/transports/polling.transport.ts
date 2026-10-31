import { Observable, Subscription } from 'rxjs';
import { MetricsSnapshot } from '../stream.models';
import { StreamTransport, TransportHandlers } from './stream-transport';

/** Last-resort transport: GET /metrics/snapshot every `intervalMs`. Delivers whole snapshots, not frames. */
export class PollingTransport implements StreamTransport {
  private active = false;
  private opened = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sub: Subscription | null = null;

  constructor(
    private readonly poll: () => Observable<MetricsSnapshot>,
    private readonly intervalMs: number,
    private readonly handlers: TransportHandlers,
  ) {}

  connect(): void {
    this.active = true;
    this.tick();
  }

  close(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.sub?.unsubscribe();
  }

  private tick(): void {
    this.sub = this.poll().subscribe({
      next: (snapshot) => {
        if (!this.active) return;
        if (!this.opened) {
          this.opened = true;
          this.handlers.opened();
        }
        this.handlers.snapshot(snapshot);
        // next poll starts after this one finished, so slow responses never pile up
        this.timer = setTimeout(() => this.tick(), this.intervalMs);
      },
      error: () => {
        if (!this.active) return;
        this.active = false;
        this.handlers.closed('error');
      },
    });
  }
}
