import { AppConfig } from '../config/app-config';
import { backoffDelayMs } from './backoff';
import { MetricsSnapshot } from './stream.models';
import {
  CloseReason,
  StreamTransport,
  TransportDefinition,
  TransportHandlers,
} from './transports/stream-transport';

export type ConnectionState =
  | { readonly status: 'stopped' }
  | { readonly status: 'connecting'; readonly transport: string }
  | { readonly status: 'live'; readonly transport: string }
  | { readonly status: 'reconnecting'; readonly transport: string; readonly retryAt: number }
  | { readonly status: 'offline' };

export interface ConnectionEvents {
  frame(raw: string): void;
  snapshot(snapshot: MetricsSnapshot): void;
  /** A transport just became live (first connect, reconnect, or climb back). */
  connected(transport: string): void;
  state(state: ConnectionState): void;
  /** The server said the token is no longer valid. Resolve true if a refresh worked. */
  unauthorized(): Promise<boolean>;
}

export interface ConnectionManagerOptions {
  readonly config: AppConfig['stream'];
  readonly transports: readonly TransportDefinition[];
  readonly events: ConnectionEvents;
  readonly random?: () => number;
  readonly now?: () => number;
}

interface Attempt {
  readonly id: number;
  readonly index: number;
  readonly transport: StreamTransport;
  opened: boolean;
  connectTimer: ReturnType<typeof setTimeout> | null;
}

type Failure = CloseReason | 'timeout';

/**
 * The transport state machine. It knows nothing about metrics: it only decides which transport to use and when.
 *
 * - tries transports in priority order; 3 failures in a row (or a connect timeout) fall back to the next one;
 * - waits an exponentially growing, jittered delay between attempts on the same transport;
 * - while on a lower transport, probes the higher ones every `climbBackIntervalMs` and moves up when one opens;
 * - treats silence for `missedPingsLimit` ping intervals as a dead connection, even if the socket looks open;
 * - does not reconnect while the browser is offline, and reconnects at once when it is back.
 */
export class ConnectionManager {
  private readonly cfg: AppConfig['stream'];
  private readonly random: () => number;
  private readonly now: () => number;

