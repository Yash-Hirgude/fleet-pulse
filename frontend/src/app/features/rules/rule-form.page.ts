import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Router, RouterLink } from '@angular/router';
import { filter, take } from 'rxjs';
import { APP_CONFIG } from '../../core/config/app-config';
import { ApiClient } from '../../core/http/api-client';
import {
  AlertRule,
  METRICS,
  METRIC_FIELDS,
  OPERATORS,
  Operator,
} from '../../core/rules/rules.models';
import { RulesStore } from '../../core/rules/rules.store';
import {
  RuleForm,
  conditionMessages,
  controlMessage,
  createConditionGroup,
  createRuleForm,
  toRuleDraft,
} from './rule-form';
import { uniqueRuleName } from './rule-validators';
import { HasUnsavedChanges } from './unsaved-changes.guard';

const OPERATOR_LABELS: Record<Operator, string> = {
  '>': '> greater than',
  '>=': '>= at least',
  '<': '< less than',
  '<=': '<= at most',
};

@Component({
  selector: 'fp-rule-form-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, RouterLink],
  styleUrl: './rule-form.page.scss',
  host: { '(window:beforeunload)': 'onBeforeUnload($event)' },
  template: `
    <p><a routerLink="/rules">← Back to rules</a></p>
    <h1>{{ id() ? 'Edit rule' : 'New rule' }}</h1>

    @if (form(); as f) {
      <form [formGroup]="f" (ngSubmit)="submit()" novalidate class="rule-form">
        <mat-form-field appearance="outline">
          <mat-label>Rule name</mat-label>
          <input matInput formControlName="name" autocomplete="off" />
          @if (f.controls.name.pending) {
            <mat-hint>Checking that the name is free…</mat-hint>
          }
          <mat-error>{{ nameError() }}</mat-error>
        </mat-form-field>

        <fieldset class="conditions">
          <legend>
            Conditions <span class="legend-note">(all must hold for the rule to fire)</span>
          </legend>

          @for (group of f.controls.conditions.controls; track group; let i = $index) {
            @let field = fields[group.controls.metric.value];
            <div
              class="condition"
              [formGroup]="group"
              role="group"
              [attr.aria-label]="'Condition ' + (i + 1)"
            >
              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>Metric</mat-label>
                <select matNativeControl formControlName="metric" [id]="'cond-' + i + '-metric'">
                  @for (m of metrics; track m) {
                    <option [value]="m">{{ fields[m].label }}</option>
                  }
                </select>
              </mat-form-field>

              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>Operator</mat-label>
                <select matNativeControl formControlName="operator">
                  @for (op of operators; track op) {
                    <option [value]="op">{{ operatorLabels[op] }}</option>
                  }
                </select>
              </mat-form-field>

              <!-- these two fields change with the metric: unit, hint and limits come from METRIC_FIELDS -->
              <mat-form-field appearance="outline">
                <mat-label>Critical threshold ({{ field.unit }})</mat-label>
                <input
                  matInput
                  type="number"
                  formControlName="threshold"
                  [attr.min]="field.min"
                  [attr.max]="field.max"
                  [attr.step]="field.step"
                />
                <mat-hint>{{ field.hint }}</mat-hint>
                <mat-error>{{ message(group.controls.threshold.errors) }}</mat-error>
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Warning threshold ({{ field.unit }}), optional</mat-label>
                <input
                  matInput
                  type="number"
                  formControlName="warningThreshold"
                  [attr.min]="field.min"
                  [attr.max]="field.max"
                  [attr.step]="field.step"
                />
                <mat-hint>Reached before the critical threshold</mat-hint>
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>For at least (seconds)</mat-label>
                <input matInput type="number" formControlName="durationSec" min="0" step="1" />
                <mat-hint>How long it must hold</mat-hint>
                <mat-error>{{ message(group.controls.durationSec.errors) }}</mat-error>
              </mat-form-field>

              <button
                mat-button
                type="button"
                class="condition__remove"
                [disabled]="f.controls.conditions.length === 1"
                (click)="removeCondition(i)"
                [attr.aria-label]="'Remove condition ' + (i + 1)"
              >
                Remove
              </button>

              @if (group.touched || group.dirty) {
                @for (text of groupMessages(group); track text) {
                  <p class="condition__error" role="alert">{{ text }}</p>
                }
              }
            </div>
          }

          @if (
            f.controls.conditions.errors?.['duplicateCondition'] &&
            (f.controls.conditions.dirty || f.touched)
          ) {
            <p class="condition__error" role="alert">
              Two conditions use the same metric and operator. Remove one.
            </p>
          }
          <button mat-stroked-button type="button" (click)="addCondition()">Add condition</button>
        </fieldset>

        <div class="actions">
          <button mat-flat-button type="submit" [disabled]="f.pending">
            {{ id() ? 'Save changes' : 'Create rule' }}
          </button>
          <a mat-button routerLink="/rules">Cancel</a>
        </div>
      </form>
    } @else if (notFound()) {
      <p role="alert">This rule does not exist (any more).</p>
    } @else {
      <p>Loading rule…</p>
    }
  `,
})
export class RuleFormPage implements HasUnsavedChanges {
  /** Route parameter; absent on /rules/new. */
  readonly id = input<string>();

