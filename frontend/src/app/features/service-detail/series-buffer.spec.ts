import { SeriesBuffer } from './series-buffer';

const BUCKET = 3000;
const MAX = 300;
const make = () => new SeriesBuffer(BUCKET, MAX);

describe('SeriesBuffer (data reduction for charts)', () => {
  it('reduces 15 minutes of 1-second history (900 points) to 300 points', () => {
    const buffer = make();
    const start = 1_700_000_100_000;
    for (let i = 0; i < 900; i++) buffer.add(start + i * 1000, 100 + i, 1, 1000);
    expect(buffer.points()).toHaveLength(300);
  });

  it('never holds more than 300 points, however many samples arrive', () => {
    const buffer = make();
    const start = 1_700_000_000_000;
    // a burst: 100,000 samples over 15 minutes, then 100,000 more over the next 15 minutes
    for (let i = 0; i < 200_000; i++) buffer.add(start + i * 9, 1, 1, 1);
    expect(buffer.points().length).toBeLessThanOrEqual(MAX);
  });

  it('keeps the worst latency and error rate of a bucket, so spikes are not averaged away; throughput is the mean', () => {
    const buffer = make();
    buffer.add(0, 100, 1, 1000);
    buffer.add(1000, 900, 7, 3000); // same 3 s bucket
    buffer.add(2000, 120, 2, 2000);
    expect(buffer.points()).toEqual([{ ts: 0, p95: 900, errRate: 7, rps: 2000 }]);
  });

  it('gives the same result whatever order history and live samples arrive in', () => {
    const samples = Array.from({ length: 600 }, (_, i) => ({
      ts: i * 1000,
      p95: (i * 37) % 500,
      err: (i * 11) % 9,
      rps: i,
    }));
    const forward = make();
    const shuffled = make();
    samples.forEach((s) => forward.add(s.ts, s.p95, s.err, s.rps));
    [...samples].reverse().forEach((s) => shuffled.add(s.ts, s.p95, s.err, s.rps));
    expect(shuffled.points()).toEqual(forward.points());
  });

  it('slides the window as newer samples arrive and drops what fell out of it', () => {
    const buffer = make();
    buffer.add(0, 1, 1, 1);
    buffer.add(MAX * BUCKET, 2, 2, 2); // exactly one window later
    const points = buffer.points();
    expect(points.map((p) => p.ts)).toEqual([MAX * BUCKET]);
    buffer.add(0, 9, 9, 9); // far older than the window: ignored
    expect(buffer.points()).toHaveLength(1);
  });

  it('refuses samples with non-finite values and counts them', () => {
    const buffer = make();
    buffer.add(0, Number.NaN, 1, 1);
    buffer.add(0, 1, Infinity, 1);
    buffer.add(Number.NaN, 1, 1, 1);
    expect(buffer.points()).toEqual([]);
    expect(buffer.rejected).toBe(3);
  });
});
