import { backoffDelayMs } from './backoff';

const cfg = { baseMs: 1000, maxMs: 30_000 };

describe('backoffDelayMs', () => {
  it('grows with each consecutive failure', () => {
    const delays = [1, 2, 3, 4, 5].map((n) => backoffDelayMs(n, cfg, () => 1));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000]);
  });

  it('never exceeds the 30 s cap', () => {
    expect(backoffDelayMs(6, cfg, () => 1)).toBe(30_000);
    expect(backoffDelayMs(50, cfg, () => 1)).toBe(30_000);
  });

  it('is jittered inside [exp/2, exp] so clients do not reconnect in lockstep', () => {
    expect(backoffDelayMs(3, cfg, () => 0)).toBe(2000);
    expect(backoffDelayMs(3, cfg, () => 1)).toBe(4000);
    const samples = new Set(Array.from({ length: 50 }, () => backoffDelayMs(3, cfg)));
    expect(samples.size).toBeGreaterThan(10);
    samples.forEach((d) => {
      expect(d).toBeGreaterThanOrEqual(2000);
      expect(d).toBeLessThanOrEqual(4000);
    });
  });
});
