import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { APP_CONFIG } from '../config/app-config';

type Params = Record<string, string | number | boolean>;

/** Thin wrapper so feature code never builds URLs by hand. Interceptors do auth, retry and timeout. */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(APP_CONFIG).api.baseUrl;

  get<T>(path: string, params?: Params): Observable<T> {
    return this.http.get<T>(this.baseUrl + path, { params });
  }

  post<T>(path: string, body: unknown, headers?: Record<string, string>): Observable<T> {
    return this.http.post<T>(this.baseUrl + path, body, { headers });
  }

  put<T>(path: string, body: unknown): Observable<T> {
    return this.http.put<T>(this.baseUrl + path, body);
  }

  delete(path: string): Observable<void> {
    return this.http.delete<void>(this.baseUrl + path);
  }
}
