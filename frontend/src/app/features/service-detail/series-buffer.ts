export interface SeriesPoint {
  readonly ts: number;
  readonly p95: number;
  readonly errRate: number;
  readonly rps: number;
}

interface Bucket {
  p95: number; // worst value in the bucket
  err: number; // worst value in the bucket
  rpsSum: number;
  n: number;
}

/**
 * The data behind one service's three charts, reduced to at most `maxPoints` points.
 *
 * Reduction is fixed-width time bucketing: the window is `maxPoints` buckets wide (15 min / 300 = 3 s each), and
 * every sample, whether it comes from the REST history or from the live stream, falls into the bucket of its
 * timestamp. Latency and error rate keep the worst value of the bucket, so a spike is never averaged away;
 * throughput keeps the mean.
 *
 * Because a bucket's value does not depend on the order samples arrive in, history and live points can be added in
 * any order and overlap freely. The window ends at the newest sample, so a skewed clock cannot empty the chart.
 */
export class SeriesBuffer {
  private readonly buckets = new Map<number, Bucket>();
  private newestKey = -Infinity;
  /** Samples refused because a value was not a finite number. */
  rejected = 0;

  constructor(
    readonly bucketMs: number,
    readonly maxPoints: number,
  ) {}

  add(ts: number, p95: number, errRate: number, rps: number): void {
    if (![ts, p95, errRate, rps].every(Number.isFinite)) {
      this.rejected++;
      return;
    }
    const key = Math.floor(ts / this.bucketMs);
    if (key < this.newestKey - this.maxPoints + 1) return; // older than the window

    const bucket = this.buckets.get(key);
    if (bucket) {
      bucket.p95 = Math.max(bucket.p95, p95);
      bucket.err = Math.max(bucket.err, errRate);
      bucket.rpsSum += rps;
      bucket.n++;
    } else {
      this.buckets.set(key, { p95, err: errRate, rpsSum: rps, n: 1 });
    }
    if (key > this.newestKey) {
      this.newestKey = key;
      this.prune();
    }
  }

  addMany(points: readonly SeriesPoint[]): void {
    for (const p of points) this.add(p.ts, p.p95, p.errRate, p.rps);
  }

  /** Oldest first. Never more than `maxPoints` long: the keys live in a window that wide. */
  points(): SeriesPoint[] {
    const min = this.newestKey - this.maxPoints + 1;
    return [...this.buckets.keys()]
      .filter((key) => key >= min)
      .sort((a, b) => a - b)
      .map((key) => {
        const b = this.buckets.get(key) as Bucket;
        return { ts: key * this.bucketMs, p95: b.p95, errRate: b.err, rps: b.rpsSum / b.n };
      });
  }

  private prune(): void {
    const min = this.newestKey - this.maxPoints + 1;
    for (const key of this.buckets.keys()) if (key < min) this.buckets.delete(key);
  }
}
