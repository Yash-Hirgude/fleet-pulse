import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DEFAULT_APP_CONFIG } from '../config/app-config';
import { MetricEvent, MetricsSnapshot, ServiceInfo } from './stream.models';
import { StreamService } from './stream.service';
import {
  STREAM_TRANSPORTS,
  StreamTransport,
  TransportHandlers,
} from './transports/stream-transport';

const BASE = DEFAULT_APP_CONFIG.api.baseUrl;
const services: ServiceInfo[] = [
  { id: 'svc-0001', name: 'payments-api', team: 'payments', status: 'healthy' },
  { id: 'svc-0002', name: 'auth-cache', team: 'auth', status: 'healthy' },
];
const ev = (
  offset: number,
  serviceId: string,
  seq: number,
  over: Partial<MetricEvent> = {},
): MetricEvent => ({
  type: 'metric',
  offset,
  serviceId,
  seq,
  ts: offset,
  p95: 100,
  errRate: 0.5,
  rps: 10,
  status: 'healthy',
  ...over,
});
const frame = (e: MetricEvent) => JSON.stringify(e);
const snapshotAt = (offset: number, metrics: MetricEvent[]): MetricsSnapshot => ({
  offset,
  ts: 0,
  metrics,
});

class FakeTransport implements StreamTransport {
  constructor(readonly h: TransportHandlers) {}
  connect() {
    /* the tests drive the handlers by hand */
  }
  close() {
    /* nothing to release */
  }
}

