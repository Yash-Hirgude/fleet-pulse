import { MetricEvent } from './stream.models';

export interface SequencerStats {
  /** Metric events handed to push() from the live stream (replays are not counted). */
  received: number;
  /** Events passed on to the sink, in offset order. */
  applied: number;
  /** Events dropped because their offset was already applied or already buffered. */
  duplicates: number;
  /** Events that had to wait in the buffer for an earlier offset before being applied. */
  reordered: number;
  overflows: number;
}

export interface SequencerOptions {
  /** A missing offset is only treated as a gap once a later event has waited this long. */
  readonly reorderWindowMs: number;
  readonly maxBuffered: number;
  readonly now: () => number;
  /** The buffer grew past maxBuffered: events were discarded, the owner must reload a snapshot. */
  readonly onOverflow?: () => void;
}

interface Buffered {
  readonly event: MetricEvent;
  readonly at: number;
}

/**
 * Puts the live stream back into order. The global `offset` rises by exactly 1 for every event the server
 * generates, so the stream is a gapless sequence and:
 *   - an offset below the next expected one is a duplicate;
 *   - an offset above it is early: it waits in a buffer (this is how out-of-order events up to 1 s late are fixed);
 *   - a hole that is still open after the reorder window is a real gap, to be filled from /metrics/replay.
 * Events are handed to the sink strictly in offset order.
 */
export class Sequencer {
  readonly stats: SequencerStats = { received: 0, applied: 0, duplicates: 0, reordered: 0, overflows: 0 };
  private expected: number | null = null;
  private readonly buffer = new Map<number, Buffered>();

  constructor(
    private readonly opts: SequencerOptions,
    private readonly sink: (event: MetricEvent) => void,
  ) {}

  get isBaselined(): boolean {
    return this.expected !== null;
  }

  /** Offset of the last event handed to the sink, or null before the first baseline. */
  get lastAppliedOffset(): number | null {
    return this.expected === null ? null : this.expected - 1;
  }

  /** Declares that everything up to `offset` is already known (a snapshot was applied). */
  baseline(offset: number): void {
    this.expected = offset + 1;
    for (const o of [...this.buffer.keys()]) if (o < this.expected) this.buffer.delete(o);
    this.drain();
  }

  push(event: MetricEvent, fromReplay = false): void {
    if (!fromReplay) this.stats.received++;
    if (this.expected !== null && event.offset < this.expected) return this.duplicate(fromReplay);
    if (this.buffer.has(event.offset)) return this.duplicate(fromReplay);

    if (event.offset === this.expected) {
      this.apply(event);
      this.expected++;
      this.drain();
      return;
    }
    // early (a hole before it) or not baselined yet: hold it back
    this.buffer.set(event.offset, { event, at: this.opts.now() });
    if (this.buffer.size > this.opts.maxBuffered) {
      this.buffer.clear();
      this.expected = null;
      this.stats.overflows++;
      this.opts.onOverflow?.();
    }
  }

  /** Events from /metrics/replay, in offset order. They go through the same path, minus the live counters. */
  applyReplay(events: readonly MetricEvent[]): void {
    for (const event of events) this.push(event, true);
  }

  /** True when an offset has been missing for longer than the reorder window while later events wait. */
  hasGap(): boolean {
    if (this.expected === null || this.buffer.size === 0) return false;
    let oldest = Infinity;
    for (const { at } of this.buffer.values()) if (at < oldest) oldest = at;
    return this.opts.now() - oldest > this.opts.reorderWindowMs;
  }

  private duplicate(fromReplay: boolean): void {
    if (!fromReplay) this.stats.duplicates++;
  }

  private drain(): void {
    while (this.expected !== null) {
      const next = this.buffer.get(this.expected);
      if (!next) return;
      this.buffer.delete(this.expected);
      this.apply(next.event);
      this.expected++;
      this.stats.reordered++;
    }
  }

  private apply(event: MetricEvent): void {
    this.stats.applied++;
    this.sink(event);
  }
}