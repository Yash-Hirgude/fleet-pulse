import { Injectable, computed, inject, signal } from '@angular/core';
import { Subject, Subscription, firstValueFrom, forkJoin, takeUntil } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { APP_CONFIG } from '../config/app-config';
import { ApiClient } from '../http/api-client';
import { errorCodeOf } from '../http/api-error';
import { ConnectionManager, ConnectionState } from './connection-manager';
import { MetricsStore } from './metrics-store';
import { Sequencer } from './sequencer';
import { parseFrame } from './stream-parser';
import { MetricsSnapshot, ReplayResponse, ServiceInfo } from './stream.models';
import { STREAM_TRANSPORTS } from './transports/stream-transport';

export interface StreamStats {
  received: number;
  applied: number;
  duplicates: number;
  reordered: number;
  malformed: number;
  gapsDetected: number;
  replays: number;
  snapshotReloads: number;
  reconnects: number;
  transportSwitches: number;
  overflows: number;
  staleSeq: number;
  seqGaps: number;
}

const EMPTY_STATS: StreamStats = {
  received: 0, applied: 0, duplicates: 0, reordered: 0, malformed: 0, gapsDetected: 0, replays: 0,
  snapshotReloads: 0, reconnects: 0, transportSwitches: 0, overflows: 0, staleSeq: 0, seqGaps: 0,
};

export type InitialLoad = 'idle' | 'loading' | 'ready' | 'error';

/**
 * The live pipeline, socket to screen:
 *
 *   transport -> ConnectionManager -> parseFrame -> Sequencer -> MetricsStore -> row signals -> table
 *                  (which transport)   (malformed)   (order, dupes, gaps)  (latest per service, flushed 4x/s)
 *
 * Gaps are filled from /metrics/replay; if the server says replay_too_old the whole snapshot is reloaded.
 * Components only see signals; they never know which transport is active.
 */
@Injectable({ providedIn: 'root' })
export class StreamService {
  private readonly cfg = inject(APP_CONFIG);
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly definitions = inject(STREAM_TRANSPORTS);
  readonly store = inject(MetricsStore);

  readonly connection = signal<ConnectionState>({ status: 'stopped' });
  readonly initialLoad = signal<InitialLoad>('idle');
  readonly stats = signal<StreamStats>(EMPTY_STATS);
  /** Ticks once a second so "reconnecting in 4 s" and "last event 42 s ago" stay current. */
  readonly now = signal(Date.now());
  readonly lastEventAt = signal(0);

  /** No data event for longer than `freshness.staleAfterMs`: everything on screen must be marked stale. */
  readonly isStale = computed(
    () => this.lastEventAt() > 0 && this.now() - this.lastEventAt() > this.cfg.freshness.staleAfterMs,
  );
  readonly staleForSeconds = computed(() => Math.floor((this.now() - this.lastEventAt()) / 1000));

  private manager: ConnectionManager | null = null;
  private sequencer: Sequencer | null = null;
  private stopped$ = new Subject<void>();
  private sessionSub: Subscription | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private cleanup: (() => void)[] = [];

  private malformed = 0;
  private gapsDetected = 0;
  private replays = 0;
  private snapshotReloads = 0;
  private reconnects = 0;
  private transportSwitches = 0;
  private lastKind: string | null = null;
  private connectedBefore = false;
  private recovering = false; // a replay or snapshot reload is in flight
  private cooldownUntil = 0;

