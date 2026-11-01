import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { DEFAULT_APP_CONFIG } from '../config/app-config';
import { AlertRule, RuleDraft } from './rules.models';
import { RulesStore } from './rules.store';

const BASE = DEFAULT_APP_CONFIG.api.baseUrl;
const rule = (id: string, name: string): AlertRule => ({
  id,
  name,
  conditions: [{ metric: 'p95', operator: '>', threshold: 500, durationSec: 30 }],
  createdAt: 1,
  updatedAt: 1,
});
const draft = (name: string): RuleDraft => ({
  name,
  conditions: [{ metric: 'rps', operator: '<', threshold: 10, durationSec: 5 }],
});
const fail = (status: number, code = 'server_error', message = 'boom') => ({
  body: { error: { code, message, details: [] } },
  opts: { status, statusText: 'x' },
});

describe('RulesStore', () => {
  let store: RulesStore;
  let ctrl: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    store = TestBed.inject(RulesStore);
    ctrl = TestBed.inject(HttpTestingController);
    store.load();
    ctrl.expectOne(`${BASE}/rules`).flush([rule('r-1', 'First'), rule('r-2', 'Second')]);
  });

  it('loads the rules', () => {
    expect(store.loadState()).toBe('ready');
    expect(store.rules().map((r) => r.name)).toEqual(['First', 'Second']);
  });

  it('shows an error state when loading fails', () => {
    store.load();
    ctrl.expectOne(`${BASE}/rules`).flush('x', { status: 500, statusText: 'x' });
    expect(store.loadState()).toBe('error');
  });

  describe('create', () => {
    it('shows the new rule in the list immediately, flagged pending, and replaces it with the server rule', () => {
      store.create(draft('New'));
      expect(store.rules().map((r) => r.name)).toEqual(['First', 'Second', 'New']);
      expect(store.rules()[2].pending).toBe(true);
      expect(store.confirmed()).toHaveLength(2); // evaluation only sees confirmed rules

      const req = ctrl.expectOne(`${BASE}/rules`);
      expect(req.request.method).toBe('POST');
      expect(req.request.headers.get('Idempotency-Key')).toMatch(/\S+/);
      req.flush(rule('r-9', 'New'), { status: 201, statusText: 'Created' });

      expect(store.rules()[2]).toMatchObject({ id: 'r-9', name: 'New' });
      expect(store.rules()[2].pending).toBeUndefined();
      expect(store.confirmed().map((r) => r.id)).toEqual(['r-1', 'r-2', 'r-9']);
    });

    it('rolls the list back when the server rejects the save, and reports why', () => {
      store.create(draft('New'));
      const f = fail(409, 'name_taken');
      ctrl.expectOne(`${BASE}/rules`).flush(f.body, f.opts);

      expect(store.rules().map((r) => r.name)).toEqual(['First', 'Second']);
      expect(store.failures()).toHaveLength(1);
      expect(store.failures()[0]).toMatchObject({
        operation: 'create',
        name: 'New',
        message: 'A rule named "New" already exists.',
      });
    });

    it("sends the POST once, never retrying it behind the user's back", async () => {
      store.create(draft('New'));
      const f = fail(503);
      ctrl.expectOne(`${BASE}/rules`).flush(f.body, f.opts);
      await new Promise((r) => setTimeout(r, 50));
      ctrl.expectNone(`${BASE}/rules`);
    });

    it('a manual retry of the same rule reuses the idempotency key; a changed rule gets a new one', () => {
      store.create(draft('New'));
      const first = ctrl.expectOne(`${BASE}/rules`);
      const key = first.request.headers.get('Idempotency-Key');
      const f = fail(500);
      first.flush(f.body, f.opts);

      store.retry(store.failures()[0].id);
      const retry = ctrl.expectOne(`${BASE}/rules`);
      expect(retry.request.headers.get('Idempotency-Key')).toBe(key);
      expect(store.failures()).toHaveLength(0);
      retry.flush(rule('r-9', 'New'), { status: 201, statusText: 'Created' });

      store.create(draft('Different'));
      expect(ctrl.expectOne(`${BASE}/rules`).request.headers.get('Idempotency-Key')).not.toBe(key);
    });
  });

  describe('update', () => {
    it('shows the edit at once and confirms it with the server response', () => {
      store.update('r-1', draft('Renamed'));
      expect(store.rules()[0]).toMatchObject({ name: 'Renamed', pending: true });
      expect(store.confirmed()[0].name).toBe('First'); // not confirmed yet
      const req = ctrl.expectOne(`${BASE}/rules/r-1`);
      expect(req.request.method).toBe('PUT');
      req.flush({ ...rule('r-1', 'Renamed'), updatedAt: 5 });
      expect(store.rules()[0]).toMatchObject({ name: 'Renamed', updatedAt: 5 });
      expect(store.confirmed()[0].name).toBe('Renamed');
    });

    it('restores the previous rule when the server rejects it', () => {
      store.update('r-1', draft('Renamed'));
      const f = fail(422, 'validation', 'bad');
      ctrl.expectOne(`${BASE}/rules/r-1`).flush(f.body, f.opts);
      expect(store.rules()[0]).toEqual(rule('r-1', 'First'));
      expect(store.failures()[0]).toMatchObject({ operation: 'update', name: 'Renamed' });
    });
  });

  describe('delete', () => {
    it('removes the rule at once and keeps it removed on success', () => {
      store.remove('r-1');
      expect(store.rules().map((r) => r.id)).toEqual(['r-2']);
      ctrl.expectOne(`${BASE}/rules/r-1`).flush(null, { status: 204, statusText: 'No Content' });
      expect(store.confirmed().map((r) => r.id)).toEqual(['r-2']);
    });

    it('puts the rule back in the same place when the server rejects the delete', () => {
      store.remove('r-1');
      const f = fail(403, 'forbidden');
      ctrl.expectOne(`${BASE}/rules/r-1`).flush(f.body, f.opts);
      expect(store.rules().map((r) => r.id)).toEqual(['r-1', 'r-2']);
      expect(store.confirmed().map((r) => r.id)).toEqual(['r-1', 'r-2']);
      expect(store.failures()[0]).toMatchObject({ operation: 'delete', name: 'First' });
    });
  });

  it('dismiss removes a failure from the list', () => {
    store.create(draft('New'));
    const f = fail(500);
    ctrl.expectOne(`${BASE}/rules`).flush(f.body, f.opts);
    store.dismiss(store.failures()[0].id);
    expect(store.failures()).toEqual([]);
  });
});
