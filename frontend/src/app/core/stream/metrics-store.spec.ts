import { MetricsStore } from './metrics-store';
import { MetricEvent, MetricsSnapshot, ServiceInfo } from './stream.models';

const services: ServiceInfo[] = [
  { id: 'svc-0001', name: 'payments-api', team: 'payments', status: 'healthy' },
  { id: 'svc-0002', name: 'auth-cache', team: 'auth', status: 'healthy' },
];
const ev = (serviceId: string, seq: number, over: Partial<MetricEvent> = {}): MetricEvent => ({
  type: 'metric', offset: seq, serviceId, seq, ts: seq, p95: 100, errRate: 0.5, rps: 10, status: 'healthy', ...over,
});
const snapshot: MetricsSnapshot = { offset: 10, ts: 0, metrics: [ev('svc-0001', 5), ev('svc-0002', 7)] };

describe('MetricsStore', () => {
  let store: MetricsStore;
  beforeEach(() => {
    store = new MetricsStore();
    store.init(services, snapshot);
  });

  it('starts from the snapshot', () => {
    expect(store.rows).toHaveLength(2);
    expect(store.row('svc-0001')?.metrics().p95).toBe(100);
  });

  it('publishes only the latest value per service on flush', () => {
    store.apply(ev('svc-0001', 6, { p95: 200 }));
    store.apply(ev('svc-0001', 7, { p95: 300 }));
    expect(store.row('svc-0001')?.metrics().p95).toBe(100); // not yet flushed
    expect(store.flush()).toBe(1);
    expect(store.row('svc-0001')?.metrics().p95).toBe(300);
    expect(store.flush()).toBe(0);
  });

  it('counts status changes so the table can flash the cell', () => {
    store.apply(ev('svc-0001', 6, { status: 'degraded' }));
    store.flush();
    store.apply(ev('svc-0001', 7, { status: 'degraded', p95: 5 }));
    store.flush();
    expect(store.row('svc-0001')?.metrics().statusChanges).toBe(1);
    store.apply(ev('svc-0001', 8, { status: 'down' }));
    store.flush();
    expect(store.row('svc-0001')?.metrics().statusChanges).toBe(2);
  });

  it('ignores an event whose per-service seq is not newer, and counts a seq jump', () => {
    store.apply(ev('svc-0001', 5)); // same seq as the snapshot
    store.apply(ev('svc-0001', 4));
    expect(store.counters.staleSeq).toBe(2);
    store.apply(ev('svc-0001', 9)); // 6, 7, 8 are missing
    expect(store.counters.seqGaps).toBe(1);
  });

  it('applies only newer values from a later snapshot', () => {
    store.applySnapshot({ offset: 20, ts: 0, metrics: [ev('svc-0001', 5, { p95: 1 }), ev('svc-0002', 12, { p95: 999 })] });
    store.flush();
    expect(store.row('svc-0001')?.metrics().p95).toBe(100);
    expect(store.row('svc-0002')?.metrics().p95).toBe(999);
  });

  it('notifies listeners of every applied event in order', () => {
    const seen: number[] = [];
    store.onEvent((e) => seen.push(e.seq));
    store.apply(ev('svc-0001', 6));
    store.apply(ev('svc-0001', 7));
    expect(seen).toEqual([6, 7]);
  });
});