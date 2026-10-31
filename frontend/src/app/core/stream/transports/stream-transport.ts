import { InjectionToken } from '@angular/core';
import { MetricsSnapshot } from '../stream.models';

export type CloseReason = 'error' | 'closed' | 'unauthorized';

/** What a transport reports back. The connection manager is the only consumer. */
export interface TransportHandlers {
  opened(): void;
  frame(raw: string): void;
  snapshot(snapshot: MetricsSnapshot): void;
  closed(reason: CloseReason): void;
}

export interface StreamTransport {
  connect(): void;
  close(): void;
}

/**
 * How a transport is registered. To add a fourth transport, provide one more STREAM_TRANSPORTS entry:
 * nothing that consumes the stream changes.
 */
export interface TransportDefinition {
  readonly kind: string;
  /** Text for the status indicator while this transport is live. */
  readonly label: string;
  /** Does the server send pings on it (so silence means dead)? Polling does not. */
  readonly heartbeat: boolean;
  create(handlers: TransportHandlers): StreamTransport;
}

/** Multi-provider, in priority order: the first one is the preferred transport. */
export const STREAM_TRANSPORTS = new InjectionToken<TransportDefinition[]>('STREAM_TRANSPORTS');
