import { HttpErrorResponse, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { retry, throwError, timer } from 'rxjs';
import { APP_CONFIG, AppConfig } from '../config/app-config';

type HttpConfig = AppConfig['http'];

/**
 * Only GET is retried automatically. A POST (even with an Idempotency-Key) is never re-sent behind the user's
 * back: the failure is shown and the user retries, reusing the same key.
 */
export const isRetryableRequest = (req: HttpRequest<unknown>): boolean => req.method === 'GET';

/** Network errors and timeouts (status 0), 429, 502, 503, 504. Never other 4xx. */
export function isRetryableError(err: unknown, cfg: HttpConfig): boolean {
  return (
    err instanceof HttpErrorResponse &&
    (err.status === 0 || cfg.retryableStatuses.includes(err.status))
  );
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** 429 honours Retry-After; everything else uses exponential backoff with equal jitter. */
export function retryDelayMs(
  err: HttpErrorResponse,
  retryCount: number,
  cfg: HttpConfig,
  random = Math.random,
): number {
  const retryAfter = err.status === 429 ? parseRetryAfterMs(err.headers.get('Retry-After')) : null;
  if (retryAfter !== null) return Math.min(retryAfter, cfg.retryMaxDelayMs);
  const exp = Math.min(cfg.retryBaseDelayMs * 2 ** (retryCount - 1), cfg.retryMaxDelayMs);
  return exp / 2 + random() * (exp / 2);
}

export const retryInterceptor: HttpInterceptorFn = (req, next) => {
  const cfg = inject(APP_CONFIG).http;
  if (!isRetryableRequest(req)) return next(req);
  return next(req).pipe(
    retry({
      count: cfg.maxAttempts - 1,
      delay: (error, retryCount) =>
        isRetryableError(error, cfg)
          ? timer(retryDelayMs(error as HttpErrorResponse, retryCount, cfg))
          : throwError(() => error),
    }),
  );
};
