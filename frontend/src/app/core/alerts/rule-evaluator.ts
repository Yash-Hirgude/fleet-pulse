import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { APP_CONFIG } from '../config/app-config';
import { RulesStore } from '../rules/rules.store';
import { MetricsStore } from '../stream/metrics-store';
import { AlertNotifier } from './alert-notifier';
import { EngineChange, Incident, RuleEngine } from './rule-engine';

/**
 * Connects the engine to the app: feeds it every stream event, follows the confirmed rules, keeps the incident
 * list the panel shows, and raises notifications.
 */
@Injectable({ providedIn: 'root' })
export class RuleEvaluator {
  private readonly metrics = inject(MetricsStore);
  private readonly rules = inject(RulesStore);
  private readonly notifier = inject(AlertNotifier);
  private readonly maxIncidents = inject(APP_CONFIG).ui.maxIncidents;
  private readonly engine = new RuleEngine();
  private unlisten: (() => void) | null = null;

  /** Newest first: open incidents and recently resolved ones. */
  readonly incidents = signal<readonly Incident[]>([]);
  readonly openCount = computed(() => this.incidents().filter((i) => i.resolvedAt === null).length);
  readonly panelOpen = signal(false);

  constructor() {
    // Only server-confirmed rules are evaluated: an unconfirmed edit must not change what fires.
    effect(() => {
      const rules = this.rules.confirmed();
      untracked(() => this.apply(this.engine.setRules(rules)));
    });
  }

  start(): void {
    if (this.unlisten) return;
    this.unlisten = this.metrics.onEvent((event) => {
      const changes = this.engine.evaluate(event);
      if (changes.length > 0) this.apply(changes);
    });
  }

  stop(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.engine.reset();
    this.incidents.set([]);
    this.panelOpen.set(false);
  }

  clearResolved(): void {
    this.incidents.update((list) => list.filter((i) => i.resolvedAt === null));
  }

  private apply(changes: readonly EngineChange[]): void {
    if (changes.length === 0) return;
    let list = [...this.incidents()];
    for (const change of changes) {
      const { incident } = change;
      if (change.kind === 'fired') {
        list.unshift(incident);
        this.notifier.notify(incident, false, () => this.panelOpen.set(true));
      } else {
        list = list.map((i) => (i.id === incident.id ? incident : i));
        if (change.kind === 'escalated')
          this.notifier.notify(incident, true, () => this.panelOpen.set(true));
      }
    }
    if (list.length > this.maxIncidents) {
      // drop the oldest resolved ones first; open incidents are only dropped if there is nothing else left
      const open = list.filter((i) => i.resolvedAt === null);
      const resolved = list
        .filter((i) => i.resolvedAt !== null)
        .slice(0, Math.max(0, this.maxIncidents - open.length));
      list = [...open, ...resolved]
        .sort((a, b) => b.firedAt - a.firedAt)
        .slice(0, this.maxIncidents);
    }
    this.incidents.set(list);
  }
}
