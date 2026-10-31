import { Provider, inject } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { APP_CONFIG } from '../config/app-config';
import { ApiClient } from '../http/api-client';
import { MetricsSnapshot } from './stream.models';
import { PollingTransport } from './transports/polling.transport';
import { SseTransport } from './transports/sse.transport';
import { STREAM_TRANSPORTS, TransportDefinition } from './transports/stream-transport';
import { WebSocketTransport } from './transports/websocket.transport';

/**
 * The transports in priority order. Adding a fourth one means adding an entry here; the connection manager,
 * the sequencer and everything that reads the stream stay untouched.
 */
export function provideStreamTransports(): Provider[] {
  return [
    {
      provide: STREAM_TRANSPORTS,
      multi: true,
      useFactory: (): TransportDefinition => {
        const cfg = inject(APP_CONFIG);
        const auth = inject(AuthService);
        return {
          kind: 'websocket',
          label: 'Live (WebSocket)',
          heartbeat: true,
          create: (h) => new WebSocketTransport(cfg.api.wsUrl, () => auth.accessToken(), h),
        };
      },
    },
    {
      provide: STREAM_TRANSPORTS,
      multi: true,
      useFactory: (): TransportDefinition => {
        const cfg = inject(APP_CONFIG);
        const auth = inject(AuthService);
        return {
          kind: 'sse',
          label: 'Live (SSE)',
          heartbeat: true,
          create: (h) => new SseTransport(cfg.api.baseUrl, () => auth.accessToken(), h),
        };
      },
    },
    {
      provide: STREAM_TRANSPORTS,
      multi: true,
      useFactory: (): TransportDefinition => {
        const cfg = inject(APP_CONFIG);
        const api = inject(ApiClient);
        return {
          kind: 'polling',
          label: 'Polling',
          heartbeat: false,
          create: (h) =>
            new PollingTransport(() => api.get<MetricsSnapshot>('/metrics/snapshot'), cfg.stream.pollingIntervalMs, h),
        };
      },
    },
  ];
}