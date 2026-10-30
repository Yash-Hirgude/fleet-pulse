import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  TestRequest,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthResponse } from './auth.models';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from './auth.service';

const BASE = 'http://localhost:4000';
const EXPIRED = { error: { code: 'token_expired', message: 'Access token expired', details: [] } };
const session = (at: string, rt: string): AuthResponse => ({
  accessToken: at,
  refreshToken: rt,
  expiresIn: 60,
  user: { id: 'u-1', email: 'operator@pulse.dev', role: 'operator' },
});

@Component({ template: '' })
class Dummy {}

describe('authInterceptor', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;
  let auth: AuthService;
  let router: Router;

  const items = (r: { url: string }) => r.url.startsWith(`${BASE}/items/`);
  const flushExpired = (reqs: TestRequest[]) =>
    reqs.forEach((r) => r.flush(EXPIRED, { status: 401, statusText: 'Unauthorized' }));

  async function signIn() {
    const done = firstValueFrom(auth.login('operator@pulse.dev', 'pulse123'));
    ctrl.expectOne(`${BASE}/auth/login`).flush(session('at-1', 'rt-1'));
    await done;
  }

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'fleet', component: Dummy },
          { path: 'login', component: Dummy },
        ]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
    router = TestBed.inject(Router);
  });

  it('attaches the bearer token to API requests', async () => {
    await signIn();
    void firstValueFrom(http.get(`${BASE}/items/1`));
    expect(ctrl.expectOne(items).request.headers.get('Authorization')).toBe('Bearer at-1');
  });

  it('sends exactly one refresh call when 10 parallel requests are rejected, then replays all 10', async () => {
    await signIn();
    const results = Array.from({ length: 10 }, (_, i) =>
      firstValueFrom(http.get(`${BASE}/items/${i}`)),
    );

    const first = ctrl.match(items);
    expect(first).toHaveLength(10);
    flushExpired(first);

    const refreshCalls = ctrl.match(`${BASE}/auth/refresh`);
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0].request.body).toEqual({ refreshToken: 'rt-1' });
    expect(refreshCalls[0].request.headers.has('Authorization')).toBe(false);
    refreshCalls[0].flush(session('at-2', 'rt-2'));

    const replays = ctrl.match(items);
    expect(replays).toHaveLength(10);
    replays.forEach((r, i) => {
      expect(r.request.headers.get('Authorization')).toBe('Bearer at-2');
      r.flush({ i });
    });

    expect(await Promise.all(results)).toHaveLength(10);
    ctrl.verify();
  });

  it('does not refresh again for a straggler that was sent with the old token', async () => {
    await signIn();
    const a = firstValueFrom(http.get(`${BASE}/items/a`));
    const b = firstValueFrom(http.get(`${BASE}/items/b`));
    const [reqA, reqB] = ctrl.match(items);

    flushExpired([reqA]);
    ctrl.expectOne(`${BASE}/auth/refresh`).flush(session('at-2', 'rt-2'));
    flushExpired([reqB]); // arrives after the refresh finished

    ctrl.expectNone(`${BASE}/auth/refresh`);
    const replays = ctrl.match(items);
    expect(replays).toHaveLength(2);
    replays.forEach((r) => r.flush({}));
    await Promise.all([a, b]);
  });

  it('logs out cleanly when the refresh is rejected: requests fail, session ends, returnUrl is kept', async () => {
    await router.navigateByUrl('/fleet');
    await signIn();
    let ended = 0;
    auth.sessionEnded$.subscribe(() => ended++);

    const outcomes = Array.from({ length: 3 }, (_, i) => {
      const o = { emitted: false, errored: false, completed: false };
      http.get(`${BASE}/items/${i}`).subscribe({
        next: () => (o.emitted = true),
        error: () => (o.errored = true),
        complete: () => (o.completed = true),
      });
      return o;
    });
    flushExpired(ctrl.match(items));
    ctrl
      .expectOne(`${BASE}/auth/refresh`)
      .flush(
        { error: { code: 'refresh_invalid', message: 'x', details: [] } },
        { status: 401, statusText: 'Unauthorized' },
      );

    // requests that were waiting on the refresh fail; none keeps waiting and none delivers data
    expect(outcomes.every((o) => o.errored && !o.emitted && !o.completed)).toBe(true);
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.accessToken()).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(ended).toBe(1);
    await vi.waitFor(() => expect(router.url).toBe('/login?returnUrl=%2Ffleet'));
  });

  it('keeps the user signed in when the refresh fails because the network is down', async () => {
    await signIn();
    const result = firstValueFrom(http.get(`${BASE}/items/1`)).catch((e: unknown) => e);
    flushExpired(ctrl.match(items));
    ctrl.expectOne(`${BASE}/auth/refresh`).error(new ProgressEvent('error'));
    expect((await result) as { status: number }).toMatchObject({ status: 0 });
    expect(auth.isAuthenticated()).toBe(true);
  });

  it('cancels in-flight requests when the session ends', async () => {
    await signIn();
    let completed = false;
    let emitted = false;
    http
      .get(`${BASE}/items/1`)
      .subscribe({ next: () => (emitted = true), complete: () => (completed = true) });
    const req = ctrl.expectOne(items);
    auth.logout();
    expect(req.cancelled).toBe(true);
    expect(completed).toBe(true);
    expect(emitted).toBe(false);
  });
});
