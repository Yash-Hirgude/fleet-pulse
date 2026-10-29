import { MAX_RATE, PORT } from './config.js';
import { sendError } from './errors.js';

const DEFAULTS = Object.freeze({ rate: 500, ws: '', sse: '', chaos: '', token_ttl: 60, http: '', kill: 0 });
export const CHAOS_KEYS = Object.keys(DEFAULTS);

let state = { ...DEFAULTS };
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

export const onChaosChange = (fn) => listeners.add(fn);
export const getChaos = () => ({ ...state });

function normalize(key, value) {
  switch (key) {
    case 'rate': {
      const n = Math.round(Number(value));
      return Number.isFinite(n) ? Math.min(MAX_RATE, Math.max(1, n)) : DEFAULTS.rate;
    }
    case 'token_ttl': {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? n : DEFAULTS.token_ttl;
    }
    case 'kill': {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }
    default:
      return value === null || value === undefined ? '' : String(value);
  }
}

/** Keep only known switches from a body or query object, normalized. */
export function pickSwitches(source = {}) {
  const out = {};
  for (const key of CHAOS_KEYS) if (source[key] !== undefined) out[key] = normalize(key, source[key]);
  return out;
}

export function setChaos(patch) {
  state = { ...state, ...pickSwitches(patch) };
  notify();
  return getChaos();
}

export function resetChaos() {
  state = { ...DEFAULTS };
  notify();
  return getChaos();
}

/** "shuffle,dupe" -> Map{shuffle:'',dupe:''}; "drop:20" -> Map{drop:'20'}; "500:50,slow:200" -> Map{500:'50',slow:'200'} */
export function parseFlags(value) {
  const map = new Map();
  for (const part of String(value || '').split(',')) {
    const token = part.trim();
    if (!token) continue;
    const i = token.indexOf(':');
    if (i === -1) map.set(token, '');
    else map.set(token.slice(0, i), token.slice(i + 1));
  }
  return map;
}

const EXCLUDED = ['/auth/', '/chaos', '/health', '/stream', '/assistant'];

/** http=500:<pct> | http=slow:<ms> | http=429 -- only on the primary port, REST only. */
export function httpChaos(req, res, next) {
  if (req.socket.localPort !== PORT || req.method === 'OPTIONS') return next();
  if (EXCLUDED.some((p) => req.path.startsWith(p))) return next();

  const flags = parseFlags(state.http);
  if (flags.has('429')) {
    res.set('Retry-After', '2');
    return sendError(res, 429, 'rate_limited', 'Too many requests (chaos)');
  }
  if (flags.has('500')) {
    const pct = Number(flags.get('500')) || 100;
    if (Math.random() * 100 < pct) return sendError(res, 500, 'server_error', 'Injected failure (chaos)');
  }
  const slow = Number(flags.get('slow'));
  if (slow > 0) return void setTimeout(next, slow);
  return next();
}