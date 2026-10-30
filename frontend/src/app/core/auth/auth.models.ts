export type Role = 'viewer' | 'operator';

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
}

export interface AuthResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly user: AuthUser;
}
