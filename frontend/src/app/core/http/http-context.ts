import { HttpContextToken } from '@angular/common/http';

/** Set on /auth/* calls so the auth interceptor neither attaches a token nor tries to refresh on 401. */
export const SKIP_AUTH = new HttpContextToken<boolean>(() => false);
