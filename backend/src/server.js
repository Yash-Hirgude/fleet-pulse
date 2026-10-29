import http from 'node:http';
import cors from 'cors';
import express from 'express';
import { WebSocketServer } from 'ws';
import { PORT, SECONDARY_PORT } from './config.js';
import { ApiError, sendError } from './errors.js';
import { authRouter, bearerFrom, checkAccessToken, requireAuth } from './auth.js';
import { getChaos, httpChaos, pickSwitches, resetChaos, setChaos } from './chaos.js';
import { SERVICES, history, serviceIndex } from './data.js';
import { rulesRouter } from './rules.js';
import { attachSse, attachWebSocket, replay, serviceList, snapshot, startStreamLoops, transportDown } from './stream.js';

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: true, exposedHeaders: ['Retry-After', 'Idempotency-Replayed'] }));
app.use(express.json({ limit: '1mb' }));
app.use(httpChaos);

// ---- public
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/chaos', (_req, res) => res.json(getChaos()));
app.post('/chaos', (req, res) => res.json(setChaos(req.body ?? {})));
app.delete('/chaos', (_req, res) => res.json(resetChaos()));
app.use('/auth', authRouter);

// ---- authenticated
app.use(requireAuth);

app.get('/services', (_req, res) => res.json(serviceList()));
app.get('/metrics/snapshot', (_req, res) => res.json(snapshot()));

app.get('/metrics/history', (req, res) => {
  const idx = serviceIndex(req.query.serviceId);
  if (idx < 0) throw new ApiError(404, 'not_found', 'Unknown serviceId');
  const minutes = req.query.minutes === undefined ? 15 : Number(req.query.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    throw new ApiError(400, 'bad_request', 'minutes must be an integer between 1 and 60');
  }
  res.json(history(idx, minutes));
});

app.get('/metrics/replay', (req, res) => {
  const since = Number(req.query.since);
  if (!Number.isInteger(since) || since < 0) throw new ApiError(400, 'bad_request', 'since must be a non-negative integer');
  const result = replay(since);
  if (result.gone) throw new ApiError(410, 'replay_too_old', 'Requested offset is no longer retained');
  res.json(result);
});

app.use('/rules', rulesRouter);

app.post('/telemetry', (req, res) => {
  const errors = req.body?.errors;
  if (!Array.isArray(errors)) throw new ApiError(400, 'bad_request', 'errors must be an array');
  console.log(`[telemetry] received ${errors.length} client error(s)`);
  res.status(202).json({});
});

app.get('/stream/sse', (req, res) => {
  const overrides = pickSwitches(req.query);
  if (transportDown('sse', overrides)) throw new ApiError(503, 'unavailable', 'SSE transport is down (chaos)');
  attachSse(req, res, overrides);
});

app.use((_req, res) => sendError(res, 404, 'not_found', 'Route not found'));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof ApiError) return sendError(res, err.status, err.code, err.message, err.details);
  if (err.type === 'entity.parse.failed') return sendError(res, 400, 'bad_request', 'Malformed JSON body');
  console.error(err);
  return sendError(res, 500, 'server_error', 'Internal server error');
});

// ---- WebSocket /stream
const wss = new WebSocketServer({ noServer: true });

function onUpgrade(req, socket, head) {
  socket.on('error', () => {});
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/stream') return void socket.destroy();

  const query = Object.fromEntries(url.searchParams);
  const overrides = pickSwitches(query);
  if (transportDown('ws', overrides)) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return void socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const auth = checkAccessToken(query.access_token || bearerFrom(req.headers.authorization));
    if (!auth.ok) return void ws.close(4401, auth.code); // contract: invalid token closes with 4401
    attachWebSocket(ws, overrides);
  });
}

for (const port of [PORT, SECONDARY_PORT].filter(Boolean)) {
  const server = http.createServer(app);
  server.on('upgrade', onUpgrade);
  server.listen(port, () => console.log(`[mock] listening on :${port} (${SERVICES.length} services)`));
}
startStreamLoops();