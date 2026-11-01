import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatToolbarModule } from '@angular/material/toolbar';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { RuleEvaluator } from '../../core/alerts/rule-evaluator';
import { AuthService } from '../../core/auth/auth.service';
import { RulesStore } from '../../core/rules/rules.store';
import { StreamService } from '../../core/stream/stream.service';
import { ConnectionStatus } from './connection-status';
import { IncidentPanel } from './incident-panel';

@Component({
  selector: 'fp-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatToolbarModule,
    MatButtonModule,
    ConnectionStatus,
    IncidentPanel,
  ],
  styleUrl: './shell.scss',
  template: `
    <mat-toolbar class="toolbar">
      <a class="toolbar__brand" routerLink="/fleet">Fleet Pulse</a>
      <nav class="toolbar__nav" aria-label="Main">
        <a mat-button routerLink="/fleet" routerLinkActive="is-active">Fleet</a>
        @if (auth.isOperator()) {
          <a mat-button routerLink="/rules" routerLinkActive="is-active">Rules</a>
        }
        <a mat-button routerLink="/settings" routerLinkActive="is-active">Settings</a>
      </nav>
      <span class="toolbar__spacer"></span>
      <fp-connection-status />
      <button
        mat-stroked-button
        type="button"
        class="toolbar__incidents"
        aria-controls="incident-panel"
        [attr.aria-expanded]="evaluator.panelOpen()"
        (click)="evaluator.panelOpen.set(!evaluator.panelOpen())"
      >
        Incidents
        @if (evaluator.openCount() > 0) {
          <span class="toolbar__badge" [attr.aria-label]="evaluator.openCount() + ' open'">{{
            evaluator.openCount()
          }}</span>
        }
      </button>
      <span class="toolbar__user">{{ auth.user()?.email }} ({{ auth.role() }})</span>
      <button mat-stroked-button type="button" (click)="auth.logout()">Sign out</button>
    </mat-toolbar>
    <main class="content"><router-outlet /></main>
    @if (evaluator.panelOpen()) {
      <fp-incident-panel id="incident-panel" />
    }
  `,
})
export class Shell {
  protected readonly auth = inject(AuthService);
  protected readonly evaluator = inject(RuleEvaluator);

  constructor() {
    // The stream, the rules and the alert evaluation live exactly as long as the signed-in shell does.
    const stream = inject(StreamService);
    const rules = inject(RulesStore);
    stream.start();
    rules.load();
    this.evaluator.start();
    inject(DestroyRef).onDestroy(() => {
      this.evaluator.stop();
      rules.reset();
      stream.stop();
    });
  }
}
