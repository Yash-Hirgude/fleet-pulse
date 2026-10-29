import {
  BASE_OFFSET, MAX_BUFFERED_BYTES, PING_INTERVAL_MS, REPLAY_RETENTION_MS, RING_CAPACITY as CAP, TICK_MS, MAX_RATE,
} from './config.js';
import { SERVICES, STATUS, metricsAt } from './data.js';
import { getChaos, onChaosChange, parseFlags } from './chaos.js';

const N = SERVICES.length;
const FIRST_OFFSET = BASE_OFFSET + 1;

// ---------------------------------------------------------------- event store (typed-array ring buffer)
// offset is global and contiguous, so slot = offset % CAP and no index structure is needed.
const ring = {
  svc: new Uint16Array(CAP), seq: new Int32Array(CAP), ts: new Float64Array(CAP),
  p95: new Uint16Array(CAP), err: new Uint16Array(CAP), rps: new Uint32Array(CAP), st: new Uint8Array(CAP),
};
const seqs = new Int32Array(N); // per-service sequence counter
const latest = new Float64Array(N); // offset of the newest event of each service
let offset = BASE_OFFSET; // newest generated offset

function emitFor(idx, ts) {
  offset += 1;
  const m = metricsAt(idx, ts, offset);
  const i = offset % CAP;
  seqs[idx] += 1;
  ring.svc[i] = idx; ring.seq[i] = seqs[idx]; ring.ts[i] = ts; ring.p95[i] = m.p95;
  ring.err[i] = Math.round(m.errRate * 10); ring.rps[i] = m.rps; ring.st[i] = m.status;
  latest[idx] = offset;
}

export function eventAt(o) {
  const i = o % CAP;
  return {
    type: 'metric', offset: o, serviceId: SERVICES[ring.svc[i]].id, seq: ring.seq[i], ts: ring.ts[i],
    p95: ring.p95[i], errRate: ring.err[i] / 10, rps: ring.rps[i], status: STATUS[ring.st[i]],
  };
}

// one event per service at boot so /metrics/snapshot and /services always have data
{
  const now = Date.now();
  for (let idx = 0; idx < N; idx++) emitFor(idx, now);
}

export const currentOffset = () => offset;

export function serviceList() {
  return SERVICES.map((s, i) => ({ ...s, status: STATUS[ring.st[latest[i] % CAP]] }));
}

export function snapshot() {
  const metrics = new Array(N);
  for (let i = 0; i < N; i++) metrics[i] = eventAt(latest[i]);
  return { offset, ts: Date.now(), metrics };
}

/** Returns { gone:true } when `since` is no longer retained (-> 410), else { events, offset }. */
export function replay(since) {
  const start = since + 1;
  const oldest = Math.max(FIRST_OFFSET, offset - CAP + 1);
  if (start < oldest) return { gone: true };
  if (start <= offset && Date.now() - ring.ts[start % CAP] > REPLAY_RETENTION_MS) return { gone: true };
  const events = [];
  for (let o = start; o <= offset; o++) events.push(eventAt(o));
  return { events, offset };
}

// ---------------------------------------------------------------- connections + chaos
const conns = new Set();

/** Effective per-connection behaviour = global chaos overridden by the connection's own query switches. */
function fxFor(transport, overrides) {
  const c = { ...getChaos(), ...overrides };
  const ws = parseFlags(c.ws);
  const sse = parseFlags(c.sse);
  const ch = parseFlags(c.chaos);
  const own = transport === 'ws' ? ws : sse;
  const pct = (flags, key, dflt) => (flags.has(key) ? Number(flags.get(key)) || dflt : 0);
  return {
    down: own.has('down'),
    silent: transport === 'ws' && ws.has('silent'),
    dropPct: Math.max(pct(ws, 'drop', 10), pct(sse, 'drop', 10)), // applies to both transports
    shuffle: ch.has('shuffle'),
    dupe: ch.has('dupe'),
    garbagePct: pct(ch, 'garbage', 5),
    killSec: Number(c.kill) || 0,
  };
}

export const transportDown = (transport, overrides) => fxFor(transport, overrides).down;

function armKill(conn) {
  const s = conn.fx.killSec;
  if (s === conn.killSec && (s === 0 || conn.killTimer)) return;
  clearTimeout(conn.killTimer);
  conn.killSec = s;
  conn.killTimer = s > 0 ? setTimeout(() => conn.io.close(), s * 1000) : null;
}

function register(transport, io, overrides) {
  const conn = { transport, io, overrides, delayed: [], killTimer: null, killSec: 0, fx: fxFor(transport, overrides) };
  armKill(conn);
  conns.add(conn);
  return conn;
}

function unregister(conn) {
  clearTimeout(conn.killTimer);
  conn.io.alive = false;
  conns.delete(conn);
}

