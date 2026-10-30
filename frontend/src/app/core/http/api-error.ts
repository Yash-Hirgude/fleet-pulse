import { HttpErrorResponse } from '@angular/common/http';

export interface ApiFieldError {
  readonly field: string;
  readonly message: string;
}

/** Error body every endpoint returns, see the API contract. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: ApiFieldError[];
  };
}

/** What the UI works with, whatever went wrong (server error, network, timeout). */
export interface ApiFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details: readonly ApiFieldError[];
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  const error = (value as ApiErrorBody | null)?.error;
  return typeof error === 'object' && error !== null && typeof error.code === 'string';
}

export function toApiFailure(err: unknown): ApiFailure {
  if (err instanceof HttpErrorResponse) {
    if (isApiErrorBody(err.error)) {
      const { code, message, details } = err.error.error;
      return { status: err.status, code, message, details: details ?? [] };
    }
    if (err.statusText === 'Timeout') {
      return {
        status: 0,
        code: 'timeout',
        message: 'The server took too long to respond.',
        details: [],
      };
    }
    if (err.status === 0) {
      return { status: 0, code: 'network_error', message: 'Cannot reach the server.', details: [] };
    }
    return {
      status: err.status,
      code: 'http_error',
      message: `Request failed (${err.status}).`,
      details: [],
    };
  }
  return { status: 0, code: 'unknown', message: 'Something went wrong.', details: [] };
}

export const errorCodeOf = (err: unknown): string | null =>
  err instanceof HttpErrorResponse && isApiErrorBody(err.error) ? err.error.error.code : null;
