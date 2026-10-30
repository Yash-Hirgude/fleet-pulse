import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Role } from './auth.models';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = (_route, state) => {
  if (inject(AuthService).isAuthenticated()) return true;
  return inject(Router).createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};

/** Enforced on the route itself, so typing /rules in the address bar as a viewer does not get through. */
export const roleGuard =
  (required: Role): CanActivateFn =>
  () =>
    inject(AuthService).role() === required ? true : inject(Router).createUrlTree(['/fleet']);
