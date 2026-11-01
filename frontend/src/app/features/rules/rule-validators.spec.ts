import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { FormArray, FormControl } from '@angular/forms';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config';
import { ApiClient } from '../../core/http/api-client';
import { createConditionGroup, createRuleForm, toRuleDraft } from './rule-form';
import { noDuplicateConditions, notBlank, uniqueRuleName, wholeSeconds } from './rule-validators';

const BASE = DEFAULT_APP_CONFIG.api.baseUrl;

describe('single-field validators', () => {
  it('notBlank rejects a name that is only spaces, but not an empty one (required handles that)', () => {
    expect(notBlank(new FormControl('   '))).toEqual({ blank: true });
    expect(notBlank(new FormControl(''))).toBeNull();
    expect(notBlank(new FormControl(' a '))).toBeNull();
  });

  it.each([
    [60, null],
    [0, null],
    [86_400, null],
    [1.5, { wholeSeconds: true }],
    [-1, { wholeSeconds: true }],
    [86_401, { wholeSeconds: true }],
  ])('wholeSeconds(%s)', (value, expected) => {
    expect(wholeSeconds(new FormControl(value))).toEqual(expected);
  });
});

describe('cross-field validators on a condition', () => {
  it('error rate is a percentage from 0 to 100; latency is in milliseconds up to 60,000', () => {
    const g = createConditionGroup({ metric: 'errRate', threshold: 150, durationSec: 10 });
    expect(g.errors).toMatchObject({ thresholdRange: { min: 0, max: 100, unit: '%' } });

    g.controls.threshold.setValue(50);
    expect(g.errors).toBeNull();

    g.controls.metric.setValue('p95'); // the same 150 is fine for latency: changing the metric re-validates
    g.controls.threshold.setValue(150);
    expect(g.errors).toBeNull();
    g.controls.threshold.setValue(70_000);
    expect(g.errors).toMatchObject({ thresholdRange: { max: 60_000, unit: 'ms' } });
  });

  it('switching the metric re-runs the range check on an existing value', () => {
    const g = createConditionGroup({ metric: 'p95', threshold: 500, durationSec: 10 });
    expect(g.errors).toBeNull();
    g.controls.metric.setValue('errRate'); // 500 % is invalid
    expect(g.errors).toMatchObject({ thresholdRange: { max: 100 } });
  });

  it('the warning level must be lower than the critical threshold for > and >=', () => {
    const g = createConditionGroup({
      metric: 'p95',
      operator: '>',
      threshold: 500,
      warningThreshold: 600,
      durationSec: 5,
    });
    expect(g.errors).toEqual({ warningOrder: { expected: 'lower' } });
    g.controls.warningThreshold.setValue(500); // equal is not "before"
    expect(g.errors).toEqual({ warningOrder: { expected: 'lower' } });
    g.controls.warningThreshold.setValue(400);
    expect(g.errors).toBeNull();
  });

  it('the warning level must be higher than the critical threshold for < and <=', () => {
    const g = createConditionGroup({
      metric: 'rps',
      operator: '<',
      threshold: 100,
      warningThreshold: 50,
      durationSec: 5,
    });
    expect(g.errors).toEqual({ warningOrder: { expected: 'higher' } });
    g.controls.warningThreshold.setValue(200);
    expect(g.errors).toBeNull();
  });

  it('an empty warning level is allowed', () => {
    const g = createConditionGroup({ metric: 'p95', threshold: 500, durationSec: 5 });
    expect(g.errors).toBeNull();
  });
});

describe('noDuplicateConditions (across rows)', () => {
  it('flags two conditions with the same metric and operator', () => {
    const array = new FormArray([
      createConditionGroup({ metric: 'p95', operator: '>', threshold: 1, durationSec: 1 }),
      createConditionGroup({ metric: 'p95', operator: '>', threshold: 2, durationSec: 1 }),
    ]);
    expect(noDuplicateConditions(array)).toEqual({ duplicateCondition: true });
    array.at(1).controls.operator.setValue('<');
    expect(noDuplicateConditions(array)).toBeNull();
  });
});

