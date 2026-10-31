import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatToolbarModule } from '@angular/material/toolbar';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { StreamService } from '../../core/stream/stream.service';
import { ConnectionStatus } from './connection-status';

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
      <span class="toolbar__user">{{ auth.user()?.email }} ({{ auth.role() }})</span>
      <button mat-stroked-button type="button" (click)="auth.logout()">Sign out</button>
    </mat-toolbar>
    <main class="content"><router-outlet /></main>
  `,
})
export class Shell {
  protected readonly auth = inject(AuthService);

  constructor() {
    // The stream lives exactly as long as the signed-in shell does.
    const stream = inject(StreamService);
    stream.start();
    inject(DestroyRef).onDestroy(() => stream.stop());
  }
}