  private running = false;
  private online = true;
  private epoch = 0; // bumps on stop/offline so late async results are ignored
  private nextId = 1;
  private index = 0;
  private failures = 0;
  private unauthorizedRetries = 0;
  private current: Attempt | null = null;
  private probe: Attempt | null = null;
  private lastFrameAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private climbTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: ConnectionManagerOptions) {
    this.cfg = opts.config;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  start(online = true): void {
    this.teardown();
    this.running = true;
    this.online = online;
    this.index = 0;
    this.failures = 0;
    this.unauthorizedRetries = 0;
    if (online) this.connect();
    else this.emit({ status: 'offline' });
  }

  stop(): void {
    this.teardown();
    this.running = false;
    this.emit({ status: 'stopped' });
  }

  setOnline(online: boolean): void {
    if (online === this.online) return;
    this.online = online;
    if (!this.running) return;
    if (!online) {
      this.teardown();
      this.emit({ status: 'offline' });
    } else {
      this.index = 0;
      this.failures = 0;
      this.connect();
    }
  }

  // ---------------------------------------------------------------- connecting

  private connect(): void {
    this.clearRetry();
    const attempt = this.createAttempt(this.index);
    this.current = attempt;
    this.emit({ status: 'connecting', transport: this.kindOf(this.index) });
    attempt.transport.connect();
  }

  private createAttempt(index: number): Attempt {
    const id = this.nextId++;
    const handlers: TransportHandlers = {
      opened: () => this.onOpened(id),
      frame: (raw) => this.onFrame(id, raw),
      snapshot: (snapshot) => this.onSnapshot(id, snapshot),
      closed: (reason) => this.onClosed(id, reason),
    };
    const attempt: Attempt = {
      id,
      index,
      transport: this.opts.transports[index].create(handlers),
      opened: false,
      connectTimer: setTimeout(() => this.onConnectTimeout(id), this.cfg.connectTimeoutMs),
    };
    return attempt;
  }

  private onOpened(id: number): void {
    if (this.probe?.id === id) return this.promoteProbe();
    const attempt = this.current;
    if (!attempt || attempt.id !== id || attempt.opened) return;
    this.markLive(attempt);
  }

  private markLive(attempt: Attempt): void {
    attempt.opened = true;
    if (attempt.connectTimer) clearTimeout(attempt.connectTimer);
    attempt.connectTimer = null;
    this.failures = 0; // a successful connection resets the backoff
    this.unauthorizedRetries = 0;
    this.lastFrameAt = this.now();
    this.emit({ status: 'live', transport: this.kindOf(attempt.index) });
    this.startHeartbeat();
    this.scheduleClimb();
    this.opts.events.connected(this.kindOf(attempt.index));
  }

  private onFrame(id: number, raw: string): void {
    if (this.current?.id !== id) return;
    this.lastFrameAt = this.now();
    this.opts.events.frame(raw);
  }

  private onSnapshot(id: number, snapshot: MetricsSnapshot): void {
    if (this.current?.id !== id) return;
    this.lastFrameAt = this.now();
    this.opts.events.snapshot(snapshot);
  }

  private onClosed(id: number, reason: CloseReason): void {
    if (this.current?.id === id) this.fail(reason);
    else if (this.probe?.id === id) this.probeFailed();
  }

  private onConnectTimeout(id: number): void {
    if (this.current?.id === id && !this.current.opened) this.fail('timeout');
    else if (this.probe?.id === id && !this.probe.opened) this.probeFailed();
  }

  // ---------------------------------------------------------------- failing and falling back

  private fail(reason: Failure): void {
    this.dropCurrent();
    const epoch = this.epoch;

    if (reason === 'unauthorized' && this.unauthorizedRetries < 1) {
      // refresh the token and try the same transport again; this is not counted as a transport failure
      this.unauthorizedRetries++;
      this.emit({ status: 'connecting', transport: this.kindOf(this.index) });
      void this.opts.events.unauthorized().then((refreshed) => {
        if (epoch !== this.epoch || !this.running || !this.online) return;
        if (refreshed) this.connect();
        else this.registerFailure('error');
      });
      return;
    }
    this.registerFailure(reason);
  }

  private registerFailure(reason: Failure): void {
    this.failures++;
    const isLast = this.index >= this.opts.transports.length - 1;
    // a transport that never connected within the timeout is given up on right away
    if ((reason === 'timeout' || this.failures >= this.cfg.failuresBeforeFallback) && !isLast) {
      this.index++;
      this.failures = 0;
      this.connect();
      return;
    }
    const delay = backoffDelayMs(this.failures, this.cfg.backoff, this.random);
    this.emit({
      status: 'reconnecting',
      transport: this.kindOf(this.index),
      retryAt: this.now() + delay,
    });
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  // ---------------------------------------------------------------- heartbeat

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (!this.opts.transports[this.index].heartbeat) return;
    const deadAfterMs =
      this.cfg.pingIntervalMs * this.cfg.missedPingsLimit + this.cfg.heartbeatGraceMs;
    // one cheap check per second instead of re-arming a timer for every frame (up to 2,000 a second)
    this.heartbeatTimer = setInterval(() => {
      if (this.now() - this.lastFrameAt > deadAfterMs) this.fail('error');
    }, 1000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // ---------------------------------------------------------------- climbing back up

  private scheduleClimb(): void {
    if (this.index === 0 || this.climbTimer || this.probe) return;
    this.climbTimer = setTimeout(() => {
      this.climbTimer = null;
      this.probeFrom(0);
    }, this.cfg.climbBackIntervalMs);
  }

  private probeFrom(candidate: number): void {
    if (!this.running || !this.online || candidate >= this.index) return this.scheduleClimb();
    const attempt = this.createAttempt(candidate);
    this.probe = attempt;
    attempt.transport.connect();
  }

  private probeFailed(): void {
    const failed = this.probe;
    if (!failed) return;
    this.discard(failed);
    this.probe = null;
    this.probeFrom(failed.index + 1);
  }

  private promoteProbe(): void {
    const probe = this.probe;
    if (!probe) return;
    this.probe = null;
    this.dropCurrent();
    this.current = probe;
    this.index = probe.index;
    this.markLive(probe);
  }

  // ---------------------------------------------------------------- cleanup

  private discard(attempt: Attempt): void {
    if (attempt.connectTimer) clearTimeout(attempt.connectTimer);
    attempt.connectTimer = null;
    attempt.transport.close();
  }

  /** Stops the active transport and everything tied to it (heartbeat, climb timer, probe). */
  private dropCurrent(): void {
    this.stopHeartbeat();
    if (this.climbTimer) clearTimeout(this.climbTimer);
    this.climbTimer = null;
    if (this.probe) this.discard(this.probe);
    this.probe = null;
    if (this.current) this.discard(this.current);
    this.current = null;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private teardown(): void {
    this.epoch++;
    this.clearRetry();
    this.dropCurrent();
  }

  private kindOf(index: number): string {
    return this.opts.transports[index].kind;
  }

  private emit(state: ConnectionState): void {
    this.opts.events.state(state);
  }
}
