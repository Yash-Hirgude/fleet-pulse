import { MetricEvent } from '../stream/stream.models';
import { AlertRule, Condition, compare } from '../rules/rules.models';

export type Severity = 'warning' | 'critical';

export interface Incident {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly serviceId: string;
  readonly severity: Severity;
  /** Event time at which the rule's conditions had held long enough. */
  readonly firedAt: number;
  readonly resolvedAt: number | null;
  /** Metrics of the event that fired (or last escalated) it. */
  readonly p95: number;
  readonly errRate: number;
  readonly rps: number;
}

export type EngineChange =
  | { readonly kind: 'fired'; readonly incident: Incident }
  | { readonly kind: 'escalated'; readonly incident: Incident }
  | { readonly kind: 'updated'; readonly incident: Incident }
  | { readonly kind: 'resolved'; readonly incident: Incident };

type Level = 0 | 1 | 2; // ok, warning, critical

/** For one condition of one rule on one service: since when has each level been continuously true? */
interface ConditionState {
  critSince: number | null;
  warnSince: number | null;
}

interface ServiceState {
  conditions: ConditionState[];
  incident: Incident | null;
}

interface Runtime {
  readonly rule: AlertRule;
  readonly services: Map<string, ServiceState>;
}

/**
 * Evaluates alert rules against the live stream. No Angular, no timers: it only reacts to events, so it is
 * deterministic and easy to test.
 *
 * Semantics:
 *  - a rule applies to every service, and is evaluated per (rule, service);
 *  - a condition is "met" once its comparison has been true on consecutive events for at least `durationSec`
 *    (measured with event timestamps); one event where it is false starts the clock over;
 *  - a rule fires when ALL its conditions are met. With a warning threshold, a condition has two levels and the rule
 *    is as severe as its least severe condition;
 *  - one incident per (rule, service) at a time: while it is open the rule does not fire again, it can only
 *    escalate (warning -> critical), de-escalate, or resolve. After it resolves, a new breach is a new incident.
 */
export class RuleEngine {
  private readonly runtimes = new Map<string, Runtime>();
  private counter = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Replaces the rule set. A removed or edited rule closes its open incidents; an edited rule starts from a
   * clean state (the old durations belonged to the old conditions).
   */
  setRules(rules: readonly AlertRule[]): EngineChange[] {
    const changes: EngineChange[] = [];
    const byId = new Map(rules.map((r) => [r.id, r]));

    for (const [id, runtime] of this.runtimes) {
      const next = byId.get(id);
      if (next && next.updatedAt === runtime.rule.updatedAt) continue;
      for (const state of runtime.services.values()) {
        if (state.incident)
          changes.push({ kind: 'resolved', incident: this.close(state.incident, this.now()) });
      }
      this.runtimes.delete(id);
    }
    for (const rule of rules) {
      if (!this.runtimes.has(rule.id)) this.runtimes.set(rule.id, { rule, services: new Map() });
    }
    return changes;
  }

  evaluate(event: MetricEvent): EngineChange[] {
    const changes: EngineChange[] = [];
    for (const runtime of this.runtimes.values()) this.evaluateRule(runtime, event, changes);
    return changes;
  }

  reset(): void {
    this.runtimes.clear();
  }

  private evaluateRule(runtime: Runtime, event: MetricEvent, changes: EngineChange[]): void {
    const { rule, services } = runtime;
    let state = services.get(event.serviceId);
    if (!state) {
      state = {
        conditions: rule.conditions.map(() => ({ critSince: null, warnSince: null })),
        incident: null,
      };
    }

    // the rule is as severe as its least severe condition
    let level: Level = 2;
    for (let i = 0; i < rule.conditions.length; i++) {
      level = Math.min(
        level,
        this.levelOf(rule.conditions[i], state.conditions[i], event),
      ) as Level;
    }

    const open = state.incident;
    if (level === 0) {
      if (open) {
        changes.push({ kind: 'resolved', incident: this.close(open, event.ts) });
        state.incident = null;
      }
    } else {
      const severity: Severity = level === 2 ? 'critical' : 'warning';
      if (!open) {
        state.incident = this.open(rule, event, severity);
        changes.push({ kind: 'fired', incident: state.incident });
      } else if (open.severity !== severity) {
        state.incident = {
          ...open,
          severity,
          p95: event.p95,
          errRate: event.errRate,
          rps: event.rps,
        };
        changes.push({
          kind: severity === 'critical' ? 'escalated' : 'updated',
          incident: state.incident,
        });
      }
    }

    // keep the map small: a service with nothing in progress needs no state
    const idle =
      state.incident === null &&
      state.conditions.every((c) => c.critSince === null && c.warnSince === null);
    if (idle) services.delete(event.serviceId);
    else services.set(event.serviceId, state);
  }

  private levelOf(condition: Condition, state: ConditionState, event: MetricEvent): Level {
    const value = event[condition.metric];
    const critHolds = compare(value, condition.operator, condition.threshold);
    const warnHolds =
      critHolds ||
      (condition.warningThreshold !== undefined &&
        compare(value, condition.operator, condition.warningThreshold));

    state.critSince = critHolds ? (state.critSince ?? event.ts) : null;
    state.warnSince = warnHolds ? (state.warnSince ?? event.ts) : null;

    const needed = condition.durationSec * 1000;
    if (state.critSince !== null && event.ts - state.critSince >= needed) return 2;
    if (state.warnSince !== null && event.ts - state.warnSince >= needed) return 1;
    return 0;
  }

  private open(rule: AlertRule, event: MetricEvent, severity: Severity): Incident {
    return {
      id: `inc-${++this.counter}`,
      ruleId: rule.id,
      ruleName: rule.name,
      serviceId: event.serviceId,
      severity,
      firedAt: event.ts,
      resolvedAt: null,
      p95: event.p95,
      errRate: event.errRate,
      rps: event.rps,
    };
  }

  private close(incident: Incident, at: number): Incident {
    return { ...incident, resolvedAt: at };
  }
}
