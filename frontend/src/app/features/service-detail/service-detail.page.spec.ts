import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config';
import { MetricsStore } from '../../core/stream/metrics-store';
import { ServiceInfo } from '../../core/stream/stream.models';
import { StreamService } from '../../core/stream/stream.service';
import { STREAM_TRANSPORTS } from '../../core/stream/transports/stream-transport';
import { ServiceDetailPage } from './service-detail.page';

const BASE = DEFAULT_APP_CONFIG.api.baseUrl;
const services: ServiceInfo[] = [
  { id: 'svc-0001', name: 'payments-api', team: 'payments', status: 'healthy' },
  { id: 'svc-0002', name: 'auth-cache', team: 'auth', status: 'healthy' },
];
const T0 = 1_700_000_000_000;
const history = (serviceId: string, p95: number) => ({
  serviceId,
  points: Array.from({ length: 30 }, (_, i) => ({ ts: T0 + i * 3000, p95, errRate: 1, rps: 100 })),
});
const url = (id: string) => `${BASE}/metrics/history?serviceId=${id}&minutes=15`;

describe('ServiceDetailPage', () => {
  let ctrl: HttpTestingController;

  function open() {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: STREAM_TRANSPORTS, useValue: [] },
      ],
    });
    ctrl = TestBed.inject(HttpTestingController);
    TestBed.inject(MetricsStore).init(services, { offset: 0, ts: 0, metrics: [] });
    TestBed.inject(StreamService).initialLoad.set('ready');
    return TestBed.createComponent(ServiceDetailPage);
  }
  const text = (f: { nativeElement: unknown }) =>
    (f.nativeElement as HTMLElement).textContent ?? '';
  const aria = (f: { nativeElement: unknown }) =>
    [...(f.nativeElement as HTMLElement).querySelectorAll('svg')].map(
      (s) => s.getAttribute('aria-label') ?? '',
    );

  it('shows the charts of the requested service', async () => {
    const fixture = open();
    fixture.componentRef.setInput('id', 'svc-0001');
    await fixture.whenStable();
    ctrl.expectOne(url('svc-0001')).flush(history('svc-0001', 111));
    await fixture.whenStable();
    expect(text(fixture)).toContain('payments-api');
    expect(aria(fixture)[0]).toContain('latest 111');
  });

  it('never shows another service while switching quickly: stale data is replaced by "loading", and the old request is cancelled', async () => {
    const fixture = open();
    fixture.componentRef.setInput('id', 'svc-0001');
    await fixture.whenStable();
    const first = ctrl.expectOne(url('svc-0001'));
    first.flush(history('svc-0001', 111));
    await fixture.whenStable();
    expect(aria(fixture)[0]).toContain('latest 111');

    // switch to service 2; its history has not arrived yet
    fixture.componentRef.setInput('id', 'svc-0002');
    await fixture.whenStable();
    expect(text(fixture)).toContain('auth-cache');
    expect(text(fixture)).not.toContain('payments-api');
    expect(aria(fixture)).toEqual([]); // no charts at all, certainly not the old service's
    expect(text(fixture)).toContain('Loading history');

    ctrl.expectOne(url('svc-0002')).flush(history('svc-0002', 222));
    await fixture.whenStable();
    expect(aria(fixture)[0]).toContain('latest 222');
    expect(aria(fixture).join(' ')).not.toContain('111');
  });

  it('a slow response for the previous service is cancelled and can never show up', async () => {
    const fixture = open();
    fixture.componentRef.setInput('id', 'svc-0001');
    await fixture.whenStable();
    const slow = ctrl.expectOne(url('svc-0001')); // still in flight
    fixture.componentRef.setInput('id', 'svc-0002');
    await fixture.whenStable();
    expect(slow.cancelled).toBe(true);

    ctrl.expectOne(url('svc-0002')).flush(history('svc-0002', 222));
    await fixture.whenStable();
    expect(aria(fixture).join(' ')).not.toContain('111');
    expect(aria(fixture)[0]).toContain('latest 222');
  });

  it('shows the error and a Retry button in the charts panel only, and keeps the header', async () => {
    const fixture = open();
    fixture.componentRef.setInput('id', 'svc-0001');
    await fixture.whenStable();
    ctrl
      .expectOne(url('svc-0001'))
      .flush(
        { error: { code: 'server_error', message: 'boom', details: [] } },
        { status: 500, statusText: 'x' },
      );
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.charts [role="alert"]')?.textContent).toContain(
      'Could not load the history: boom',
    );
    expect(text(fixture)).toContain('payments-api'); // the rest of the page is untouched

    el.querySelector<HTMLButtonElement>('.charts button')?.click();
    ctrl.expectOne(url('svc-0001')).flush(history('svc-0001', 111));
    await fixture.whenStable();
    expect(aria(fixture)[0]).toContain('latest 111');
  });

  it('says so when the service does not exist', async () => {
    const fixture = open();
    fixture.componentRef.setInput('id', 'svc-9999');
    await fixture.whenStable();
    expect(text(fixture)).toContain('Service not found');
    ctrl.expectNone(url('svc-9999'));
  });
});