onChaosChange(() => {
  for (const conn of [...conns]) {
    conn.fx = fxFor(conn.transport, conn.overrides);
    if (conn.fx.down) conn.io.close();
    else armKill(conn);
  }
});

export function attachWebSocket(ws, overrides) {
  const io = {
    alive: true,
    write: (s) => ws.send(s),
    buffered: () => ws.bufferedAmount,
    close: () => {
      ws.close(1012, 'chaos');
      setTimeout(() => ws.terminate(), 1000).unref();
    },
  };
  const conn = register('ws', io, overrides);
  ws.on('close', () => unregister(conn));
  ws.on('error', () => {});
}

export function attachSse(req, res, overrides) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': connected\n\n');
  const io = {
    alive: true,
    write: (s) => res.write(s),
    buffered: () => res.writableLength,
    close: () => res.end(),
  };
  const conn = register('sse', io, overrides);
  res.on('error', () => {});
  res.on('close', () => unregister(conn));
}

// ---------------------------------------------------------------- frames
const wrapMetric = (transport, o, payload) => (transport === 'ws' ? payload : `id: ${o}\nevent: metric\ndata: ${payload}\n\n`);
const wrapPing = (transport, ts) => {
  const p = JSON.stringify({ type: 'ping', ts });
  return transport === 'ws' ? p : `event: ping\ndata: ${p}\n\n`;
};

const REQUIRED = ['offset', 'serviceId', 'seq', 'ts', 'p95', 'errRate', 'rps', 'status'];
let garbleToggle = 0;
/** Alternates between invalid JSON and valid JSON with a missing required field, so both kinds occur. */
function garble(payload) {
  garbleToggle ^= 1;
  if (garbleToggle) return payload.slice(0, 1 + Math.floor(Math.random() * (payload.length - 1)));
  const obj = JSON.parse(payload);
  delete obj[REQUIRED[Math.floor(Math.random() * REQUIRED.length)]];
  return JSON.stringify(obj);
}

function write(conn, frame) {
  if (!conn.io.alive) return;
  if (conn.io.buffered() > MAX_BUFFERED_BYTES) return void conn.io.close(); // slow consumer
  conn.io.write(frame);
}

function push(conn, frame, now) {
  const { fx } = conn;
  // shuffle/dupe use a delay queue; max delay 900 ms keeps us under the contract's 1 s
  if (fx.shuffle) conn.delayed.push({ at: now + Math.random() * 900, frame });
  else write(conn, frame);
  if (fx.dupe && Math.random() < 0.1) conn.delayed.push({ at: now + Math.random() * 900, frame });
}

function deliver(first, last, now) {
  if (conns.size === 0) return;
  const cache = new Array(last - first + 1);
  const json = (o) => (cache[o - first] ??= JSON.stringify(eventAt(o)));
  for (const conn of conns) {
    const { fx } = conn;
    if (!conn.io.alive || (conn.transport === 'ws' && fx.silent)) continue;
    for (let o = first; o <= last; o++) {
      if (fx.dropPct && Math.random() * 100 < fx.dropPct) continue; // offset/seq are consumed -> a gap
      let payload = json(o);
      if (fx.garbagePct && Math.random() * 100 < fx.garbagePct) payload = garble(payload);
      push(conn, wrapMetric(conn.transport, o, payload), now);
    }
  }
}

// ---------------------------------------------------------------- loops
function currentRate() {
  let rate = getChaos().rate;
  for (const c of conns) if (c.overrides.rate > rate) rate = c.overrides.rate; // per-connection ?rate= raises the generator
  return rate;
}

let lastTick = performance.now();
let carry = 0;

function tick() {
  const t = performance.now();
  carry += ((t - lastTick) / 1000) * currentRate();
  lastTick = t;
  let n = Math.floor(carry);
  carry -= n;
  if (n > MAX_RATE) { n = MAX_RATE; carry = 0; } // event loop stalled: do not burst forever
  if (n <= 0) return;
  const now = Date.now();
  const first = offset + 1;
  for (let k = 0; k < n; k++) emitFor((Math.random() * N) | 0, now - Math.floor(((n - 1 - k) * TICK_MS) / n));
  deliver(first, offset, now);
}

export function startStreamLoops() {
  setInterval(tick, TICK_MS);
  setInterval(() => {
    const now = Date.now();
    for (const conn of conns) {
      if (!conn.delayed.length) continue;
      const due = [];
      const keep = [];
      for (const d of conn.delayed) (d.at <= now ? due : keep).push(d);
      conn.delayed = keep;
      due.sort((a, b) => a.at - b.at);
      for (const d of due) write(conn, d.frame);
    }
  }, 50);
  setInterval(() => {
    const ts = Date.now();
    for (const conn of conns) {
      if (conn.transport === 'ws' && conn.fx.silent) continue; // ws=silent: no events, no pings
      write(conn, wrapPing(conn.transport, ts));
    }
  }, PING_INTERVAL_MS);
}