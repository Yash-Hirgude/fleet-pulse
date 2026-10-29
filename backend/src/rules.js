import { Router } from 'express';
import { ApiError } from './errors.js';
import { requireRole } from './auth.js';

const METRICS = ['p95', 'errRate', 'rps'];
const OPERATORS = ['>', '>=', '<', '<='];

const rules = new Map();
const idempotency = new Map(); // `${userId}:${key}` -> rule (only successful creates are remembered)
let nextId = 1;

const norm = (s) => String(s).trim().toLowerCase();
const nameTaken = (name, excludeId) => [...rules.values()].some((r) => r.id !== excludeId && norm(r.name) === norm(name));

function validate(body) {
  const details = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return [{ field: 'body', message: 'Body must be a JSON object' }];
  }
  if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 100) {
    details.push({ field: 'name', message: 'name must be a string of 1-100 characters' });
  }
  if (!Array.isArray(body.conditions) || body.conditions.length < 1) {
    details.push({ field: 'conditions', message: 'conditions must contain at least one condition' });
  } else {
    body.conditions.forEach((c, i) => {
      const at = `conditions[${i}]`;
      if (!c || typeof c !== 'object') return details.push({ field: at, message: 'condition must be an object' });
      if (!METRICS.includes(c.metric)) details.push({ field: `${at}.metric`, message: `metric must be one of ${METRICS.join(', ')}` });
      if (!OPERATORS.includes(c.operator)) details.push({ field: `${at}.operator`, message: `operator must be one of ${OPERATORS.join(' ')}` });
      if (typeof c.threshold !== 'number' || !Number.isFinite(c.threshold)) details.push({ field: `${at}.threshold`, message: 'threshold must be a number' });
      if (typeof c.durationSec !== 'number' || !(c.durationSec >= 0)) details.push({ field: `${at}.durationSec`, message: 'durationSec must be a number >= 0' });
    });
  }
  return details;
}

function seed(name, conditions) {
  const now = Date.now();
  const id = `r-${nextId++}`;
  rules.set(id, { id, name, conditions, createdAt: now, updatedAt: now });
}
seed('Checkout latency', [{ metric: 'p95', operator: '>', threshold: 500, durationSec: 30 }]);
seed('Error budget burn', [{ metric: 'errRate', operator: '>=', threshold: 5, durationSec: 10 }]);

export const rulesRouter = Router();

rulesRouter.get('/', (_req, res) => res.json([...rules.values()]));

// must be declared before '/:id'
rulesRouter.get('/check-name', (req, res) => {
  const { name, excludeId } = req.query;
  if (typeof name !== 'string' || !name.trim()) throw new ApiError(400, 'bad_request', 'name is required');
  res.json({ available: !nameTaken(name, typeof excludeId === 'string' ? excludeId : undefined) });
});

rulesRouter.get('/:id', (req, res) => {
  const rule = rules.get(req.params.id);
  if (!rule) throw new ApiError(404, 'not_found', 'Rule not found');
  res.json(rule);
});

rulesRouter.post('/', requireRole('operator'), (req, res) => {
  const key = req.get('Idempotency-Key');
  const cacheKey = key ? `${req.user.id}:${key}` : null;
  if (cacheKey && idempotency.has(cacheKey)) {
    return res.status(201).set('Idempotency-Replayed', 'true').json(idempotency.get(cacheKey));
  }
  const details = validate(req.body);
  if (details.length) throw new ApiError(422, 'validation', 'Invalid rule', details);
  if (nameTaken(req.body.name)) throw new ApiError(409, 'name_taken', 'A rule with this name already exists');

  const now = Date.now();
  const id = `r-${nextId++}`;
  const rule = { id, ...req.body, createdAt: now, updatedAt: now };
  Object.assign(rule, { id, name: req.body.name.trim(), createdAt: now, updatedAt: now });
  rules.set(id, rule);
  if (cacheKey) idempotency.set(cacheKey, rule);
  res.status(201).json(rule);
});

rulesRouter.put('/:id', requireRole('operator'), (req, res) => {
  const existing = rules.get(req.params.id);
  if (!existing) throw new ApiError(404, 'not_found', 'Rule not found');
  const details = validate(req.body);
  if (details.length) throw new ApiError(422, 'validation', 'Invalid rule', details);
  if (nameTaken(req.body.name, existing.id)) throw new ApiError(409, 'name_taken', 'A rule with this name already exists');

  const rule = { id: existing.id, ...req.body };
  Object.assign(rule, { id: existing.id, name: req.body.name.trim(), createdAt: existing.createdAt, updatedAt: Date.now() });
  rules.set(rule.id, rule);
  res.json(rule);
});

rulesRouter.delete('/:id', requireRole('operator'), (req, res) => {
  if (!rules.delete(req.params.id)) throw new ApiError(404, 'not_found', 'Rule not found');
  res.status(204).end();
});