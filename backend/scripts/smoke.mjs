// Quick end-to-end check of the mock: `npm start` in one shell, `npm run smoke` in another.
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const BASE = process.env.BASE ?? 'http://localhost:4000';
const WS = BASE.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const chaos = (b) => api('/chaos', { method: 'POST', body: b });
const login = async (who) => (await api('/auth/login', { method: 'POST', body: { email: `${who}@pulse.dev`, password: 'pulse123' } })).body;

function collect(url, ms) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames = [];
    ws.on('message', (d) => frames.push(d.toString()));
    ws.on('unexpected-response', (_q, res) => { ws.terminate(); reject(Object.assign(new Error(`http ${res.statusCode}`), { status: res.statusCode })); });
    ws.on('error', () => {});
    ws.on('open', () => setTimeout(() => { ws.close(); resolve(frames); }, ms));
  });
}
const parse = (frames) => frames.map((f) => { try { return JSON.parse(f); } catch { return null; } });

let failed = 0;
async function step(name, fn) {
  try { await fn(); console.log('  ok  ', name); } catch (e) { failed++; console.error('  FAIL', name, '\n      ', e.message); }
}

await api('/chaos', { method: 'DELETE' });
const op = await login('operator');
const vw = await login('viewer');

await step('health + login shapes', async () => {
  assert.equal((await api('/health')).body.status, 'ok');
  assert.equal(op.user.role, 'operator'); assert.equal(op.expiresIn, 60);
  assert.equal((await api('/auth/login', { method: 'POST', body: { email: 'x@y.z', password: 'no' } })).body.error.code, 'invalid_credentials');
});
await step('401 without token / with garbage token', async () => {
  assert.equal((await api('/services')).body.error.code, 'token_invalid');
  assert.equal((await api('/services', { token: 'nope' })).status, 401);
});
await step('refresh rotates; reuse -> refresh_invalid', async () => {
  const r1 = await api('/auth/refresh', { method: 'POST', body: { refreshToken: op.refreshToken } });
  assert.equal(r1.status, 200);
  const r2 = await api('/auth/refresh', { method: 'POST', body: { refreshToken: op.refreshToken } });
  assert.equal(r2.status, 401); assert.equal(r2.body.error.code, 'refresh_invalid');
});
await step('services / snapshot / history', async () => {
  const s = await api('/services', { token: op.accessToken });
  assert.equal(s.body.length, 2000); assert.equal(s.body[0].id, 'svc-0001');
  const snap = await api('/metrics/snapshot', { token: op.accessToken });
  assert.equal(snap.body.metrics.length, 2000); assert.ok(snap.body.offset > 9_000_000);
  const h = await api('/metrics/history?serviceId=svc-0412&minutes=15', { token: op.accessToken });
  assert.equal(h.body.points.length, 900);
  assert.equal((await api('/metrics/history?serviceId=svc-0412&minutes=99', { token: op.accessToken })).status, 400);
});
await step('rules: roles, idempotency, 409, 422, check-name, put, delete', async () => {
  const t = op.accessToken;
  const rule = { name: 'Smoke rule', conditions: [{ metric: 'rps', operator: '<', threshold: 10, durationSec: 5 }], warning: 1 };
  assert.equal((await api('/rules', { method: 'POST', token: vw.accessToken, body: rule })).status, 403);
  const a = await api('/rules', { method: 'POST', token: t, body: rule, headers: { 'Idempotency-Key': 'k1' } });
  const b = await api('/rules', { method: 'POST', token: t, body: rule, headers: { 'Idempotency-Key': 'k1' } });
  assert.equal(a.status, 201); assert.equal(b.body.id, a.body.id); assert.equal(a.body.warning, 1);
  assert.equal((await api('/rules', { method: 'POST', token: t, body: rule, headers: { 'Idempotency-Key': 'k2' } })).body.error.code, 'name_taken');
  assert.equal((await api('/rules', { method: 'POST', token: t, body: { name: '' , conditions: [] } })).status, 422);
  assert.equal((await api('/rules/check-name?name=smoke%20RULE', { token: t })).body.available, false);
  assert.equal((await api(`/rules/check-name?name=smoke%20rule&excludeId=${a.body.id}`, { token: t })).body.available, true);
  assert.equal((await api(`/rules/${a.body.id}`, { method: 'PUT', token: t, body: { ...rule, name: 'Smoke rule 2' } })).status, 200);
  assert.equal((await api(`/rules/${a.body.id}`, { method: 'DELETE', token: t })).status, 204);
  assert.equal((await api(`/rules/${a.body.id}`, { token: t })).status, 404);
});
await step('replay: contiguous events; 410 for old offsets', async () => {
  const snap = (await api('/metrics/snapshot', { token: op.accessToken })).body;
  await sleep(300);
  const r = await api(`/metrics/replay?since=${snap.offset}`, { token: op.accessToken });
  assert.equal(r.status, 200); assert.equal(r.body.events[0].offset, snap.offset + 1);
  assert.equal((await api('/metrics/replay?since=1', { token: op.accessToken })).body.error.code, 'replay_too_old');
});
await step('ws stream: contiguous offsets, per-service seq, ping within 6 s', async () => {
  const frames = parse(await collect(`${WS}/stream?access_token=${op.accessToken}`, 6000));
  const m = frames.filter((f) => f?.type === 'metric');
  assert.ok(m.length > 2000, `expected ~3000 metric events, got ${m.length}`);
  for (let i = 1; i < m.length; i++) assert.equal(m[i].offset, m[i - 1].offset + 1);
  assert.ok(frames.some((f) => f?.type === 'ping'));
  const last = new Map();
  for (const e of m) { if (last.has(e.serviceId)) assert.equal(e.seq, last.get(e.serviceId) + 1); last.set(e.serviceId, e.seq); }
});
await step('ws bad token closes with 4401; sse bad token 401', async () => {
  const code = await new Promise((res) => { const ws = new WebSocket(`${WS}/stream?access_token=bad`); ws.on('close', res); ws.on('error', () => {}); });
  assert.equal(code, 4401);
  assert.equal((await fetch(`${BASE}/stream/sse?access_token=bad`)).status, 401);
});
await step('sse stream: id/event/data framing', async () => {
  const res = await fetch(`${BASE}/stream/sse?access_token=${op.accessToken}`);
  const reader = res.body.getReader(); let text = '';
  while (text.length < 2000) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.match(text, /id: \d+\nevent: metric\ndata: \{"type":"metric"/);
});
await step('chaos: ws=down -> 503; ws=down&sse=down; reset', async () => {
  await chaos({ ws: 'down' });
  await assert.rejects(collect(`${WS}/stream?access_token=${op.accessToken}`, 300), (e) => e.status === 503);
  await chaos({ sse: 'down' });
  assert.equal((await fetch(`${BASE}/stream/sse?access_token=${op.accessToken}`)).status, 503);
  assert.deepEqual((await api('/chaos', { method: 'DELETE' })).body.ws, '');
});
await step('chaos: ws=silent -> open but no frames', async () => {
  await chaos({ ws: 'silent' });
  assert.equal((await collect(`${WS}/stream?access_token=${op.accessToken}`, 1500)).length, 0);
  await api('/chaos', { method: 'DELETE' });
});
await step('chaos: ws=drop:30 -> gaps in offsets', async () => {
  await chaos({ ws: 'drop:30' });
  const m = parse(await collect(`${WS}/stream?access_token=${op.accessToken}`, 1500)).filter((f) => f?.type === 'metric');
  const gaps = m.filter((e, i) => i && e.offset !== m[i - 1].offset + 1).length;
  assert.ok(gaps > 100, `gaps=${gaps}`);
  await api('/chaos', { method: 'DELETE' });
});
await step('chaos: shuffle,dupe -> out of order + duplicates, all within 1 s', async () => {
  await chaos({ chaos: 'shuffle,dupe' });
  const m = parse(await collect(`${WS}/stream?access_token=${op.accessToken}`, 3000)).filter((f) => f?.type === 'metric');
  const seen = new Set(); let dupes = 0, ooo = 0;
  m.forEach((e, i) => { if (seen.has(e.offset)) dupes++; seen.add(e.offset); if (i && e.offset < m[i - 1].offset) ooo++; });
  assert.ok(dupes > 50 && ooo > 50, `dupes=${dupes} ooo=${ooo}`);
  await api('/chaos', { method: 'DELETE' });
});
await step('chaos: garbage:20 -> both invalid JSON and missing fields', async () => {
  await chaos({ chaos: 'garbage:20' });
  const frames = parse(await collect(`${WS}/stream?access_token=${op.accessToken}`, 2000));
  const bad = frames.filter((f) => f === null).length;
  const missing = frames.filter((f) => f && f.type === 'metric' && ['serviceId', 'seq', 'p95', 'errRate', 'rps', 'status', 'ts', 'offset'].some((k) => !(k in f))).length;
  assert.ok(bad > 10 && missing > 10, `invalidJson=${bad} missingFields=${missing}`);
  await api('/chaos', { method: 'DELETE' });
});
await step('chaos: http=500:100 / http=429 / http=slow / exclusions', async () => {
  await chaos({ http: '500:100' });
  assert.equal((await api('/services', { token: op.accessToken })).body.error.code, 'server_error');
  assert.equal((await api('/health')).status, 200);
  await chaos({ http: '429' });
  const r = await api('/services', { token: op.accessToken });
  assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '2');
  await chaos({ http: 'slow:400' });
  const t0 = Date.now(); await api('/rules', { token: op.accessToken }); assert.ok(Date.now() - t0 >= 380);
  await api('/chaos', { method: 'DELETE' });
});
await step('chaos: token_ttl=1 -> token_expired', async () => {
  await chaos({ token_ttl: 1 });
  const u = await login('operator'); assert.equal(u.expiresIn, 1);
  await sleep(1200);
  assert.equal((await api('/services', { token: u.accessToken })).body.error.code, 'token_expired');
  await api('/chaos', { method: 'DELETE' });
});
await step('chaos: kill=2 closes the stream', async () => {
  await chaos({ kill: 2 });
  const t0 = Date.now();
  await new Promise((res) => { const ws = new WebSocket(`${WS}/stream?access_token=${op.accessToken}`); ws.on('close', res); ws.on('error', () => {}); });
  assert.ok(Date.now() - t0 < 3500);
  await api('/chaos', { method: 'DELETE' });
});
await step('rate=2000 sustained', async () => {
  await chaos({ rate: 2000 });
  const m = parse(await collect(`${WS}/stream?access_token=${op.accessToken}`, 3000)).filter((f) => f?.type === 'metric');
  assert.ok(m.length > 5400 && m.length < 6600, `got ${m.length} in 3 s`);
  await api('/chaos', { method: 'DELETE' });
});

console.log(failed ? `\n${failed} step(s) failed` : '\nall good');
process.exit(failed ? 1 : 0);