describe('StreamService', () => {
  let stream: StreamService;
  let ctrl: HttpTestingController;
  let transports: FakeTransport[];

  const flush = () => vi.advanceTimersByTimeAsync(DEFAULT_APP_CONFIG.ui.flushIntervalMs);
  const live = () => transports[transports.length - 1];

  function loadInitial() {
    ctrl.expectOne(`${BASE}/services`).flush(services);
    ctrl
      .expectOne(`${BASE}/metrics/snapshot`)
      .flush(snapshotAt(10, [ev(9, 'svc-0001', 5), ev(10, 'svc-0002', 7)]));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    transports = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: STREAM_TRANSPORTS,
          multi: true,
          useValue: {
            kind: 'websocket',
            label: 'Live (WebSocket)',
            heartbeat: true,
            create: (h: TransportHandlers) => {
              const t = new FakeTransport(h);
              transports.push(t);
              return t;
            },
          },
        },
      ],
    });
    stream = TestBed.inject(StreamService);
    ctrl = TestBed.inject(HttpTestingController);
    stream.start();
  });

  afterEach(() => {
    stream.stop();
    vi.useRealTimers();
  });

  it('loads services and snapshot, then shows live events in the table store', async () => {
    expect(stream.initialLoad()).toBe('loading');
    loadInitial();
    expect(stream.initialLoad()).toBe('ready');
    live().h.opened();
    live().h.frame(frame(ev(11, 'svc-0001', 6, { p95: 321 })));
    await flush();
    expect(stream.store.row('svc-0001')?.metrics().p95).toBe(321);
    expect(stream.connection()).toEqual({ status: 'live', transport: 'websocket' });
  });

  it('keeps frames that arrive before the snapshot and applies only the newer ones', async () => {
    live().h.opened();
    live().h.frame(frame(ev(9, 'svc-0001', 5))); // older than the snapshot
    live().h.frame(frame(ev(11, 'svc-0001', 6, { p95: 777 })));
    loadInitial();
    await flush();
    expect(stream.store.row('svc-0001')?.metrics().p95).toBe(777);
    expect(stream.stats().applied).toBe(1);
  });

  it('counts malformed frames and keeps going', async () => {
    loadInitial();
    live().h.opened();
    live().h.frame('{"type":"metric","offset":');
    live().h.frame(JSON.stringify({ type: 'metric', offset: 11 }));
    live().h.frame(frame(ev(11, 'svc-0001', 6)));
    await flush();
    expect(stream.stats().malformed).toBe(2);
    expect(stream.stats().applied).toBe(1);
  });

  it('fills a gap from /metrics/replay once the missing event is overdue', async () => {
    loadInitial();
    live().h.opened();
    live().h.frame(frame(ev(11, 'svc-0001', 6)));
    live().h.frame(frame(ev(13, 'svc-0001', 8, { p95: 888 }))); // 12 was dropped
    await vi.advanceTimersByTimeAsync(500);
    ctrl.expectNone(`${BASE}/metrics/replay?since=11`);

    await vi.advanceTimersByTimeAsync(1000);
    const replay = ctrl.expectOne(`${BASE}/metrics/replay?since=11`);
    replay.flush({
      events: [ev(12, 'svc-0001', 7), ev(13, 'svc-0001', 8, { p95: 888 })],
      offset: 13,
    });
    await flush();

    expect(stream.stats().gapsDetected).toBe(1);
    expect(stream.stats().replays).toBe(1);
    expect(stream.store.counters.seqGaps).toBe(0); // nothing was lost for good
    expect(stream.store.row('svc-0001')?.metrics().p95).toBe(888);
  });

  it('replays what it missed after a reconnect', async () => {
    loadInitial();
    live().h.opened();
    live().h.frame(frame(ev(11, 'svc-0001', 6)));
    live().h.closed('closed'); // connection drops
    await vi.advanceTimersByTimeAsync(2000);
    live().h.opened(); // and comes back

    const replay = ctrl.expectOne(`${BASE}/metrics/replay?since=11`);
    replay.flush({ events: [ev(12, 'svc-0002', 8, { rps: 99 })], offset: 12 });
    await flush();
    expect(stream.store.row('svc-0002')?.metrics().rps).toBe(99);
    expect(stream.stats().reconnects).toBe(1);
  });

  it('reloads the full snapshot when replay answers 410, and tells views their history has a hole', async () => {
    loadInitial();
    live().h.opened();
    live().h.closed('closed');
    await vi.advanceTimersByTimeAsync(2000);
    live().h.opened();

    ctrl
      .expectOne(`${BASE}/metrics/replay?since=10`)
      .flush(
        { error: { code: 'replay_too_old', message: 'too old', details: [] } },
        { status: 410, statusText: 'Gone' },
      );
    ctrl
      .expectOne(`${BASE}/metrics/snapshot`)
      .flush(snapshotAt(5000, [ev(5000, 'svc-0001', 400, { p95: 4242 })]));
    await flush();

    expect(stream.stats().snapshotReloads).toBe(1);
    expect(stream.store.resyncs()).toBe(1);
    expect(stream.store.row('svc-0001')?.metrics().p95).toBe(4242);

    // live events continue seamlessly after the new baseline
    live().h.frame(frame(ev(5001, 'svc-0001', 401, { p95: 1 })));
    await flush();
    expect(stream.store.row('svc-0001')?.metrics().p95).toBe(1);
  });

  it('marks data stale when no event arrives for more than 10 s', async () => {
    loadInitial();
    live().h.opened();
    await vi.advanceTimersByTimeAsync(9000);
    live().h.frame('{"type":"ping","ts":1}'); // pings keep the connection alive but are not data
    expect(stream.isStale()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(stream.isStale()).toBe(true);
    live().h.frame(frame(ev(11, 'svc-0001', 6)));
    await vi.advanceTimersByTimeAsync(DEFAULT_APP_CONFIG.ui.flushIntervalMs + 1000);
    expect(stream.isStale()).toBe(false);
  });

  it('shows an error state and can retry when the initial load fails', () => {
    ctrl.expectOne(`${BASE}/services`).flush('x', { status: 400, statusText: 'Bad' });
    ctrl.match(`${BASE}/metrics/snapshot`);
    expect(stream.initialLoad()).toBe('error');
    stream.retryInitialLoad();
    expect(stream.initialLoad()).toBe('loading');
    ctrl.match(() => true);
  });
});
