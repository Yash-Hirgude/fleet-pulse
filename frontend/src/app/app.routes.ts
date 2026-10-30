import { Routes } from '@angular/router';
import { authGuard, roleGuard } from './core/auth/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    title: 'Sign in',
    loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./features/shell/shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'fleet' },
      // Stub pages until the real features land. They already exercise auth, guards and the HTTP stack.
      {
        path: 'fleet',
        title: 'Fleet',
        data: { heading: 'Fleet', probe: '/services' },
        loadComponent: () => import('./features/stub/stub.page').then((m) => m.StubPage),
      },
      {
        path: 'services/:id',
        title: 'Service',
        data: { heading: 'Service detail' },
        loadComponent: () => import('./features/stub/stub.page').then((m) => m.StubPage),
      },
      {
        path: 'rules',
        title: 'Rules',
        canActivate: [roleGuard('operator')],
        data: { heading: 'Alert rules', probe: '/rules' },
        loadComponent: () => import('./features/stub/stub.page').then((m) => m.StubPage),
      },
      {
        path: 'settings',
        title: 'Settings',
        data: { heading: 'Settings' },
        loadComponent: () => import('./features/stub/stub.page').then((m) => m.StubPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
