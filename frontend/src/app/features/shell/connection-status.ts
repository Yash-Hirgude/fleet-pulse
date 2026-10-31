import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { StreamService } from '../../core/stream/stream.service';

type Tone = 'ok' | 'warn' | 'bad' | 'idle';

interface StatusView {
  readonly label: string;
  /** Short, countdown-free text for screen readers, so they are told about changes, not about every second. */
  readonly announcement: string;
  readonly tone: Tone;
}

/** Always visible in the toolbar: which transport is active, whether data is stale, when the last event arrived. */
@Component({
  selector: 'fp-connection-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './connection-status.scss',
  template: `
    <span class="status" [attr.data-tone]="view().tone">
      <span class="status__dot" aria-hidden="true"></span>
      <span aria-hidden="true">{{ view().label }}</span>
      <span class="sr-only" role="status">{{ view().announcement }}</span>
    </span>
  `,
})
export class ConnectionStatus {
  private readonly stream = inject(StreamService);

  protected readonly view = computed<StatusView>(() => {
    const state = this.stream.connection();
    const now = this.stream.now();
    switch (state.status) {
      case 'offline':
        return { label: 'Offline', announcement: 'Offline', tone: 'bad' };
      case 'reconnecting': {
        const seconds = Math.max(0, Math.ceil((state.retryAt - now) / 1000));
        return { label: `Reconnecting in ${seconds} s`, announcement: 'Reconnecting', tone: 'warn' };
      }
      case 'connecting':
        return { label: 'Connecting…', announcement: 'Connecting', tone: 'idle' };
      case 'live': {
        if (this.stream.isStale()) {
          const seconds = this.stream.staleForSeconds();
          return { label: `Stale: last event ${seconds} s ago`, announcement: 'Data is stale', tone: 'warn' };
        }
        const label = this.stream.transportLabel(state.transport);
        return { label, announcement: label, tone: state.transport === 'polling' ? 'warn' : 'ok' };
      }
      default:
        return { label: '', announcement: '', tone: 'idle' };
    }
  });
}