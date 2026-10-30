import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { throwError, timeout } from 'rxjs';
import { APP_CONFIG } from '../config/app-config';

/** Every request attempt gets `http.timeoutMs`; a timeout surfaces as a status-0 'Timeout' error. */
export const timeoutInterceptor: HttpInterceptorFn = (req, next) => {
  const { timeoutMs } = inject(APP_CONFIG).http;
  return next(req).pipe(
    timeout({
      each: timeoutMs,
      with: () =>
        throwError(
          () =>
            new HttpErrorResponse({
              url: req.url,
              status: 0,
              statusText: 'Timeout',
              error: new Error('timeout'),
            }),
        ),
    }),
  );
};
