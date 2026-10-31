export interface BackoffConfig {
  readonly baseMs: number;
  readonly maxMs: number;
}

/**
 * Delay before reconnect attempt number `failures` (1 = first failure). Exponential, capped, with "equal jitter":
 * the result is uniformly random in [exp/2, exp], so a thousand clients that lost the server together do not
 * come back in lockstep. A successful connection resets `failures` to 0 (done by the caller).
 */
export function backoffDelayMs(failures: number, cfg: BackoffConfig, random: () => number = Math.random): number {
  const exp = Math.min(cfg.baseMs * 2 ** Math.max(0, failures - 1), cfg.maxMs);
  return Math.round(exp / 2 + random() * (exp / 2));
}