  private readonly store = inject(RulesStore);
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly debounceMs = inject(APP_CONFIG).ui.nameCheckDebounceMs;

  protected readonly metrics = METRICS;
  protected readonly operators = OPERATORS;
  protected readonly fields = METRIC_FIELDS;
  protected readonly operatorLabels = OPERATOR_LABELS;
  protected readonly message = controlMessage;
  protected readonly groupMessages = conditionMessages;

  protected readonly form = signal<RuleForm | null>(null);
  protected readonly notFound = computed(
    () =>
      !!this.id() && this.store.loadState() === 'ready' && !this.store.find(this.id() as string),
  );
  private submitted = false;

  constructor() {
    // build the form once the rule it edits is known (a direct visit to /rules/:id has to load the rules first)
    effect(() => {
      const id = this.id();
      const state = this.store.loadState();
      untracked(() => {
        if (this.form()) return;
        if (!id) return this.form.set(this.build(null));
        if (state === 'idle') this.store.load();
        const rule = this.store.find(id);
        if (rule && !rule.pending) this.form.set(this.build(rule));
      });
    });
  }

  hasUnsavedChanges(): boolean {
    return !this.submitted && (this.form()?.dirty ?? false);
  }

  protected onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.hasUnsavedChanges()) event.preventDefault(); // the browser asks before the tab closes
  }

  protected nameError(): string | null {
    return controlMessage(this.form()?.controls.name.errors ?? null);
  }

  protected addCondition(): void {
    const form = this.form();
    if (!form) return;
    form.controls.conditions.push(createConditionGroup());
    form.markAsDirty();
    const index = form.controls.conditions.length - 1;
    afterNextRender(() => document.getElementById(`cond-${index}-metric`)?.focus(), {
      injector: this.injector,
    });
  }

  protected removeCondition(index: number): void {
    const form = this.form();
    if (!form || form.controls.conditions.length === 1) return;
    form.controls.conditions.removeAt(index);
    form.markAsDirty();
  }

  protected submit(): void {
    const form = this.form();
    if (!form) return;
    form.markAllAsTouched();
    if (form.pending) {
      // the name check is still running: wait for its answer instead of ignoring the click
      form.statusChanges
        .pipe(
          filter((status) => status !== 'PENDING'),
          take(1),
          takeUntilDestroyed(this.destroyRef), // leaving the page cancels the wait
        )
        .subscribe(() => this.submit());
      return;
    }
    if (form.invalid) {
      // put the keyboard user on the first problem
      afterNextRender(
        () =>
          document
            .querySelector<HTMLElement>(
              '.rule-form .ng-invalid:not(form):not(fieldset):not([role="group"])',
            )
            ?.focus(),
        { injector: this.injector },
      );
      return;
    }

    const draft = toRuleDraft(form);
    const id = this.id();
    this.submitted = true; // the form is saved: leaving it must not ask
    form.markAsPristine();
    // Optimistic: the list shows the rule at once. If the server rejects it, the list rolls back and says why.
    if (id) this.store.update(id, draft);
    else this.store.create(draft);
    void this.router.navigate(['/rules']);
  }

  private build(rule: AlertRule | null): RuleForm {
    const form = createRuleForm(
      rule,
      uniqueRuleName({
        api: this.api,
        debounceMs: this.debounceMs,
        excludeId: () => rule?.id ?? null,
        originalName: () => rule?.name ?? null,
      }),
    );
    // zoneless + OnPush: async validator results and programmatic changes are not template events, so say so
    form.events.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cdr.markForCheck());
    return form;
  }
}
