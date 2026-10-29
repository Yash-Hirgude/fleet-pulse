// All tunables of the mock live here.
export const PORT = Number(process.env.PORT) || 4000;
// Second listener, same app, never affected by HTTP chaos (circuit-breaker stretch goal). 0 disables it.
export const SECONDARY_PORT = process.env.SECONDARY_PORT === undefined ? 4001 : Number(process.env.SECONDARY_PORT);

export const SERVICE_COUNT = 2000;
export const BASE_OFFSET = 9_000_000; // first event gets BASE_OFFSET + 1
export const MAX_RATE = 5000;
export const TICK_MS = 10;
export const PING_INTERVAL_MS = 5000;

// Replay ring buffer: sized for 5000 ev/s * ~340 s, and additionally capped by age.
export const RING_CAPACITY = 1_700_000;
export const REPLAY_RETENTION_MS = 6 * 60 * 1000;

export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024; // drop slow consumers