describe('uniqueRuleName (async)', () => {
  let ctrl: HttpTestingController;
  let api: ApiClient;
  let excludeId: string | null;
  let original: string | null;
  const debounce = DEFAULT_APP_CONFIG.ui.nameCheckDebounceMs;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    ctrl = TestBed.inject(HttpTestingController);
    api = TestBed.inject(ApiClient);
    excludeId = null;
    original = null;
  });
  afterEach(() => vi.useRealTimers());

  const control = () =>
    new FormControl('', {
      asyncValidators: [
        uniqueRuleName({
          api,
          debounceMs: debounce,
          excludeId: () => excludeId,
          originalName: () => original,
        }),
      ],
      nonNullable: true,
    });

  it('asks the server after the debounce and reports a taken name', async () => {
    const c = control();
    c.setValue('Checkout latency');
    expect(c.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(debounce - 1);
    ctrl.expectNone(() => true);
    await vi.advanceTimersByTimeAsync(1);
    ctrl.expectOne(`${BASE}/rules/check-name?name=Checkout%20latency`).flush({ available: false });
    expect(c.errors).toEqual({ nameTaken: true });
    expect(c.pending).toBe(false);
  });

  it('accepts an available name', async () => {
    const c = control();
    c.setValue('Brand new');
    await vi.advanceTimersByTimeAsync(debounce);
    ctrl.expectOne(`${BASE}/rules/check-name?name=Brand%20new`).flush({ available: true });
    expect(c.errors).toBeNull();
  });

  it('only the latest keystroke is checked: typing again cancels the earlier check', async () => {
    const c = control();
    c.setValue('Chec');
    await vi.advanceTimersByTimeAsync(debounce); // request for "Chec" goes out
    const first = ctrl.expectOne(`${BASE}/rules/check-name?name=Chec`);
    c.setValue('Checkout'); // typed again while it is in flight
    expect(first.cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(debounce);
    ctrl.expectOne(`${BASE}/rules/check-name?name=Checkout`).flush({ available: true });
    expect(c.errors).toBeNull();
  });

  it('typing again within the debounce sends no request for the intermediate value', async () => {
    const c = control();
    c.setValue('a');
    await vi.advanceTimersByTimeAsync(100);
    c.setValue('ab');
    await vi.advanceTimersByTimeAsync(debounce);
    ctrl.expectOne(`${BASE}/rules/check-name?name=ab`).flush({ available: true });
    ctrl.expectNone(`${BASE}/rules/check-name?name=a`);
  });

  it("sends excludeId when editing, and does not ask at all for the rule's own saved name", async () => {
    excludeId = 'r-7';
    original = 'Error budget burn';
    const c = control();
    c.setValue('error BUDGET burn');
    expect(c.pending).toBe(false);
    ctrl.expectNone(() => true);

    c.setValue('Another name');
    await vi.advanceTimersByTimeAsync(debounce);
    ctrl
      .expectOne(`${BASE}/rules/check-name?name=Another%20name&excludeId=r-7`)
      .flush({ available: true });
  });

  it('does not block the form when the check itself fails (the server still answers 409 on save)', async () => {
    const c = control();
    c.setValue('Whatever');
    await vi.advanceTimersByTimeAsync(debounce);
    ctrl
      .expectOne(`${BASE}/rules/check-name?name=Whatever`)
      .flush('x', { status: 400, statusText: 'Bad' });
    expect(c.errors).toBeNull();
  });
});

describe('rule form', () => {
  it('builds the request body, trimming the name and leaving out an empty warning level', () => {
    const form = createRuleForm(null, () => of(null));
    form.controls.name.setValue('  Checkout latency  ');
    form.controls.conditions
      .at(0)
      .patchValue({ metric: 'p95', operator: '>', threshold: 500, durationSec: 30 });
    form.controls.conditions.push(
      createConditionGroup({
        metric: 'errRate',
        operator: '>=',
        threshold: 5,
        warningThreshold: 2,
        durationSec: 10,
      }),
    );
    expect(toRuleDraft(form)).toEqual({
      name: 'Checkout latency',
      conditions: [
        { metric: 'p95', operator: '>', threshold: 500, durationSec: 30 },
        { metric: 'errRate', operator: '>=', threshold: 5, durationSec: 10, warningThreshold: 2 },
      ],
    });
  });

  it('a new form starts with one condition and is invalid until it is filled in', () => {
    const form = createRuleForm(null, () => of(null));
    expect(form.controls.conditions.length).toBe(1);
    expect(form.valid).toBe(false);
  });
});
