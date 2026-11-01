import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { AlertRule } from '../rules/rules.models';
import { RulesStore } from '../rules/rules.store';
import { MetricsStore } from '../stream/metrics-store';
import { MetricEvent } from '../stream/stream.models';
import { AlertNotifier } from './alert-notifier';
import { RuleEvaluator } from './rule-evaluator';

const rule: AlertRule = {
  id: 'r-1',
  name: 'Checkout latency',
  createdAt: 0,
  updatedAt: 1,
  conditions: [{ metric: 'p95', operator: '>', threshold: 500, durationSec: 5 }],
};
let seq = 0;
const ev = (ts: number, p95: number, serviceId = 'svc-0001'): MetricEvent => ({
  type: 'metric',
  offset: ++seq,
  serviceId,
  seq,
  ts,
  p95,
  errRate: 0,
  rps: 1,
  status: 'healthy',
});

describe('RuleEvaluator', () => {
  let evaluator: RuleEvaluator;
  let metrics: MetricsStore;
  let rules: RulesStore;
  const notify = vi.fn();

  beforeEach(() => {
    notify.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AlertNotifier, useValue: { notify } },
      ],
    });
    metrics = TestBed.inject(MetricsStore);
    rules = TestBed.inject(RulesStore);
    evaluator = TestBed.inject(RuleEvaluator);
    metrics.init(
      [
        { id: 'svc-0001', name: 'a', team: 't', status: 'healthy' },
        { id: 'svc-0002', name: 'b', team: 't', status: 'healthy' },
      ],
      { offset: 0, ts: 0, metrics: [] },
    );
    evaluator.start();
    rules.confirmed.set([rule]);
    TestBed.tick();
  });
  afterEach(() => evaluator.stop());

  it('turns live stream events into one incident and one notification, however long it lasts', () => {
    metrics.apply(ev(0, 900));
    metrics.apply(ev(5000, 900)); // held for 5 s: fires
    for (let t = 6; t < 30; t++) metrics.apply(ev(t * 1000, 950)); // keeps breaching

    expect(evaluator.incidents()).toHaveLength(1);
    expect(evaluator.incidents()[0]).toMatchObject({
      ruleName: 'Checkout latency',
      serviceId: 'svc-0001',
      severity: 'critical',
    });
    expect(evaluator.openCount()).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('marks the incident resolved when the metric recovers, and keeps it in the list', () => {
    metrics.apply(ev(0, 900));
    metrics.apply(ev(5000, 900));
    metrics.apply(ev(6000, 100));
    expect(evaluator.openCount()).toBe(0);
    expect(evaluator.incidents()[0].resolvedAt).toBe(6000);
  });

  it('does not evaluate a rule that is only optimistic (not confirmed by the server)', () => {
    rules.confirmed.set([]);
    TestBed.tick();
    metrics.apply(ev(0, 900));
    metrics.apply(ev(5000, 900));
    expect(evaluator.incidents()).toEqual([]);
  });

  it('closes the open incidents of a rule that gets deleted', () => {
    metrics.apply(ev(0, 900));
    metrics.apply(ev(5000, 900));
    rules.confirmed.set([]);
    TestBed.tick();
    expect(evaluator.openCount()).toBe(0);
    expect(evaluator.incidents()).toHaveLength(1);
  });

  it('stop() clears the incidents and stops listening', () => {
    metrics.apply(ev(0, 900));
    metrics.apply(ev(5000, 900));
    evaluator.stop();
    expect(evaluator.incidents()).toEqual([]);
    metrics.apply(ev(6000, 900));
    expect(evaluator.incidents()).toEqual([]);
  });

  it('keeps the list bounded, dropping the oldest resolved incidents first', () => {
    rules.confirmed.set([
      { ...rule, updatedAt: 2, conditions: [{ ...rule.conditions[0], durationSec: 0 }] },
    ]);
    TestBed.tick();
    for (let i = 0; i < 260; i++) {
      metrics.apply(ev(i * 2000, 900)); // fires
      metrics.apply(ev(i * 2000 + 1000, 100)); // resolves
    }
    expect(evaluator.incidents().length).toBeLessThanOrEqual(200);
    expect(evaluator.incidents()[0].firedAt).toBe(259 * 2000); // newest first
  });
});
