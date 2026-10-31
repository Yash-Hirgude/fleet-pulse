import { Injectable, signal } from '@angular/core';
import { MetricEvent, MetricStatus, MetricsSnapshot, ServiceInfo } from './stream.models';

export interface ServiceMetrics {
  readonly p95: number;
  readonly errRate: number;
  readonly rps: number;
  readonly status: MetricStatus;
  readonly ts: number;
  /** Counts status changes; the table uses it to restart the flash animation. */
  readonly statusChanges: number;
}

/** One service. `metrics` is a signal so that only the row that changed re-renders. */
export class ServiceRow {
  readonly metrics;
  readonly searchKey: string;
  readonly nameKey: string;
  lastSeq = 0;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly team: string,
    initial: ServiceMetrics,
  ) {
    this.metrics = signal(initial);
    this.searchKey = `${id} ${name} ${team}`.toLowerCase();
    this.nameKey = name.toLowerCase();
  }
}

export interface StoreCounters {
  /** Events skipped because the service had already moved past their `seq`. */
  staleSeq: number;
  /** A service's `seq` jumped by more than 1 (an event of that service was lost). */
  seqGaps: number;
  unknownService: number;
}

export type MetricListener = (event: MetricEvent) => void;

const EMPTY: ServiceMetrics = {
  p95: 0,
  errRate: 0,
  rps: 0,
  status: 'healthy',
  ts: 0,
  statusChanges: 0,
};

/**
 * Latest metrics per service. The stream writes into `pending` for every event; `flush()` publishes the latest
 * value per service to the row signals a few times a second, so 2,000 events/s become at most one signal write
 * per changed service per flush.
 */
@Injectable({ providedIn: 'root' })
export class MetricsStore {
  rows: readonly ServiceRow[] = [];
  /** Bumps on every flush that changed something and on every (re)load. */
  readonly version = signal(0);
  /** Bumps when the data was reloaded from a snapshot, so views (charts) know their history has a hole. */
  readonly resyncs = signal(0);
  readonly counters: StoreCounters = { staleSeq: 0, seqGaps: 0, unknownService: 0 };

  private byId = new Map<string, ServiceRow>();
  private pending = new Map<string, MetricEvent>();
  private readonly listeners = new Set<MetricListener>();

  row(id: string): ServiceRow | undefined {
    return this.byId.get(id);
  }

  /** Every event, in order, as it is applied. Rule evaluation and charts subscribe here. */
  onEvent(listener: MetricListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  init(services: readonly ServiceInfo[], snapshot: MetricsSnapshot): void {
    const latest = new Map(snapshot.metrics.map((m) => [m.serviceId, m]));
    this.pending.clear();
    this.rows = services.map((s) => {
      const m = latest.get(s.id);
      const row = new ServiceRow(
        s.id,
        s.name,
        s.team,
        m ? toMetrics(m, 0) : { ...EMPTY, status: s.status },
      );
      row.lastSeq = m?.seq ?? 0;
      return row;
    });
    this.byId = new Map(this.rows.map((r) => [r.id, r]));
    this.version.update((v) => v + 1);
  }

  /** Newer-than-known values from a snapshot (polling, or a reload after replay_too_old). */
  applySnapshot(snapshot: MetricsSnapshot): void {
    for (const m of snapshot.metrics) {
      const row = this.byId.get(m.serviceId);
      if (row && m.seq > row.lastSeq) {
        row.lastSeq = m.seq; // jump: the events in between are covered by the snapshot
        this.pending.set(m.serviceId, m);
        this.listeners.forEach((l) => l(m));
      }
    }
  }

  /** Called by the sequencer, one event at a time, in offset order. */
  apply(event: MetricEvent): void {
    const row = this.byId.get(event.serviceId);
    if (!row) {
      this.counters.unknownService++;
      return;
    }
    if (event.seq <= row.lastSeq) {
      this.counters.staleSeq++;
      return;
    }
    if (row.lastSeq > 0 && event.seq > row.lastSeq + 1) this.counters.seqGaps++;
    row.lastSeq = event.seq;
    this.pending.set(event.serviceId, event);
    this.listeners.forEach((l) => l(event));
  }

  /** Publishes the latest pending value of every changed service. Returns how many rows changed. */
  flush(): number {
    const changed = this.pending.size;
    if (changed === 0) return 0;
    for (const [id, event] of this.pending) {
      const row = this.byId.get(id);
      row?.metrics.update((prev) =>
        toMetrics(
          event,
          prev.status !== event.status ? prev.statusChanges + 1 : prev.statusChanges,
        ),
      );
    }
    this.pending.clear();
    this.version.update((v) => v + 1);
    return changed;
  }

  markResynced(): void {
    this.resyncs.update((v) => v + 1);
  }

  clear(): void {
    this.rows = [];
    this.byId.clear();
    this.pending.clear();
    this.version.update((v) => v + 1);
  }
}

function toMetrics(e: MetricEvent, statusChanges: number): ServiceMetrics {
  return { p95: e.p95, errRate: e.errRate, rps: e.rps, status: e.status, ts: e.ts, statusChanges };
}
