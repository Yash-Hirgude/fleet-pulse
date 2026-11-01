import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiClient } from '../http/api-client';
import { ApiFailure, toApiFailure } from '../http/api-error';
import { AlertRule, RuleDraft } from './rules.models';

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/** A save the server rejected. The list has already rolled back; this is what the user sees and can retry. */
export interface SaveFailure {
  readonly id: number;
  readonly operation: 'create' | 'update' | 'delete';
  readonly name: string;
  readonly message: string;
  readonly retry: () => void;
}

/**
 * Alert rules, with optimistic updates:
 *  - `rules` is what the screen shows. A save appears in it at once (flagged `pending`);
 *  - `confirmed` is only what the server has acknowledged. Rule evaluation reads this one, so an unconfirmed
 *    edit never changes what fires;
 *  - when the server rejects a change, the list returns to its previous state and a `SaveFailure` is recorded.
 * Writes are never retried automatically. A manual retry of a create reuses its Idempotency-Key, so a request
 * that actually reached the server cannot create a second rule.
 */
@Injectable({ providedIn: 'root' })
export class RulesStore {
  private readonly api = inject(ApiClient);

  readonly rules = signal<readonly AlertRule[]>([]);
  readonly confirmed = signal<readonly AlertRule[]>([]);
  readonly loadState = signal<LoadState>('idle');
  readonly failures = signal<readonly SaveFailure[]>([]);
  readonly isReady = computed(() => this.loadState() === 'ready');

  private seq = 0;
  private failureSeq = 0;
  /** payload JSON -> idempotency key, so a retry of the same create reuses its key. */
  private readonly keys = new Map<string, string>();

  load(): void {
    this.loadState.set('loading');
    this.api.get<AlertRule[]>('/rules').subscribe({
      next: (rules) => {
        this.rules.set(rules);
        this.confirmed.set(rules);
        this.loadState.set('ready');
      },
      error: () => this.loadState.set('error'),
    });
  }

  reset(): void {
    this.rules.set([]);
    this.confirmed.set([]);
    this.failures.set([]);
    this.loadState.set('idle');
    this.keys.clear();
  }

  find(id: string): AlertRule | undefined {
    return this.rules().find((r) => r.id === id);
  }

  // ---------------------------------------------------------------- create

  create(draft: RuleDraft): void {
    const body = JSON.stringify(draft);
    let key = this.keys.get(body);
    if (!key) {
      key = crypto.randomUUID();
      this.keys.set(body, key);
    }
    const idempotencyKey = key;

    const tempId = `pending-${++this.seq}`;
    const now = Date.now();
    this.rules.update((list) => [
      ...list,
      { ...draft, id: tempId, createdAt: now, updatedAt: now, pending: true },
    ]);

    this.api.post<AlertRule>('/rules', draft, { 'Idempotency-Key': idempotencyKey }).subscribe({
      next: (saved) => {
        this.keys.delete(body);
        this.rules.update((list) => list.map((r) => (r.id === tempId ? saved : r)));
        this.confirmed.update((list) => [...list, saved]);
      },
      error: (err: unknown) => {
        this.rules.update((list) => list.filter((r) => r.id !== tempId)); // back to the previous state
        this.fail('create', draft.name, toApiFailure(err), () => this.create(draft));
      },
    });
  }

  // ---------------------------------------------------------------- update

  update(id: string, draft: RuleDraft): void {
    const previous = this.rules().find((r) => r.id === id);
    if (!previous) return;
    this.rules.update((list) =>
      list.map((r) => (r.id === id ? { ...r, ...draft, updatedAt: Date.now(), pending: true } : r)),
    );

    this.api.put<AlertRule>(`/rules/${id}`, draft).subscribe({
      next: (saved) => {
        this.rules.update((list) => list.map((r) => (r.id === id ? saved : r)));
        this.confirmed.update((list) => list.map((r) => (r.id === id ? saved : r)));
      },
      error: (err: unknown) => {
        this.rules.update((list) => list.map((r) => (r.id === id ? previous : r)));
        this.fail('update', draft.name, toApiFailure(err), () => this.update(id, draft));
      },
    });
  }

  // ---------------------------------------------------------------- delete

  remove(id: string): void {
    const list = this.rules();
    const index = list.findIndex((r) => r.id === id);
    if (index < 0) return;
    const previous = list[index];
    this.rules.set(list.filter((r) => r.id !== id));

    this.api.delete(`/rules/${id}`).subscribe({
      next: () => this.confirmed.update((c) => c.filter((r) => r.id !== id)),
      error: (err: unknown) => {
        this.rules.update((current) => {
          const copy = [...current];
          copy.splice(Math.min(index, copy.length), 0, previous); // same place it was in
          return copy;
        });
        this.fail('delete', previous.name, toApiFailure(err), () => this.remove(id));
      },
    });
  }

  // ---------------------------------------------------------------- failures

  retry(failureId: number): void {
    const failure = this.failures().find((f) => f.id === failureId);
    if (!failure) return;
    this.dismiss(failureId);
    failure.retry();
  }

  dismiss(failureId: number): void {
    this.failures.update((list) => list.filter((f) => f.id !== failureId));
  }

  private fail(
    operation: SaveFailure['operation'],
    name: string,
    failure: ApiFailure,
    retry: () => void,
  ): void {
    const message =
      failure.code === 'name_taken'
        ? `A rule named "${name}" already exists.`
        : failure.details.length > 0
          ? failure.details.map((d) => d.message).join(' ')
          : failure.message;
    this.failures.update((list) => [
      ...list,
      { id: ++this.failureSeq, operation, name, message, retry },
    ]);
  }
}
