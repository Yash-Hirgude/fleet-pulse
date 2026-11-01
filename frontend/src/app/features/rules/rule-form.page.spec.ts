import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config';
import { AlertRule } from '../../core/rules/rules.models';
import { RulesStore } from '../../core/rules/rules.store';
import { RuleFormPage } from './rule-form.page';

const BASE = DEFAULT_APP_CONFIG.api.baseUrl;

@Component({ template: '' })
class Dummy {}

describe('RuleFormPage', () => {
  let ctrl: HttpTestingController;
  let router: Router;
  let fixture: ComponentFixture<RuleFormPage>;
  const root = () => fixture.nativeElement as HTMLElement;

  async function open(id?: string) {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'rules', component: Dummy }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    ctrl = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    fixture = TestBed.createComponent(RuleFormPage);
    if (id) fixture.componentRef.setInput('id', id);
    await fixture.whenStable();
  }

  function type(selector: string, value: string, event = 'input') {
    const el = root().querySelector<HTMLInputElement | HTMLSelectElement>(
      selector,
    ) as HTMLInputElement;
    el.value = value;
    el.dispatchEvent(new Event(event));
  }
  const nth = (name: string, i = 0) =>
    `.condition:nth-of-type(${i + 1}) [formControlName="${name}"]`;
  const submit = async () => {
    root().querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
  };

  it('starts with one empty condition', async () => {
    await open();
    expect(root().querySelectorAll('.condition')).toHaveLength(1);
    expect(root().textContent).toContain('New rule');
  });

  it('changes the condition fields with the metric: unit, hint and limits', async () => {
    await open();
    expect(root().textContent).toContain('Critical threshold (ms)');
    expect(root().textContent).toContain('Milliseconds, 0 to 60,000');

    type(nth('metric'), 'errRate', 'change');
    await fixture.whenStable();
    expect(root().textContent).toContain('Critical threshold (%)');
    expect(root().textContent).toContain('Percentage, 0 to 100');
    const threshold = root().querySelector(nth('threshold')) as HTMLInputElement;
    expect(threshold.getAttribute('max')).toBe('100');
    expect(threshold.getAttribute('step')).toBe('0.1');
  });

  it('adds and removes conditions, and never removes the last one', async () => {
    await open();
    const removeButtons = () => [
      ...root().querySelectorAll<HTMLButtonElement>('.condition__remove'),
    ];
    expect(removeButtons()[0].disabled).toBe(true);

    [...root().querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Add condition'))
      ?.click();
    await fixture.whenStable();
    expect(root().querySelectorAll('.condition')).toHaveLength(2);
    expect(removeButtons().every((b) => !b.disabled)).toBe(true);

    removeButtons()[0].click();
    await fixture.whenStable();
    expect(root().querySelectorAll('.condition')).toHaveLength(1);
  });

  it('does not send anything when the form is invalid, and shows what is wrong', async () => {
    await open();
    await submit();
    ctrl.expectNone(() => true);
    expect(root().textContent).toContain('This field is required.');
  });

  it('shows the cross-field error when the warning level is not before the critical one', async () => {
    await open();
    type('[formControlName="name"]', 'Latency');
    type(nth('threshold'), '500');
    type(nth('warningThreshold'), '600');
    await submit();
    expect(root().querySelector('.condition__error')?.textContent).toContain(
      'warning level must be lower',
    );
    ctrl.expectNone(() => true);
  });

  /** Types a name and lets the (real-time) debounced name check run and answer. */
  async function typeFreeName(name: string) {
    type('[formControlName="name"]', name);
    await vi.waitFor(() =>
      ctrl
        .expectOne(`${BASE}/rules/check-name?name=${encodeURIComponent(name)}`)
        .flush({ available: true }),
    );
    await fixture.whenStable();
  }

  it('on a valid submit it sends ONE POST with an idempotency key and goes back to the list, without asking about unsaved changes', async () => {
    await open();
    await typeFreeName('Checkout latency');
    type(nth('threshold'), '500');
    type(nth('durationSec'), '30');
    expect(fixture.componentInstance.hasUnsavedChanges()).toBe(true);

    await submit();
    const post = ctrl.expectOne(`${BASE}/rules`);
    expect(post.request.method).toBe('POST');
    expect(post.request.headers.get('Idempotency-Key')).toBeTruthy();
    expect(post.request.body).toEqual({
      name: 'Checkout latency',
      conditions: [{ metric: 'p95', operator: '>', threshold: 500, durationSec: 30 }],
    });
    expect(TestBed.inject(RulesStore).rules()[0]).toMatchObject({
      name: 'Checkout latency',
      pending: true,
    }); // visible at once
    expect(fixture.componentInstance.hasUnsavedChanges()).toBe(false);
    await vi.waitFor(() => expect(router.url).toBe('/rules'));
  });

  it('submitting while the name check is still running waits for it instead of being ignored', async () => {
    await open();
    type('[formControlName="name"]', 'Quick');
    type(nth('threshold'), '500');
    type(nth('durationSec'), '30');
    await submit(); // pressed Enter right away: the check has not even started its request
    ctrl.expectNone(`${BASE}/rules`);

    await vi.waitFor(() =>
      ctrl.expectOne(`${BASE}/rules/check-name?name=Quick`).flush({ available: true }),
    );
    await vi.waitFor(() => expect(ctrl.expectOne(`${BASE}/rules`).request.method).toBe('POST'));
  });

  it('does not save when the name check says the name is taken', async () => {
    await open();
    type('[formControlName="name"]', 'Checkout latency');
    type(nth('threshold'), '500');
    type(nth('durationSec'), '30');
    await submit();
    await vi.waitFor(() =>
      ctrl
        .expectOne(`${BASE}/rules/check-name?name=Checkout%20latency`)
        .flush({ available: false }),
    );
    await fixture.whenStable();
    ctrl.expectNone(`${BASE}/rules`);
    expect(root().textContent).toContain('A rule with this name already exists.');
  });

  it('edits an existing rule: pre-filled, and its own name is not a conflict', async () => {
    const rule: AlertRule = {
      id: 'r-1',
      name: 'Error budget burn',
      createdAt: 1,
      updatedAt: 1,
      conditions: [{ metric: 'errRate', operator: '>=', threshold: 5, durationSec: 10 }],
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'rules', component: Dummy }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    ctrl = TestBed.inject(HttpTestingController);
    const store = TestBed.inject(RulesStore);
    store.rules.set([rule]);
    store.confirmed.set([rule]);
    store.loadState.set('ready');
    fixture = TestBed.createComponent(RuleFormPage);
    fixture.componentRef.setInput('id', 'r-1');
    await fixture.whenStable();

    expect(root().textContent).toContain('Edit rule');
    expect((root().querySelector('[formControlName="name"]') as HTMLInputElement).value).toBe(
      'Error budget burn',
    );
    expect((root().querySelector(nth('threshold')) as HTMLInputElement).value).toBe('5');
    ctrl.expectNone(() => true); // no check-name for its own name
    expect(fixture.componentInstance.hasUnsavedChanges()).toBe(false);

    await submit();
    expect(ctrl.expectOne(`${BASE}/rules/r-1`).request.method).toBe('PUT');
  });

  it('says so when the rule does not exist', async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    TestBed.inject(RulesStore).loadState.set('ready');
    fixture = TestBed.createComponent(RuleFormPage);
    fixture.componentRef.setInput('id', 'r-404');
    await fixture.whenStable();
    expect(root().textContent).toContain('does not exist');
  });
});
