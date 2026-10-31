import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config';
import { ApiClient } from '../../core/http/api-client';
import { MetricsStore } from '../../core/stream/metrics-store';
import { MetricEvent, ServiceInfo } from '../../core/stream/stream.models';
import { SeriesSession } from './series-session';

const BASE = DEFAULT_APP_CONFIG.api.baseUrl;
const UI = DEFAULT_APP_CONFIG.ui;
const services: ServiceInfo[] = [
  { id: 'svc-0001', name: 'a', team: 't', status: 'healthy' },
  { id: 'svc-0002', name: 'b', team: 't', status: 'healthy' },
];
const T0 = 1_700_000_000_000;
const point = (i: number) => ({ ts: T0 + i * 1000, p95: 100, errRate: 1, rps: 500 });
const history = (serviceId: string, count = 900) => ({
  serviceId,
  points: Array.from({ length: count }, (_, i) => point(i)),
});
const live = (serviceId: string, seq: number, ts: number, p95: number): MetricEvent => ({
  type: 'metric',
  offset: seq,
  serviceId,
  seq,
  ts,
  p95,
  errRate: 1,
  rps: 500,
  status: 'healthy',
});

describe('SeriesSession', () => {
  let store: MetricsStore;
  let ctrl: HttpTestingController;
  let api: ApiClient;
  const url = (id: string) => `${BASE}/metrics/history?serviceId=${id}&minutes=15`;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    store = TestBed.inject(MetricsStore);
    ctrl = TestBed.inject(HttpTestingController);
    api = TestBed.inject(ApiClient);
    store.init(services, { offset: 0, ts: 0, metrics: [] });
  });

  it('loads 15 minutes of history, reduced to 300 points, then keeps extending with live points', () => {
    const s = new SeriesSession('svc-0001', api, store, UI);
    s.start();
    expect(s.state()).toBe('loading');
    ctrl.expectOne(url('svc-0001')).flush(history('svc-0001'));
    expect(s.state()).toBe('ready');
    expect(s.points()).toHaveLength(300);

    store.apply(live('svc-0001', 1, T0 + 900_000 + 3000, 777));
    const last = s.points()[s.points().length - 1];
    expect(last.p95).toBe(777);
    expect(s.points().length).toBeLessThanOrEqual(300);
  });

  it('merges live points that arrive before the history', () => {
    const s = new SeriesSession('svc-0001', api, store, UI);
    s.start();
    store.apply(live('svc-0001', 1, T0 + 899_000, 555)); // before the history response
    ctrl.expectOne(url('svc-0001')).flush(history('svc-0001'));
    expect(s.points()).toHaveLength(300);
    expect(Math.max(...s.points().map((p) => p.p95))).toBe(555);
  });

  it('ignores live events of other services', () => {
    const s = new SeriesSession('svc-0001', api, store, UI);
    s.start();
    ctrl.expectOne(url('svc-0001')).flush(history('svc-0001', 3));
    const before = s.points().length;
    store.apply(live('svc-0002', 1, T0 + 500_000, 999));
    expect(s.points()).toHaveLength(before);
    expect(Math.max(...s.points().map((p) => p.p95))).toBe(100);
  });

  it('refuses a history response that is about another service', () => {
    const s = new SeriesSession('svc-0001', api, store, UI);
    s.start();
    ctrl.expectOne(url('svc-0001')).flush(history('svc-0002'));
    expect(s.state()).toBe('error');
    expect(s.points()).toEqual([]);
  });

  it('dispose() cancels the request in flight and stops listening', () => {
    const s = new SeriesSession('svc-0001', api, store, UI);
    s.start();
    const req = ctrl.expectOne(url('svc-0001'));
    s.dispose();
    expect(req.cancelled).toBe(true);
    store.apply(live('svc-0001', 1, T0, 1));
    expect(s.points()).toEqual([]);
  });

  it('shows an error state when the history request fails, and Retry loads it again', () => {
    const s = new SeriesSession('svc-0001', api, store, UI);
    s.start();
    ctrl
      .expectOne(url('svc-0001'))
      .flush(
        { error: { code: 'not_found', message: 'nope', details: [] } },
        { status: 404, statusText: 'Not Found' },
      );
    expect(s.state()).toBe('error');
    expect(s.errorMessage()).toBe('nope');

    s.loadHistory();
    ctrl.expectOne(url('svc-0001')).flush(history('svc-0001', 30));
    expect(s.state()).toBe('ready');
  });
});
