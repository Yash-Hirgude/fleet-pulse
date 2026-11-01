import {
  AbstractControl,
  AsyncValidatorFn,
  FormArray,
  ValidationErrors,
  ValidatorFn,
} from '@angular/forms';
import { Observable, catchError, map, of, switchMap, timer } from 'rxjs';
import { ApiClient } from '../../core/http/api-client';
import { METRIC_FIELDS, Metric, Operator } from '../../core/rules/rules.models';

/** CUSTOM 1 (control): a name made only of spaces is not a name. */
export const notBlank: ValidatorFn = (control) =>
  typeof control.value === 'string' && control.value.length > 0 && control.value.trim() === ''
    ? { blank: true }
    : null;

/** CUSTOM 2 (control): a duration is a whole number of seconds, 0 to 24 h. */
export const wholeSeconds: ValidatorFn = (control) => {
  const v = control.value as number | null;
  if (v === null || v === undefined) return null; // `required` reports an empty field
  return Number.isInteger(v) && v >= 0 && v <= 86_400 ? null : { wholeSeconds: true };
};

/**
 * CUSTOM 3 (cross-field: metric + threshold + warning): the allowed range depends on the chosen metric.
 * Error rate is a percentage from 0 to 100; latency is in milliseconds. Changing the metric re-runs this.
 */
export const thresholdInMetricRange: ValidatorFn = (group) => {
  const metric = group.get('metric')?.value as Metric | undefined;
  if (!metric) return null;
  const field = METRIC_FIELDS[metric];
  const errors: Record<string, unknown> = {};
  for (const name of ['threshold', 'warningThreshold'] as const) {
    const v = group.get(name)?.value as number | null | undefined;
    if (v === null || v === undefined) continue;
    if (!Number.isFinite(v) || v < field.min || v > field.max) {
      errors[name === 'threshold' ? 'thresholdRange' : 'warningRange'] = {
        min: field.min,
        max: field.max,
        unit: field.unit,
      };
    }
  }
  return Object.keys(errors).length > 0 ? errors : null;
};

/**
 * CUSTOM 4 (cross-field: operator + warning + critical): the warning level must be reached before the critical
 * one. For > and >= that means warning < threshold; for < and <= it means warning > threshold.
 */
export const warningBeforeCritical: ValidatorFn = (group) => {
  const warning = group.get('warningThreshold')?.value as number | null | undefined;
  const critical = group.get('threshold')?.value as number | null | undefined;
  const operator = group.get('operator')?.value as Operator | undefined;
  if (
    warning === null ||
    warning === undefined ||
    critical === null ||
    critical === undefined ||
    !operator
  )
    return null;
  const rising = operator === '>' || operator === '>=';
  const ok = rising ? warning < critical : warning > critical;
  return ok ? null : { warningOrder: { expected: rising ? 'lower' : 'higher' } };
};

/** CUSTOM 5 (cross-row): two conditions on the same metric and operator are redundant. */
export const noDuplicateConditions: ValidatorFn = (array) => {
  const seen = new Set<string>();
  for (const control of (array as FormArray).controls) {
    const key = `${control.get('metric')?.value}|${control.get('operator')?.value}`;
    if (seen.has(key)) return { duplicateCondition: true };
    seen.add(key);
  }
  return null;
};

export interface UniqueNameOptions {
  readonly api: ApiClient;
  readonly debounceMs: number;
  /** Rule being edited, so it does not clash with itself. */
  readonly excludeId: () => string | null;
  /** Current saved name: re-typing it is not a conflict. */
  readonly originalName: () => string | null;
}

/**
 * ASYNC: asks GET /rules/check-name while the user types. The timer debounces; Angular unsubscribes the previous
 * validation whenever the value changes again, which also cancels the request in flight, so only the latest
 * keystroke is ever checked. A failing check does not block the form (the server still answers 409 on save).
 */
export function uniqueRuleName(opts: UniqueNameOptions): AsyncValidatorFn {
  return (control: AbstractControl): Observable<ValidationErrors | null> => {
    const name = typeof control.value === 'string' ? control.value.trim() : '';
    if (!name) return of(null);
    if (opts.originalName()?.toLowerCase() === name.toLowerCase()) return of(null);

    const excludeId = opts.excludeId();
    return timer(opts.debounceMs).pipe(
      switchMap(() =>
        opts.api.get<{ available: boolean }>(
          '/rules/check-name',
          excludeId ? { name, excludeId } : { name },
        ),
      ),
      map((res) => (res.available ? null : { nameTaken: true })),
      catchError(() => of(null)),
    );
  };
}
