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
      {
        path: 'fleet',
        title: 'Fleet',
        loadComponent: () => import('./features/fleet/fleet.page').then((m) => m.FleetPage),
      },
      {
        path: 'services/:id',
        title: 'Service',
        loadComponent: () =>
          import('./features/service-detail/service-detail.page').then((m) => m.ServiceDetailPage),
      },
      {
        path: 'rules',
        canActivate: [roleGuard('operator')], // enforced on the route itself, not only by hiding the link
        loadChildren: () => import('./features/rules/rules.routes').then((m) => m.RULES_ROUTES),
      },
      {
        path: 'settings',
        title: 'Settings',
        loadComponent: () =>
          import('./features/settings/settings.page').then((m) => m.SettingsPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
