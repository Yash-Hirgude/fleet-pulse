import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, takeUntil, throwError } from 'rxjs';
import { errorCodeOf } from '../http/api-error';
import { SKIP_AUTH } from '../http/http-context';
import { AuthService } from './auth.service';

/**
 * 1. attaches the access token;
 * 2. on 401 token_expired: refreshes (one call for any number of parallel failures) and replays the request once;
 * 3. on a failed refresh or 401 token_invalid: logs out cleanly and sends the user to /login;
 * 4. cancels a request that is on the wire when the session ends.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.context.get(SKIP_AUTH)) return next(req);

  const auth = inject(AuthService);
  // takeUntil wraps only the network calls. Requests that are waiting for a refresh must still receive
  // the refresh error, because the refresh failing is exactly what ends the session.
  const send = (token: string | null) =>
    next(token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req).pipe(
      takeUntil(auth.sessionEnded$),
    );
  const usedToken = auth.accessToken();

  return send(usedToken).pipe(
    catchError((err: unknown) => {
      if (!(err instanceof HttpErrorResponse) || err.status !== 401) return throwError(() => err);

      const code = errorCodeOf(err);
      if (code === 'token_expired') {
        return auth.refreshAfterFailure(usedToken).pipe(
          switchMap((token) => send(token)),
          catchError((refreshErr: unknown) => {
            // refresh() clears the session only when the server rejected it; a network error keeps the user in.
            if (!auth.isAuthenticated()) auth.redirectToLogin();
            return throwError(() => refreshErr);
          }),
        );
      }
      if (code === 'token_invalid') auth.forceLogout();
      return throwError(() => err);
    }),
  );
};
