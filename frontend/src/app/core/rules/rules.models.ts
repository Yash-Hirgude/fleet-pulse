export type Metric = 'p95' | 'errRate' | 'rps';
export type Operator = '>' | '>=' | '<' | '<=';

export const METRICS: readonly Metric[] = ['p95', 'errRate', 'rps'];
export const OPERATORS: readonly Operator[] = ['>', '>=', '<', '<='];

/** A condition. `warningThreshold` is our own extra field: the mock stores unknown fields unchanged. */
export interface Condition {
  readonly metric: Metric;
  readonly operator: Operator;
  readonly threshold: number;
  readonly durationSec: number;
  readonly warningThreshold?: number;
}

export interface AlertRule {
  readonly id: string;
  readonly name: string;
  readonly conditions: readonly Condition[];
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Client-only: the save has not been confirmed by the server yet. Never sent. */
  readonly pending?: boolean;
}

/** What the form produces and what is sent to the server. */
export interface RuleDraft {
  readonly name: string;
  readonly conditions: readonly Condition[];
}

/** Per-metric behaviour of the condition form: this is what makes its fields dynamic. */
export interface MetricField {
  readonly label: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly hint: string;
}

export const METRIC_FIELDS: Record<Metric, MetricField> = {
  p95: {
    label: 'p95 latency',
    unit: 'ms',
    min: 0,
    max: 60_000,
    step: 1,
    hint: 'Milliseconds, 0 to 60,000',
  },
  errRate: {
    label: 'Error rate',
    unit: '%',
    min: 0,
    max: 100,
    step: 0.1,
    hint: 'Percentage, 0 to 100',
  },
  rps: {
    label: 'Requests per second',
    unit: 'req/s',
    min: 0,
    max: 1_000_000,
    step: 1,
    hint: 'Requests per second, 0 or more',
  },
};

export function compare(value: number, operator: Operator, threshold: number): boolean {
  switch (operator) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    default:
      return value <= threshold;
  }
}

export function describeCondition(c: Condition): string {
  const f = METRIC_FIELDS[c.metric];
  const warning =
    c.warningThreshold === undefined ? '' : `, warning at ${c.warningThreshold} ${f.unit}`;
  return `${f.label} ${c.operator} ${c.threshold} ${f.unit} for ${c.durationSec} s${warning}`;
}
