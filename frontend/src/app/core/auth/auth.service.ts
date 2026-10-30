import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  Observable,
  Subject,
  finalize,
  firstValueFrom,
  map,
  of,
  shareReplay,
  tap,
  throwError,
  catchError,
} from 'rxjs';
import { APP_CONFIG } from '../config/app-config';
import { SKIP_AUTH } from '../http/http-context';
import { AuthResponse, AuthUser } from './auth.models';

const REFRESH_TOKEN_KEY = 'fleet-pulse.refresh-token';
const AUTH_REJECTION_STATUSES = [400, 401, 403];

/**
 * Owns the session. The access token lives in a private field (memory only, never in storage, never in a signal
 * that templates could read). The refresh token is kept in sessionStorage so a reload restores the session.
 * Production would use an httpOnly cookie for it instead.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly baseUrl = inject(APP_CONFIG).api.baseUrl;

  private accessTokenValue: string | null = null;
  private refreshInFlight$: Observable<string> | null = null;
  private redirecting = false;
  private readonly sessionEndedSubject = new Subject<void>();
  private readonly userState = signal<AuthUser | null>(null);

  readonly user = this.userState.asReadonly();
  readonly isAuthenticated = computed(() => this.userState() !== null);
  readonly role = computed(() => this.userState()?.role ?? null);
  readonly isOperator = computed(() => this.role() === 'operator');

  /** Emits when the session ends. In-flight requests and the stream stop on it. */
  readonly sessionEnded$ = this.sessionEndedSubject.asObservable();

  accessToken(): string | null {
    return this.accessTokenValue;
  }

  login(email: string, password: string): Observable<AuthUser> {
    return this.http
      .post<AuthResponse>(
        `${this.baseUrl}/auth/login`,
        { email, password },
        { context: new HttpContext().set(SKIP_AUTH, true) },
      )
      .pipe(
        tap((res) => this.applySession(res)),
        map((res) => res.user),
      );
  }

  /** Called at startup: turns a stored refresh token back into a session. Never throws. */
  async restoreSession(): Promise<void> {
    if (!this.readRefreshToken()) return;
    try {
      await firstValueFrom(this.refresh());
    } catch {
      /* stay logged out; the guards send the user to /login */
    }
  }

  /**
   * Single flight: however many callers ask while a refresh is running, exactly one POST /auth/refresh goes out
   * and all callers get its result.
   */
  refresh(): Observable<string> {
    if (this.refreshInFlight$) return this.refreshInFlight$;
    const refreshToken = this.readRefreshToken();
    if (!refreshToken) return throwError(() => new Error('no refresh token'));

    this.refreshInFlight$ = this.http
      .post<AuthResponse>(
        `${this.baseUrl}/auth/refresh`,
        { refreshToken },
        { context: new HttpContext().set(SKIP_AUTH, true) },
      )
      .pipe(
        tap((res) => this.applySession(res)),
        map((res) => res.accessToken),
        catchError((err: unknown) => {
          // Only a rejection from the server ends the session. A network error while offline must not log anyone out.
          if (err instanceof HttpErrorResponse && AUTH_REJECTION_STATUSES.includes(err.status))
            this.clearSession();
          return throwError(() => err);
        }),
        finalize(() => (this.refreshInFlight$ = null)),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    return this.refreshInFlight$;
  }

  /**
   * A request carrying `usedToken` was rejected as expired. If the token has already been replaced (a straggler
   * from the same burst), just reuse the new one; otherwise refresh. Never triggers a second refresh for one burst.
   */
  refreshAfterFailure(usedToken: string | null): Observable<string> {
    if (this.accessTokenValue && this.accessTokenValue !== usedToken)
      return of(this.accessTokenValue);
    return this.refresh();
  }

  /** Session is dead (token_invalid, failed refresh): stop in-flight work, drop tokens, go to /login. */
  forceLogout(): void {
    this.clearSession();
    this.redirectToLogin();
  }

  /** Sends the user to /login, remembering where they were. Safe to call from many failing requests at once. */
  redirectToLogin(): void {
    const returnUrl = this.router.url;
    if (this.redirecting || returnUrl.startsWith('/login')) return;
    this.redirecting = true;
    void this.router
      .navigate(['/login'], {
        queryParams: returnUrl && returnUrl !== '/' ? { returnUrl } : undefined,
      })
      .finally(() => (this.redirecting = false));
  }

  logout(): void {
    this.clearSession();
    void this.router.navigate(['/login']);
  }

  private applySession(res: AuthResponse): void {
    this.accessTokenValue = res.accessToken;
    this.writeRefreshToken(res.refreshToken);
    this.userState.set(res.user);
  }

  private clearSession(): void {
    const wasActive = this.isAuthenticated() || this.accessTokenValue !== null;
    this.accessTokenValue = null;
    this.writeRefreshToken(null);
    this.userState.set(null);
    if (wasActive) this.sessionEndedSubject.next();
  }

  private readRefreshToken(): string | null {
    try {
      return sessionStorage.getItem(REFRESH_TOKEN_KEY);
    } catch {
      return null;
    }
  }

  private writeRefreshToken(token: string | null): void {
    try {
      if (token) sessionStorage.setItem(REFRESH_TOKEN_KEY, token);
      else sessionStorage.removeItem(REFRESH_TOKEN_KEY);
    } catch {
      /* storage unavailable: the session simply will not survive a reload */
    }
  }
}
