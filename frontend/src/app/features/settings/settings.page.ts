import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule, NgForm } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { SettingsService } from '../../core/alerts/settings.service';

/**
 * The Template-driven Form of the app (the rule form is Reactive), so both styles are used:
 * the model lives in the template through ngModel and validation comes from attributes.
 */
@Component({
  selector: 'fp-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatCheckboxModule, MatFormFieldModule, MatInputModule, MatButtonModule],
  template: `
    <h1>Settings</h1>
    <form #settingsForm="ngForm" (ngSubmit)="save(settingsForm)" novalidate class="settings">
      <mat-checkbox name="notifyOnFiring" [(ngModel)]="model.notifyOnFiring">
        Show a notification when an alert fires
      </mat-checkbox>

      <mat-form-field appearance="outline">
        <mat-label>Notification duration (seconds)</mat-label>
        <input
          matInput
          type="number"
          name="notificationSeconds"
          required
          min="2"
          max="30"
          [(ngModel)]="model.notificationSeconds"
          #seconds="ngModel"
        />
        <mat-hint>Between 2 and 30 seconds</mat-hint>
        @if (seconds.errors?.['required']) {
          <mat-error>Enter a number of seconds.</mat-error>
        } @else if (seconds.errors?.['min'] || seconds.errors?.['max']) {
          <mat-error>It must be between 2 and 30.</mat-error>
        }
      </mat-form-field>

      <div class="actions">
        <button mat-flat-button type="submit" [disabled]="settingsForm.invalid">
          Save settings
        </button>
        @if (saved()) {
          <span role="status">Settings saved.</span>
        }
      </div>
    </form>
  `,
  styles: `
    .settings {
      display: grid;
      gap: 1rem;
      max-width: 28rem;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
  `,
})
export class SettingsPage {
  private readonly settings = inject(SettingsService);

  protected readonly model = { ...this.settings.settings() };
  protected readonly saved = signal(false);

  protected save(form: NgForm): void {
    if (form.invalid) return;
    this.settings.save(this.model);
    this.saved.set(true);
  }
}
