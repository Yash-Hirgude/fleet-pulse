import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { of } from 'rxjs';
import { DEFAULT_APP_CONFIG } from '../config/app-config';
import { AlertNotifier } from './alert-notifier';
import { Incident } from './rule-engine';
import { SettingsService } from './settings.service';

const incident = (serviceId: string): Incident => ({
  id: serviceId,
  ruleId: 'r-1',
  ruleName: 'Checkout latency',
  serviceId,
  severity: 'critical',
  firedAt: 0,
  resolvedAt: null,
  p95: 1,
  errRate: 0,
  rps: 1,
});

describe('AlertNotifier', () => {
  const open = vi.fn();
  let notifier: AlertNotifier;
  let settings: SettingsService;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    open.mockReset();
    open.mockReturnValue({ onAction: () => of(undefined) });
    TestBed.configureTestingModule({ providers: [{ provide: MatSnackBar, useValue: { open } }] });
    notifier = TestBed.inject(AlertNotifier);
    settings = TestBed.inject(SettingsService);
  });
  afterEach(() => vi.useRealTimers());

  it('shows one notification for one alert', () => {
    notifier.notify(incident('svc-1'), false, () => undefined);
    vi.advanceTimersByTime(DEFAULT_APP_CONFIG.ui.notificationBatchMs);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toBe('Checkout latency fired on svc-1');
  });

  it('turns a burst of alerts into a single notification', () => {
    for (let i = 0; i < 100; i++) notifier.notify(incident(`svc-${i}`), false, () => undefined);
    vi.advanceTimersByTime(DEFAULT_APP_CONFIG.ui.notificationBatchMs);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toContain('100 alerts fired');
  });

  it('says "escalated" for an escalation', () => {
    notifier.notify(incident('svc-1'), true, () => undefined);
    vi.advanceTimersByTime(DEFAULT_APP_CONFIG.ui.notificationBatchMs);
    expect(open.mock.calls[0][0]).toContain('escalated to critical');
  });

  it('stays silent when notifications are switched off in the settings', () => {
    settings.save({ notifyOnFiring: false, notificationSeconds: 6 });
    notifier.notify(incident('svc-1'), false, () => undefined);
    vi.advanceTimersByTime(5000);
    expect(open).not.toHaveBeenCalled();
  });

  it('uses the configured duration', () => {
    settings.save({ notifyOnFiring: true, notificationSeconds: 12 });
    notifier.notify(incident('svc-1'), false, () => undefined);
    vi.advanceTimersByTime(DEFAULT_APP_CONFIG.ui.notificationBatchMs);
    expect(open.mock.calls[0][2]).toMatchObject({ duration: 12_000 });
  });
});
