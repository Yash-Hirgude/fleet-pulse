import { SERVICE_COUNT } from './config.js';

export const STATUS = ['healthy', 'degraded', 'down'];

/** Deterministic hash -> [0,1). Lets us compute any metric for any (service, time) without storing history. */
export function mix(a, b) {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const TEAMS = ['payments', 'checkout', 'auth', 'search', 'catalog', 'orders', 'inventory', 'shipping', 'billing', 'notifications', 'gateway', 'identity', 'analytics', 'media', 'recommendations'];
const KINDS = ['api', 'worker', 'db-proxy', 'cache', 'ingest', 'scheduler', 'edge', 'gateway'];

export const SERVICES = Array.from({ length: SERVICE_COUNT }, (_, i) => {
  const team = TEAMS[i % TEAMS.length];
  const kind = KINDS[Math.floor(mix(i, 3) * KINDS.length)];
  return { id: `svc-${String(i + 1).padStart(4, '0')}`, name: `${team}-${kind}-${Math.floor(i / TEAMS.length) + 1}`, team };
});

const PROFILES = SERVICES.map((_, i) => ({
  p95Base: 40 + mix(i, 11) * 360, // 40-400 ms
  errBase: 0.1 + mix(i, 17) * 1.1, // 0.1-1.2 %
  rpsBase: 50 + mix(i, 23) * 2950, // 50-3000
  phase: mix(i, 29) * Math.PI * 2,
}));

export function serviceIndex(id) {
  if (typeof id !== 'string' || !/^svc-\d{4}$/.test(id)) return -1;
  const idx = Number(id.slice(4)) - 1;
  return idx >= 0 && idx < SERVICE_COUNT ? idx : -1;
}

export function statusOf(p95, errRate) {
  if (errRate >= 20) return 2;
  if (errRate >= 2 || p95 >= 600) return 1;
  return 0;
}

/**
 * Metrics of service `idx` at time `tsMs`. Pure function: history and live events agree.
 * `jitterSeed` (the event offset) adds tiny per-event noise for live events; 0 for history.
 * Every minute ~1.5% of services go "down" and ~2.5% "degraded", so status changes are frequent.
 */
export function metricsAt(idx, tsMs, jitterSeed = 0) {
  const p = PROFILES[idx];
  const sec = Math.floor(tsMs / 1000);
  const wave = Math.sin(sec / 90 + p.phase);
  const jitter = jitterSeed ? 1 + (mix(idx, jitterSeed) - 0.5) * 0.02 : 1;

  let p95 = p.p95Base * (1 + 0.12 * wave) * (1 + (mix(idx, sec) - 0.5) * 0.08) * jitter;
  let err = (p.errBase * (1 + 0.3 * wave) + mix(idx, sec + 7) * 0.2) * jitter;
  let rps = p.rpsBase * (1 + 0.2 * Math.sin(sec / 45 + p.phase * 2)) * (1 + (mix(idx, sec + 13) - 0.5) * 0.1) * jitter;

  const bucket = Math.floor(sec / 60);
  const roll = mix(idx * 31 + 5, bucket);
  if (roll < 0.015) {
    p95 *= 4;
    err = 20 + mix(idx, bucket + 1) * 30;
    rps *= 0.4;
  } else if (roll < 0.04) {
    p95 *= 1.8;
    err += 2.5 + mix(idx, bucket + 2) * 4;
  }

  p95 = Math.min(65535, Math.round(p95));
  err = Math.min(100, Math.round(err * 10) / 10);
  rps = Math.min(65535, Math.round(rps));
  return { p95, errRate: err, rps, status: statusOf(p95, err) };
}

export function history(idx, minutes) {
  const end = Math.floor(Date.now() / 1000);
  const points = [];
  for (let s = end - minutes * 60 + 1; s <= end; s++) {
    const m = metricsAt(idx, s * 1000, 0);
    points.push({ ts: s * 1000, p95: m.p95, errRate: m.errRate, rps: m.rps });
  }
  return { serviceId: SERVICES[idx].id, points };
}