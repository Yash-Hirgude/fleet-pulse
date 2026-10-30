import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { authInterceptor } from './core/auth/auth.interceptor';
import { AuthService } from './core/auth/auth.service';
import { retryInterceptor } from './core/http/retry.interceptor';
import { timeoutInterceptor } from './core/http/timeout.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    // Order matters: auth is outermost so a refresh + replay goes back through retry and timeout.
    provideHttpClient(withInterceptors([authInterceptor, retryInterceptor, timeoutInterceptor])),
    provideAppInitializer(() => inject(AuthService).restoreSession()),
  ],
};
