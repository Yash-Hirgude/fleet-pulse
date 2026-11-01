import {
  AsyncValidatorFn,
  FormArray,
  FormControl,
  FormGroup,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import {
  Condition,
  Metric,
  METRIC_FIELDS,
  Operator,
  RuleDraft,
} from '../../core/rules/rules.models';
import {
  notBlank,
  noDuplicateConditions,
  thresholdInMetricRange,
  warningBeforeCritical,
  wholeSeconds,
} from './rule-validators';

export type ConditionGroup = FormGroup<{
  metric: FormControl<Metric>;
  operator: FormControl<Operator>;
  threshold: FormControl<number | null>;
  warningThreshold: FormControl<number | null>;
  durationSec: FormControl<number | null>;
}>;

export type RuleForm = FormGroup<{
  name: FormControl<string>;
  conditions: FormArray<ConditionGroup>;
}>;

export function createConditionGroup(c?: Partial<Condition>): ConditionGroup {
  return new FormGroup(
    {
      metric: new FormControl<Metric>(c?.metric ?? 'p95', { nonNullable: true }),
      operator: new FormControl<Operator>(c?.operator ?? '>', { nonNullable: true }),
      threshold: new FormControl<number | null>(c?.threshold ?? null, [Validators.required]),
      warningThreshold: new FormControl<number | null>(c?.warningThreshold ?? null),
      durationSec: new FormControl<number | null>(c?.durationSec ?? 60, [
        Validators.required,
        wholeSeconds,
      ]),
    },
    { validators: [thresholdInMetricRange, warningBeforeCritical] },
  );
}

export function createRuleForm(
  rule: { name: string; conditions: readonly Condition[] } | null,
  nameCheck: AsyncValidatorFn,
): RuleForm {
  const conditions = rule?.conditions.length
    ? rule.conditions.map((c) => createConditionGroup(c))
    : [createConditionGroup()];
  return new FormGroup({
    name: new FormControl(rule?.name ?? '', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(100), notBlank],
      asyncValidators: [nameCheck],
    }),
    conditions: new FormArray(conditions, {
      validators: [Validators.minLength(1), noDuplicateConditions],
    }),
  });
}

/** Form value -> request body. The warning level is only sent when it is set. */
export function toRuleDraft(form: RuleForm): RuleDraft {
  const raw = form.getRawValue();
  return {
    name: raw.name.trim(),
    conditions: raw.conditions.map((c) => ({
      metric: c.metric,
      operator: c.operator,
      threshold: c.threshold as number,
      durationSec: c.durationSec as number,
      ...(c.warningThreshold === null ? {} : { warningThreshold: c.warningThreshold }),
    })),
  };
}

/** Human text for the first error of a control, or null. */
export function controlMessage(errors: ValidationErrors | null): string | null {
  if (!errors) return null;
  if (errors['required']) return 'This field is required.';
  if (errors['blank']) return 'The name cannot be only spaces.';
  if (errors['maxlength']) return 'At most 100 characters.';
  if (errors['nameTaken']) return 'A rule with this name already exists.';
  if (errors['wholeSeconds']) return 'Enter a whole number of seconds, 0 to 86,400.';
  return 'This value is not valid.';
}

/** Human text for the cross-field errors of a condition (shown under the row). */
export function conditionMessages(group: ConditionGroup): string[] {
  const e = group.errors;
  if (!e) return [];
  const out: string[] = [];
  const metric = METRIC_FIELDS[group.controls.metric.value];
  if (e['thresholdRange'])
    out.push(`Threshold must be between ${metric.min} and ${metric.max} ${metric.unit}.`);
  if (e['warningRange'])
    out.push(`Warning level must be between ${metric.min} and ${metric.max} ${metric.unit}.`);
  if (e['warningOrder']) {
    out.push(
      `The warning level must be ${(e['warningOrder'] as { expected: string }).expected} than the critical threshold.`,
    );
  }
  return out;
}
