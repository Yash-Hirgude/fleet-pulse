import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { AlertRule } from '../../core/rules/rules.models';
import { RulesStore } from '../../core/rules/rules.store';
import { RulesListPage } from './rules-list.page';

const rule: AlertRule = {
  id: 'r-1',
  name: 'Checkout latency',
  createdAt: 1,
  updatedAt: 1,
  conditions: [
    { metric: 'p95', operator: '>', threshold: 500, durationSec: 30, warningThreshold: 400 },
  ],
};

async function render(role: 'operator' | 'viewer') {
  const auth = {
    isOperator: () => role === 'operator',
    role: () => role,
    user: () => ({ id: 'u', email: 'x', role }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: AuthService, useValue: auth },
    ],
  });
  const store = TestBed.inject(RulesStore);
  store.rules.set([rule, { ...rule, id: 'pending-1', name: 'Saving one', pending: true }]);
  store.loadState.set('ready');
  const fixture = TestBed.createComponent(RulesListPage);
  await fixture.whenStable();
  return { fixture, store, el: fixture.nativeElement as HTMLElement };
}

describe('RulesListPage', () => {
  it('lists rules with a readable summary of their conditions, and marks unconfirmed ones as saving', async () => {
    const { el } = await render('operator');
    expect(el.textContent).toContain('Checkout latency');
    expect(el.textContent).toContain('p95 latency > 500 ms for 30 s, warning at 400 ms');
    expect(el.textContent).toContain('Saving…');
  });

  it('operators get New, Edit and Delete; a rule that is still saving has no actions', async () => {
    const { el } = await render('operator');
    expect(el.textContent).toContain('New rule');
    expect(el.querySelectorAll('a[aria-label^="Edit"]')).toHaveLength(1);
    expect(el.querySelectorAll('button[aria-label^="Delete"]')).toHaveLength(1);
  });

  it('hides every edit action from viewers', async () => {
    const { el } = await render('viewer');
    expect(el.textContent).not.toContain('New rule');
    expect(el.querySelectorAll('a[aria-label^="Edit"], button[aria-label^="Delete"]')).toHaveLength(
      0,
    );
  });

  it('shows a rejected save with Retry and Dismiss, and the list is the restored one', async () => {
    const { store, fixture, el } = await render('operator');
    store.rules.set([rule]);
    store.failures.set([
      { id: 1, operation: 'create', name: 'Lost rule', message: 'boom', retry: vi.fn() },
    ]);
    await fixture.whenStable();
    const alert = el.querySelector('.failure');
    expect(alert?.textContent).toContain('Could not save “Lost rule”: boom');
    expect(alert?.textContent).toContain('The list was restored.');
    expect([...el.querySelectorAll('.failure button')].map((b) => b.textContent?.trim())).toEqual([
      'Retry',
      'Dismiss',
    ]);
  });
});
