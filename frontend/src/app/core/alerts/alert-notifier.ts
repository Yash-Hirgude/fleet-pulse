import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { APP_CONFIG } from '../config/app-config';
import { Incident } from './rule-engine';
import { SettingsService } from './settings.service';

interface Pending {
  readonly incident: Incident;
  readonly escalated: boolean;
}

/**
 * Raises the "an alert fired" notification. A burst (a hundred services breaching in the same second) becomes
 * ONE message instead of a hundred snackbars.
 */
@Injectable({ providedIn: 'root' })
export class AlertNotifier {
  private readonly snackBar = inject(MatSnackBar);
  private readonly settings = inject(SettingsService);
  private readonly batchMs = inject(APP_CONFIG).ui.notificationBatchMs;

  private pending: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  notify(incident: Incident, escalated: boolean, onView: () => void): void {
    if (!this.settings.settings().notifyOnFiring) return;
    this.pending.push({ incident, escalated });
    this.timer ??= setTimeout(() => this.flush(onView), this.batchMs);
  }

  private flush(onView: () => void): void {
    const batch = this.pending;
    this.pending = [];
    this.timer = null;
    if (batch.length === 0) return;

    const first = batch[0];
    const message =
      batch.length === 1
        ? `${first.incident.ruleName} ${first.escalated ? 'escalated to critical' : 'fired'} on ${first.incident.serviceId}`
        : `${batch.length} alerts fired, for example ${first.incident.ruleName} on ${first.incident.serviceId}`;
    this.snackBar
      .open(message, 'View', {
        duration: this.settings.settings().notificationSeconds * 1000,
        politeness: 'assertive',
      })
      .onAction()
      .subscribe(onView);
  }
}
