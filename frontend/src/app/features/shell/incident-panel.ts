import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { RuleEvaluator } from '../../core/alerts/rule-evaluator';
import { AuthService } from '../../core/auth/auth.service';
import { RulesStore } from '../../core/rules/rules.store';
import { StreamService } from '../../core/stream/stream.service';

/** Side panel listing the incidents raised by the alert rules. Viewers see it too; only operators get "Edit rule". */
@Component({
  selector: 'fp-incident-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatButtonModule],
  styleUrl: './incident-panel.scss',
  host: { '(keydown.escape)': 'close()' },
  template: `
    <aside class="panel" aria-labelledby="incident-title">
      <header class="panel__head">
        <h2 id="incident-title">Incidents</h2>
        <button mat-button type="button" (click)="close()">Close</button>
      </header>

      @if (rules.loadState() === 'error') {
        <p class="panel__warn" role="alert">
          The alert rules could not be loaded, so nothing is being evaluated right now.
          <button mat-stroked-button type="button" (click)="rules.load()">Retry</button>
        </p>
      }

      <p class="panel__summary" role="status">{{ evaluator.openCount() }} open</p>

      @if (evaluator.incidents().length === 0) {
        <p>No incidents. Alerts appear here when a rule fires.</p>
      } @else {
        <ul class="list">
          @for (incident of evaluator.incidents(); track incident.id) {
            <li class="item" [class.is-resolved]="incident.resolvedAt !== null">
              <span class="sev" [attr.data-severity]="incident.severity">{{
                incident.severity
              }}</span>
              <div>
                <strong>{{ incident.ruleName }}</strong> on
                <a [routerLink]="['/services', incident.serviceId]" (click)="close()">{{
                  serviceName(incident.serviceId)
                }}</a>
                <div class="item__meta">
                  {{ incident.resolvedAt === null ? 'Open since' : 'Resolved after' }}
                  {{
                    incident.resolvedAt === null
                      ? time(incident.firedAt)
                      : duration(incident.firedAt, incident.resolvedAt)
                  }}
                  · p95 {{ incident.p95 }} ms · errors {{ incident.errRate }} % ·
                  {{ incident.rps }} req/s
                </div>
                @if (auth.isOperator()) {
                  <a [routerLink]="['/rules', incident.ruleId]" (click)="close()">Edit rule</a>
                }
              </div>
            </li>
          }
        </ul>
        <button mat-stroked-button type="button" (click)="evaluator.clearResolved()">
          Clear resolved
        </button>
      }
    </aside>
  `,
})
export class IncidentPanel {
  protected readonly evaluator = inject(RuleEvaluator);
  protected readonly rules = inject(RulesStore);
  protected readonly auth = inject(AuthService);
  private readonly stream = inject(StreamService);

  protected close(): void {
    this.evaluator.panelOpen.set(false);
  }

  protected serviceName(id: string): string {
    return this.stream.store.row(id)?.name ?? id;
  }

  protected time(ts: number): string {
    return new Date(ts).toLocaleTimeString();
  }

  protected duration(from: number, to: number): string {
    const seconds = Math.max(0, Math.round((to - from) / 1000));
    return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  }
}