  start(): void {
    if (this.manager) return;
    this.stopped$ = new Subject<void>();
    const { stream } = this.cfg;

    this.sequencer = new Sequencer(
      {
        reorderWindowMs: stream.reorderWindowMs,
        maxBuffered: stream.maxBufferedEvents,
        now: Date.now,
        onOverflow: () => this.reloadSnapshot(),
      },
      (event) => this.store.apply(event),
    );

    this.manager = new ConnectionManager({
      config: stream,
      transports: this.definitions,
      events: {
        frame: (raw) => this.onFrame(raw),
        snapshot: (snapshot) => this.onPolledSnapshot(snapshot),
        connected: (kind) => this.onConnected(kind),
        state: (state) => this.connection.set(state),
        unauthorized: () => firstValueFrom(this.auth.refresh()).then(() => true, () => false),
      },
    });

    this.timers = [
      setInterval(() => this.flush(), this.cfg.ui.flushIntervalMs),
      setInterval(() => this.checkGap(), stream.gapCheckIntervalMs),
      setInterval(() => this.now.set(Date.now()), 1000),
    ];
    this.sessionSub = this.auth.sessionEnded$.subscribe(() => this.stop());

    const online = () => this.manager?.setOnline(true);
    const offline = () => this.manager?.setOnline(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    this.cleanup = [
      () => window.removeEventListener('online', online),
      () => window.removeEventListener('offline', offline),
    ];

    this.loadInitial();
    this.manager.start(navigator.onLine);
  }

  stop(): void {
    if (!this.manager) return;
    this.manager.stop();
    this.manager = null;
    this.sequencer = null;
    this.stopped$.next();
    this.stopped$.complete();
    this.sessionSub?.unsubscribe();
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
    this.cleanup.forEach((fn) => fn());
    this.cleanup = [];
    this.store.clear();
    this.initialLoad.set('idle');
    this.lastEventAt.set(0);
    this.stats.set(EMPTY_STATS);
    this.malformed = this.gapsDetected = this.replays = this.snapshotReloads = this.reconnects = this.transportSwitches = 0;
    this.lastKind = null;
    this.connectedBefore = false;
    this.recovering = false;
    this.cooldownUntil = 0;
  }

  transportLabel(kind: string): string {
    return this.definitions.find((d) => d.kind === kind)?.label ?? kind;
  }

  retryInitialLoad(): void {
    if (this.manager) this.loadInitial();
  }

  // ---------------------------------------------------------------- startup

  private loadInitial(): void {
    this.initialLoad.set('loading');
    forkJoin({
      services: this.api.get<ServiceInfo[]>('/services'),
      snapshot: this.api.get<MetricsSnapshot>('/metrics/snapshot'),
    })
      .pipe(takeUntil(this.stopped$))
      .subscribe({
        next: ({ services, snapshot }) => {
          this.store.init(services, snapshot);
          this.sequencer?.baseline(snapshot.offset); // frames that arrived meanwhile are drained here
          this.lastEventAt.set(Date.now());
          this.initialLoad.set('ready');
        },
        error: () => this.initialLoad.set('error'),
      });
  }

  // ---------------------------------------------------------------- frames

  private onFrame(raw: string): void {
    const parsed = parseFrame(raw);
    if (parsed.kind === 'metric') this.sequencer?.push(parsed.event);
    else if (parsed.kind === 'malformed') {
      this.malformed++;
      if (this.malformed === 1 || this.malformed % 100 === 0) {
        console.warn(`[stream] malformed frame #${this.malformed}: ${parsed.reason}`);
      }
    }
  }

  /** Polling delivers whole snapshots. Newer values go to the store; the sequencer is moved past them. */
  private onPolledSnapshot(snapshot: MetricsSnapshot): void {
    if (this.initialLoad() !== 'ready') return;
    this.store.applySnapshot(snapshot);
    if (snapshot.offset > (this.sequencer?.lastAppliedOffset ?? -1)) this.sequencer?.baseline(snapshot.offset);
  }

  private onConnected(kind: string): void {
    if (this.lastKind && this.lastKind !== kind) this.transportSwitches++;
    this.lastKind = kind;
    if (this.connectedBefore) {
      this.reconnects++;
      this.requestReplay(); // whatever was missed while disconnected
    }
    this.connectedBefore = true;
  }

  // ---------------------------------------------------------------- recovery

  private checkGap(): void {
    if (this.recovering || Date.now() < this.cooldownUntil || !this.sequencer?.hasGap()) return;
    this.gapsDetected++;
    this.requestReplay();
  }

  private requestReplay(): void {
    const since = this.sequencer?.lastAppliedOffset;
    if (since === null || since === undefined || this.recovering) return;
    this.recovering = true;
    this.api
      .get<ReplayResponse>('/metrics/replay', { since })
      .pipe(takeUntil(this.stopped$))
      .subscribe({
        next: (res) => {
          this.sequencer?.applyReplay(res.events);
          this.replays++;
          this.recovering = false;
        },
        error: (err: unknown) => {
          if (errorCodeOf(err) === 'replay_too_old') return this.reloadSnapshot();
          this.recovering = false;
          this.cooldownUntil = Date.now() + this.cfg.stream.replayCooldownMs;
        },
      });
  }

  /** The gap is too old to replay (or the buffer overflowed): start over from a full snapshot. */
  private reloadSnapshot(): void {
    this.recovering = true;
    this.api
      .get<MetricsSnapshot>('/metrics/snapshot')
      .pipe(takeUntil(this.stopped$))
      .subscribe({
        next: (snapshot) => {
          this.store.applySnapshot(snapshot);
          this.sequencer?.baseline(snapshot.offset);
          this.store.markResynced();
          this.snapshotReloads++;
          this.recovering = false;
        },
        error: () => {
          this.recovering = false;
          this.cooldownUntil = Date.now() + this.cfg.stream.replayCooldownMs;
        },
      });
  }

  // ---------------------------------------------------------------- publishing

  private flush(): void {
    if (this.store.flush() > 0) this.lastEventAt.set(Date.now());
    const seq = this.sequencer?.stats;
    const next: StreamStats = {
      received: seq?.received ?? 0,
      applied: seq?.applied ?? 0,
      duplicates: seq?.duplicates ?? 0,
      reordered: seq?.reordered ?? 0,
      overflows: seq?.overflows ?? 0,
      malformed: this.malformed,
      gapsDetected: this.gapsDetected,
      replays: this.replays,
      snapshotReloads: this.snapshotReloads,
      reconnects: this.reconnects,
      transportSwitches: this.transportSwitches,
      staleSeq: this.store.counters.staleSeq,
      seqGaps: this.store.counters.seqGaps,
    };
    const prev = this.stats();
    if ((Object.keys(next) as (keyof StreamStats)[]).some((k) => next[k] !== prev[k])) this.stats.set(next);
  }
}