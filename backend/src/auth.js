import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { ApiError } from './errors.js';
import { getChaos } from './chaos.js';

const USERS = [
  { id: 'u-1', email: 'operator@pulse.dev', password: 'pulse123', role: 'operator' },
  { id: 'u-2', email: 'viewer@pulse.dev', password: 'pulse123', role: 'viewer' },
];

const accessTokens = new Map(); // token -> { user, exp }
const refreshTokens = new Map(); // token -> userId (deleted on use => rotation)

const publicUser = ({ id, email, role }) => ({ id, email, role });

function issue(user) {
  const ttl = getChaos().token_ttl;
  const accessToken = `at_${randomBytes(16).toString('hex')}`;
  const refreshToken = `rt_${randomBytes(16).toString('hex')}`;
  accessTokens.set(accessToken, { user, exp: Date.now() + ttl * 1000 });
  refreshTokens.set(refreshToken, user.id);
  return { accessToken, refreshToken, expiresIn: ttl, user: publicUser(user) };
}

/** Returns { ok:true, user } or { ok:false, code, message }. Used by REST and by the WebSocket upgrade. */
export function checkAccessToken(token) {
  if (!token) return { ok: false, code: 'token_invalid', message: 'Missing access token' };
  const entry = accessTokens.get(token);
  if (!entry) return { ok: false, code: 'token_invalid', message: 'Invalid access token' };
  if (entry.exp <= Date.now()) return { ok: false, code: 'token_expired', message: 'Access token expired' };
  return { ok: true, user: entry.user };
}

export function bearerFrom(header) {
  const m = /^Bearer\s+(.+)$/i.exec(header || '');
  return m ? m[1] : undefined;
}

const QUERY_TOKEN_PATHS = ['/stream', '/assistant'];

export function requireAuth(req, res, next) {
  let token = bearerFrom(req.get('authorization'));
  if (!token && QUERY_TOKEN_PATHS.some((p) => req.path.startsWith(p))) token = req.query.access_token;
  const result = checkAccessToken(token);
  if (!result.ok) throw new ApiError(401, result.code, result.message);
  req.user = result.user;
  next();
}

export const requireRole = (role) => (req, _res, next) => {
  if (req.user?.role !== role) throw new ApiError(403, 'forbidden', `Requires role: ${role}`);
  next();
};

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new ApiError(400, 'bad_request', 'email and password are required');
  }
  const user = USERS.find((u) => u.email === email.trim().toLowerCase() && u.password === password);
  if (!user) throw new ApiError(401, 'invalid_credentials', 'Invalid email or password');
  res.json(issue(user));
});

authRouter.post('/refresh', (req, res) => {
  const { refreshToken } = req.body ?? {};
  const userId = typeof refreshToken === 'string' ? refreshTokens.get(refreshToken) : undefined;
  if (!userId) throw new ApiError(401, 'refresh_invalid', 'Refresh token is invalid or already used');
  refreshTokens.delete(refreshToken); // rotation: every refresh token works exactly once
  res.json(issue(USERS.find((u) => u.id === userId)));
});

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [token, { exp }] of accessTokens) if (exp < cutoff) accessTokens.delete(token);
}, 60_000).unref();