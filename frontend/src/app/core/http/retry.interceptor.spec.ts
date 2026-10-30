import {
  HttpClient,
  HttpErrorResponse,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { DEFAULT_APP_CONFIG } from '../config/app-config';
import { toApiFailure } from './api-error';
import { parseRetryAfterMs, retryDelayMs, retryInterceptor } from './retry.interceptor';
import { timeoutInterceptor } from './timeout.interceptor';

const status = (code: number, headers: Record<string, string> = {}) => ({
  status: code,
  statusText: 'x',
  headers,
});

describe('retryInterceptor', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;
  let outcome: { value?: unknown; error?: unknown };

  function request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    headers: Record<string, string> = {},
  ) {
    outcome = {};
    http.request(method, '/x', { headers, body: method === 'GET' ? undefined : {} }).subscribe({
      next: (value) => (outcome.value = value),
      error: (error: unknown) => (outcome.error = error),
    });
  }
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([retryInterceptor, timeoutInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
  });
  afterEach(() => vi.useRealTimers());

  it.each([502, 503, 504])(
    'retries a GET on %i, 3 attempts in total, then surfaces the error',
    async (code) => {
      request('GET');
      ctrl.expectOne('/x').flush('', status(code));
      await tick(1000);
      ctrl.expectOne('/x').flush('', status(code));
      await tick(1000);
      ctrl.expectOne('/x').flush('', status(code));
      await tick(60_000);
      ctrl.expectNone('/x');
      expect(outcome.error).toBeInstanceOf(HttpErrorResponse);
    },
  );

  it('retries a network error and returns the value once an attempt succeeds', async () => {
    request('GET');
    ctrl.expectOne('/x').error(new ProgressEvent('error'));
    await tick(1000);
    ctrl.expectOne('/x').flush({ ok: true });
    expect(outcome.value).toEqual({ ok: true });
  });

  it('honours Retry-After on 429', async () => {
    request('GET');
    ctrl.expectOne('/x').flush('', status(429, { 'Retry-After': '2' }));
    await tick(1999);
    ctrl.expectNone('/x');
    await tick(1);
    ctrl.expectOne('/x').flush({ ok: true });
    expect(outcome.value).toEqual({ ok: true });
  });

  it.each([400, 401, 403, 404, 409, 422])('never retries a GET on %i', async (code) => {
    request('GET');
    ctrl.expectOne('/x').flush('', status(code));
    await tick(60_000);
    ctrl.expectNone('/x');
    expect((outcome.error as HttpErrorResponse).status).toBe(code);
  });

  it.each(['POST', 'PUT', 'DELETE'] as const)('never retries a %s, even on 503', async (method) => {
    request(method);
    ctrl.expectOne('/x').flush('', status(503));
    await tick(60_000);
    ctrl.expectNone('/x');
    expect(outcome.error).toBeInstanceOf(HttpErrorResponse);
  });

  it('does not retry a POST that carries an idempotency key either (the user retries, reusing the key)', async () => {
    request('POST', { 'Idempotency-Key': 'k-1' });
    ctrl.expectOne('/x').flush('', status(500));
    await tick(60_000);
    ctrl.expectNone('/x');
  });

  it('times out after 10 s and retries the timed-out GET', async () => {
    request('GET');
    ctrl.expectOne('/x'); // never answered
    await tick(DEFAULT_APP_CONFIG.http.timeoutMs);
    await tick(1000); // backoff
    const second = ctrl.expectOne('/x');
    expect(second.cancelled).toBe(false);
    await tick(DEFAULT_APP_CONFIG.http.timeoutMs);
    await tick(1000);
    ctrl.expectOne('/x');
    await tick(DEFAULT_APP_CONFIG.http.timeoutMs);
    expect(toApiFailure(outcome.error).code).toBe('timeout');
    ctrl.expectNone('/x');
  });
});

describe('retry helpers', () => {
  const cfg = DEFAULT_APP_CONFIG.http;
  const err429 = (retryAfter?: string) =>
    new HttpErrorResponse({
      status: 429,
      headers: retryAfter ? ({ get: () => retryAfter } as never) : undefined,
    });

  it('parses Retry-After as seconds or as an HTTP date', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('soon')).toBeNull();
    expect(
      parseRetryAfterMs(
        'Wed, 21 Oct 2026 07:28:05 GMT',
        Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'),
      ),
    ).toBe(5000);
  });

  it('caps Retry-After at the configured maximum', () => {
    expect(retryDelayMs(err429('600'), 1, cfg)).toBe(cfg.retryMaxDelayMs);
  });

  it('backs off exponentially with jitter inside [exp/2, exp]', () => {
    const err = new HttpErrorResponse({ status: 503 });
    expect(retryDelayMs(err, 1, cfg, () => 0)).toBe(150);
    expect(retryDelayMs(err, 1, cfg, () => 1)).toBe(300);
    expect(retryDelayMs(err, 3, cfg, () => 1)).toBe(1200);
  });
});
