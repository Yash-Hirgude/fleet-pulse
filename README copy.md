Assignment/demo project.: The backend is a mock, uses in-memory state and demo credentials, and is not production-ready.

## Requirements

For a clean local setup:

- Node.js 20 or newer: (Node.js 20 LTS recommended; frontend dependencies may require a current supported Node 20+ release).
- npm 10 or newer: (the frontend package declares npm 10.8.2 as its package manager).
- A modern browser.
- For containerized execution: Docker Desktop or Docker Engine with the Docker Compose v2 plugin.

Check versions:

node --version
npm --version
docker --version       # only needed for Docker
docker compose version # only needed for Docker


## Setup and run

The frontend and mock backend run as separate processes in local development. Start the backend first, then the frontend. Open two terminals from the repository root.

### 1. Mock backend

```bash
cd backend
npm ci
npm start
```

For development with Node's file watcher, use `npm run dev` instead of `npm start`.

- Primary HTTP API: `http://localhost:4000`
- Secondary listener: port `4001` by default (used for the mock's secondary-port behavior)
- Health check: `http://localhost:4000/health`
- WebSocket stream: `ws://localhost:4000/stream`
- SSE stream: `http://localhost:4000/stream/sse`

The backend is JavaScript ES modules running on Node.js with Express and `ws`. No database is required; generated metrics, replay history, rules and chaos configuration are in memory and reset when the backend restarts.

### 2. Frontend

In a second terminal, from the repository root:

```bash
cd frontend
npm ci
npm start
```

Open **http://localhost:4200**. The default development configuration calls `http://localhost:4000` and uses `ws://localhost:4000` for WebSocket connectivity. Keep the backend running while using the app.

### Demo accounts

Operator => id: `operator@pulse.dev` password: `pulse123` 
Viewer => id: `viewer@pulse.dev` password: `pulse123` 

## Tests and lint

Run these from `frontend/` after `npm ci`:

```bash
npm test
npx ng lint
npm run build
```

Equivalent lint script: `npm run lint`. To check formatting, run `npm run format:check`.

The backend has a smoke-test script. Start the backend in one terminal, then run from `backend/` in another:

```bash
npm ci
npm run smoke
```

The smoke test expects the backend to be reachable on its configured local port.

## Chaos switches

Chaos switches are controlled through `GET /chaos`, `POST /chaos`, and `DELETE /chaos`. The backend's defaults are `rate=500`, `ws=""`, `sse=""`, `chaos=""`, `token_ttl=60`, `http=""`, and `kill=0`.

Examples (backend must be running):

```bash
# Inspect current settings
curl http://localhost:4000/chaos

# Increase event rate (valid range 1–5000 events/second)
curl -X POST http://localhost:4000/chaos \
  -H 'Content-Type: application/json' \
  -d '{"rate":1000}'

# Force WebSocket down; try SSE fallback/recovery
curl -X POST http://localhost:4000/chaos \
  -H 'Content-Type: application/json' \
  -d '{"ws":"down"}'

# Force SSE down
curl -X POST http://localhost:4000/chaos \
  -H 'Content-Type: application/json' \
  -d '{"sse":"down"}'

# Inject HTTP 500s on eligible primary-port REST requests
curl -X POST http://localhost:4000/chaos \
  -H 'Content-Type: application/json' \
  -d '{"http":"500:50"}'

# Inject HTTP 429 responses
curl -X POST http://localhost:4000/chaos \
  -H 'Content-Type: application/json' \
  -d '{"http":"429"}'

# Add 1-second latency to eligible primary-port REST requests
curl -X POST http://localhost:4000/chaos \
  -H 'Content-Type: application/json' \
  -d '{"http":"slow:1000"}'

# Short token lifetime to exercise refresh handling
curl -X POST http://localhost:4000/chaos \
  -H 'Content-Type: application/json' \
  -d '{"token_ttl":10}'

# Reset all switches to defaults
curl -X DELETE http://localhost:4000/chaos
```

The `ws` and `sse` switches accept the backend's transport fault syntax; the `http` switch supports `429`, `500:<percentage>`, and `slow:<milliseconds>`. HTTP chaos applies to eligible REST requests on the primary listener and deliberately excludes auth, chaos, health and stream routes. Inspect `backend/src/chaos.js` and `backend/src/stream.js` for exact supported values and behavior before using other combinations. Switch values are strings for transport fault modes, for example `{"ws":"down"}`.

## Docker Compose

Docker Desktop/Engine and the Compose v2 plugin must be installed and running. From the repository root:

```bash
docker compose up --build
```

Then open http://localhost:4200. The backend is exposed at `http://localhost:4000`; its health endpoint is `http://localhost:4000/health`.

## Architecture

### Frontend stream pipeline

```text
Backend WebSocket / SSE
          |
          v
Transport adapter (selected by ConnectionManager)
          |
          v
Frame parser — validate JSON and classify metric / ping / malformed frames
          |
          v
Sequencer — deduplicate, buffer out-of-order offsets, apply in offset order
          |                         |
          |                         +--> gap detection --> replay request / snapshot recovery
          v
MetricsStore — update service state and batch UI-facing signal updates
          |
          +--> Fleet table and service health
          +--> Service detail charts / history
          +--> Freshness and connection status indicators
          +--> Alert/rule evaluation and notifications
```

`ConnectionManager` coordinates the transport lifecycle: connect, heartbeat monitoring, reconnect/backoff, fallback between transports and periodic attempts to return to the preferred transport. `StreamService` connects the transport, parser, sequencer and metrics store. REST requests use the shared `ApiClient` and HTTP interceptors.

### Frontend code organisation

```text
frontend/src/app/
├── core/
│   ├── auth/       # session state, route guard, auth interceptor
│   ├── config/     # typed app configuration and tunable thresholds
│   ├── http/       # API client, timeout/retry interceptors, API errors
│   ├── stream/     # transports, connection manager, parser, sequencer, metrics store
│   ├── alerts/     # alert evaluation, notifier and settings
│   └── rules/      # rule models and state/store
├── features/
│   ├── auth/       # login
│   ├── fleet/      # fleet table and overview
│   ├── service-detail/ # per-service metrics/history charts
│   ├── rules/      # rule list, editor and validation
│   ├── settings/   # application settings
│   └── shell/      # shared layout, connection status and incident panel
├── app.config.ts
├── app.routes.ts
└── app.ts
```

The configuration is provided through Angular dependency injection so stream, HTTP and UI thresholds can be overridden in tests. The application uses standalone Angular components, signals for reactive state, and RxJS for asynchronous streams and HTTP.

## Resilience decisions

> The prompt provided with this README requires decisions for R1–R4 but does not include the full text defining those labels. The four entries below document the implemented resilience areas visible in this repository; align their labels with the original rubric if its R1–R4 definitions differ.

### R1 — Stream connection and transport recovery

Built: A connection manager owns stream lifecycle and transport selection. It monitors heartbeat/ping activity, applies bounded exponential backoff, reconnects after failures, falls back after repeated failures and periodically tries to return to the preferred transport. Connection status is exposed to the UI.

Why: A single long-lived connection cannot be assumed reliable. Explicit lifecycle ownership prevents transport adapters and UI components from independently starting competing reconnect loops.

Production alternative: Use server-side health/telemetry and a documented transport policy; add jitter to reconnect schedules, instrument recovery times, and test behavior under real proxies/load balancers. Avoid endless retry storms during a regional outage.

### R2 — Ordered, duplicate-safe stream processing and gap recovery

Built: Incoming frames are validated before use. The sequencer orders events by offset, discards duplicates/already-applied offsets, buffers out-of-order events within configured limits and detects gaps. Recovery requests replay after the last known offset and can fall back to a snapshot when necessary.

Why: Reconnects and network buffering can produce duplicates or delayed frames. Applying data blindly could regress metrics or leave the dashboard inconsistent after a disconnect.

Production alternative: Define durable event IDs and retention guarantees with the backend, expose replay-gap and buffer-overflow telemetry, and use a server snapshot/replay protocol with explicit consistency semantics. Tune buffer limits using measured event sizes and peak rates.

### R3 — HTTP failure handling and authentication refresh

Built: HTTP requests have a timeout and retry policy for configured transient statuses (`429`, `502`, `503`, `504`) with bounded delays. Authentication uses an interceptor to attach access tokens and coordinates refresh for concurrent expired-token responses; refresh failure ends the session.

Why: Slow endpoints and expired credentials should not leave requests hanging or trigger a refresh storm. Only retrying selected statuses avoids retrying every permanent client error.

Production alternative: Respect `Retry-After`, add jitter and request idempotency where retries could duplicate writes, use secure cookie-based refresh tokens with CSRF protections as appropriate, and rely on a production identity provider. This mock's tokens and credentials are not security controls.

### R4 — UI update cost, freshness and bounded state

Built: Metric updates are buffered and flushed on a configured interval rather than forcing every incoming event to repaint the whole table. The store tracks per-service metrics/status changes; the UI uses virtual scrolling/overscan and bounded chart history/incident collections. Freshness is based on a configurable stale threshold.

Why: A dashboard for 2,000 services can receive many events per second. Batching, bounded collections and limiting rendered rows reduce avoidable change-detection and DOM work.

Production alternative: Profile with representative hardware and production builds, use browser performance traces and real user monitoring, and tune flush interval, row overscan and chart point limits from observed latency and CPU/memory measurements. Consider server-side aggregation/downsampling for long time ranges.

## Performance and measurement

Do not treat design limits as measured results. The repository configures a 250 ms UI flush interval, 2,000 mock services, a default stream rate of 500 events/second (the mock accepts up to 5,000), a 20,000-event frontend reorder buffer and a chart cap of 300 points. These are implementation settings.

## Mock backend

- Language/runtime: JavaScript ES modules on Node.js 20+.
- Framework/libraries: Express 4, `ws`, and `cors`.
- Data: 2,000 generated services, synthetic metrics, in-memory history/replay ring buffer, mock auth, rules and chaos controls.
- Ports: 4000 primary API/stream listener and 4001 secondary listener by default.
- Additions beyond basic REST: WebSocket and SSE streaming, heartbeat/ping behavior, offset-based replay, snapshot/history endpoints, authentication/refresh endpoints, rule-management routes, health endpoint and fault injection.

Main endpoints include:

`GET /health` => Health check 
`POST /auth/login`, `POST /auth/refresh` => Demo login and token refresh 
`GET /services` => Service list (authenticated) 
`GET /metrics/snapshot` => Current metrics snapshot (authenticated) 
`GET /metrics/history?serviceId=svc-0001&minutes=15` => Historical service metrics (authenticated) 
`GET /metrics/replay?since=<offset>` => Replay events after an offset (authenticated) 
`GET /stream/sse` => SSE metric stream (authenticated) 
`WS /stream` => WebSocket metric stream (authenticated) 
`GET /chaos`, `POST /chaos`, `DELETE /chaos` => Read, configure and reset chaos settings 
`/rules` => Rule-management routes 

## Trade-offs and shortcuts

- Metrics, users, token state, history and rules are mock/in-memory; there is no durable database or real microservice telemetry.
- Demo credentials and token handling are intentionally simplified.
- The mock supports a finite set of chaos switches.
- Docker Compose is a local evaluation setup, not a hardened deployment: it has no TLS termination, secrets management, persistent storage.

## AI usage

- ClaudeCode: Used for coding assitance. To write general logic and code as per the mentioned requirements. To find the hidden scenarios and debug. Used to implement the modern coding and design patterns.
- Gemini/Chatgpt: Used for general queries relatd to Angular applicaions. Also used to make System Design and architecture decisions.
