import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { toApiFailure } from '../../core/http/api-error';

/** Only same-app paths are accepted as a return target (no open redirect). */
export function safeReturnUrl(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/fleet';
}

@Component({
  selector: 'fp-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule],
  styleUrl: './login.page.scss',
  template: `
    <main class="login">
      <form class="login__card" [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <h1>Fleet Pulse</h1>
        <p class="login__hint">Sign in to the ops console</p>

        <mat-form-field appearance="outline">
          <mat-label>Email</mat-label>
          <input matInput type="email" formControlName="email" autocomplete="username" />
          @if (form.controls.email.touched && form.controls.email.errors; as errors) {
            <mat-error>{{
              errors['required'] ? 'Email is required' : 'Enter a valid email address'
            }}</mat-error>
          }
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Password</mat-label>
          <input
            matInput
            type="password"
            formControlName="password"
            autocomplete="current-password"
          />
          @if (form.controls.password.touched && form.controls.password.errors; as errors) {
            <mat-error>{{
              errors['required'] ? 'Password is required' : 'At least 6 characters'
            }}</mat-error>
          }
        </mat-form-field>

        @if (serverError(); as message) {
          <p class="login__error" role="alert">{{ message }}</p>
        }

        <button mat-flat-button type="submit" [disabled]="form.invalid || pending()">
          {{ pending() ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
    </main>
  `,
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly pending = signal(false);
  readonly serverError = signal<string | null>(null);

  readonly form = inject(FormBuilder).nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(6)]],
  });

  submit(): void {
    if (this.form.invalid || this.pending()) return;
    this.pending.set(true);
    this.serverError.set(null);
    const { email, password } = this.form.getRawValue();

    this.auth.login(email, password).subscribe({
      next: () =>
        void this.router.navigateByUrl(
          safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl')),
        ),
      error: (err: unknown) => {
        const failure = toApiFailure(err);
        this.serverError.set(
          failure.code === 'invalid_credentials' ? 'Invalid email or password.' : failure.message,
        );
        this.pending.set(false);
      },
    });
  }
}
