import { AlertRule, Condition } from '../rules/rules.models';
import { MetricEvent } from '../stream/stream.models';
import { EngineChange, RuleEngine } from './rule-engine';

let offset = 0;
const ev = (serviceId: string, ts: number, over: Partial<MetricEvent> = {}): MetricEvent => ({
  type: 'metric',
  offset: ++offset,
  serviceId,
  seq: offset,
  ts,
  p95: 100,
  errRate: 0.5,
  rps: 500,
  status: 'healthy',
  ...over,
});
const cond = (over: Partial<Condition> = {}): Condition => ({
  metric: 'p95',
  operator: '>',
  threshold: 500,
  durationSec: 5,
  ...over,
});
const rule = (conditions: Condition[], over: Partial<AlertRule> = {}): AlertRule => ({
  id: 'r-1',
  name: 'Checkout latency',
  conditions,
  createdAt: 0,
  updatedAt: 1,
  ...over,
});
const kinds = (changes: EngineChange[]) => changes.map((c) => c.kind);
const S = 1000;

describe('RuleEngine', () => {
  let engine: RuleEngine;
  beforeEach(() => {
    engine = new RuleEngine(() => 999_999);
  });

  it('does not fire until the condition has held for its duration', () => {
    engine.setRules([rule([cond()])]);
    expect(engine.evaluate(ev('svc-1', 0, { p95: 900 }))).toEqual([]); // starts the clock
    expect(engine.evaluate(ev('svc-1', 4 * S, { p95: 900 }))).toEqual([]); // 4 s: not yet
    const fired = engine.evaluate(ev('svc-1', 5 * S, { p95: 900 }));
    expect(kinds(fired)).toEqual(['fired']);
    expect(fired[0].incident).toMatchObject({
      ruleId: 'r-1',
      serviceId: 'svc-1',
      severity: 'critical',
      firedAt: 5 * S,
    });
  });

  it('starts the clock over when one event breaks the streak', () => {
    engine.setRules([rule([cond()])]);
    engine.evaluate(ev('svc-1', 0, { p95: 900 }));
    engine.evaluate(ev('svc-1', 3 * S, { p95: 100 })); // recovered for one event
    engine.evaluate(ev('svc-1', 4 * S, { p95: 900 })); // clock restarts here
    expect(engine.evaluate(ev('svc-1', 8 * S, { p95: 900 }))).toEqual([]); // only 4 s since 4 s
    expect(kinds(engine.evaluate(ev('svc-1', 9 * S, { p95: 900 })))).toEqual(['fired']);
  });

  it('fires only once for the same incident while it stays open', () => {
    engine.setRules([rule([cond({ durationSec: 0 })])]);
    expect(kinds(engine.evaluate(ev('svc-1', 0, { p95: 900 })))).toEqual(['fired']);
    for (let t = 1; t <= 50; t++)
      expect(engine.evaluate(ev('svc-1', t * S, { p95: 950 }))).toEqual([]);
  });

  it('resolves when the condition clears, and a later breach is a new incident', () => {
    engine.setRules([rule([cond({ durationSec: 0 })])]);
    const first = engine.evaluate(ev('svc-1', 0, { p95: 900 }))[0].incident;
    const resolved = engine.evaluate(ev('svc-1', S, { p95: 100 }));
    expect(kinds(resolved)).toEqual(['resolved']);
    expect(resolved[0].incident).toMatchObject({ id: first.id, resolvedAt: S });

    const second = engine.evaluate(ev('svc-1', 2 * S, { p95: 900 }));
    expect(kinds(second)).toEqual(['fired']);
    expect(second[0].incident.id).not.toBe(first.id);
  });

  it('requires ALL conditions of a rule', () => {
    engine.setRules([
      rule([cond({ durationSec: 0 }), cond({ metric: 'errRate', threshold: 5, durationSec: 0 })]),
    ]);
    expect(engine.evaluate(ev('svc-1', 0, { p95: 900, errRate: 1 }))).toEqual([]); // only one holds
    expect(kinds(engine.evaluate(ev('svc-1', S, { p95: 900, errRate: 9 })))).toEqual(['fired']);
  });

  it.each([
    ['>', 500, 500, false],
    ['>=', 500, 500, true],
    ['<', 100, 100, false],
    ['<=', 100, 100, true],
  ] as const)(
    'operator %s with value equal to the threshold',
    (operator, threshold, value, fires) => {
      engine.setRules([rule([cond({ metric: 'rps', operator, threshold, durationSec: 0 })])]);
      expect(kinds(engine.evaluate(ev('svc-1', 0, { rps: value }))).length).toBe(fires ? 1 : 0);
    },
  );

  it('tracks every service separately', () => {
    engine.setRules([rule([cond({ durationSec: 5 })])]);
    engine.evaluate(ev('svc-1', 0, { p95: 900 }));
    engine.evaluate(ev('svc-2', 3 * S, { p95: 900 }));
    expect(kinds(engine.evaluate(ev('svc-1', 5 * S, { p95: 900 })))).toEqual(['fired']);
    expect(engine.evaluate(ev('svc-2', 6 * S, { p95: 900 }))).toEqual([]); // svc-2 only 3 s in
    const second = engine.evaluate(ev('svc-2', 8 * S, { p95: 900 }));
    expect(second[0].incident.serviceId).toBe('svc-2');
  });

  it('uses a warning level first and escalates the same incident to critical', () => {
    engine.setRules([rule([cond({ threshold: 800, warningThreshold: 500, durationSec: 0 })])]);
    const warn = engine.evaluate(ev('svc-1', 0, { p95: 600 }));
    expect(kinds(warn)).toEqual(['fired']);
    expect(warn[0].incident.severity).toBe('warning');

    const crit = engine.evaluate(ev('svc-1', S, { p95: 900 }));
    expect(kinds(crit)).toEqual(['escalated']); // not a second incident
    expect(crit[0].incident).toMatchObject({ id: warn[0].incident.id, severity: 'critical' });

    expect(kinds(engine.evaluate(ev('svc-1', 2 * S, { p95: 600 })))).toEqual(['updated']); // back to warning
    expect(kinds(engine.evaluate(ev('svc-1', 3 * S, { p95: 100 })))).toEqual(['resolved']);
  });

  it('closes open incidents when the rule is deleted, and starts clean when it is edited', () => {
    engine.setRules([rule([cond({ durationSec: 0 })])]);
    engine.evaluate(ev('svc-1', 0, { p95: 900 }));

    expect(kinds(engine.setRules([]))).toEqual(['resolved']);
    expect(engine.evaluate(ev('svc-1', S, { p95: 900 }))).toEqual([]);

    engine.setRules([rule([cond({ durationSec: 0 })])]);
    engine.evaluate(ev('svc-1', 2 * S, { p95: 900 }));
    const edited = rule([cond({ durationSec: 0, threshold: 700 })], { updatedAt: 2 });
    expect(kinds(engine.setRules([edited]))).toEqual(['resolved']);
    expect(kinds(engine.evaluate(ev('svc-1', 3 * S, { p95: 900 })))).toEqual(['fired']); // fresh incident
  });

  it('does not touch rules that did not change when the list is set again', () => {
    const r = rule([cond({ durationSec: 0 })]);
    engine.setRules([r]);
    engine.evaluate(ev('svc-1', 0, { p95: 900 }));
    expect(engine.setRules([r, rule([cond()], { id: 'r-2', name: 'Other' })])).toEqual([]);
    expect(engine.evaluate(ev('svc-1', S, { p95: 900 }))).toEqual([]); // still the same open incident
  });

  it('keeps no state for services that are healthy', () => {
    engine.setRules([rule([cond({ durationSec: 0 })])]);
    for (let i = 0; i < 2000; i++) engine.evaluate(ev(`svc-${i}`, i, { p95: 100 }));
    // internal map stays empty: a breach starts from scratch for a service never seen in trouble
    expect(kinds(engine.evaluate(ev('svc-0', 5000, { p95: 900 })))).toEqual(['fired']);
  });
});
