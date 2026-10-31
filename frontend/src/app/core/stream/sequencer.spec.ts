import { Sequencer } from './sequencer';
import { MetricEvent } from './stream.models';

const ev = (offset: number, serviceId = 'svc-0001', seq = offset): MetricEvent => ({
  type: 'metric',
  offset,
  serviceId,
  seq,
  ts: 0,
  p95: 1,
  errRate: 0,
  rps: 1,
  status: 'healthy',
});

describe('Sequencer', () => {
  let now: number;
  let applied: number[];
  let seq: Sequencer;
  let overflowed: number;

  beforeEach(() => {
    now = 0;
    applied = [];
    overflowed = 0;
    seq = new Sequencer(
      { reorderWindowMs: 1000, maxBuffered: 5, now: () => now, onOverflow: () => overflowed++ },
      (e) => applied.push(e.offset),
    );
    seq.baseline(0);
  });

  it('applies in-order events straight away', () => {
    [1, 2, 3].forEach((o) => seq.push(ev(o)));
    expect(applied).toEqual([1, 2, 3]);
    expect(seq.lastAppliedOffset).toBe(3);
  });

  it('drops duplicates, whether already applied or still waiting in the buffer', () => {
    seq.push(ev(1));
    seq.push(ev(1));
    seq.push(ev(3));
    seq.push(ev(3));
    expect(applied).toEqual([1]);
    expect(seq.stats.duplicates).toBe(2);
  });

  it('applies out-of-order events in offset order', () => {
    [3, 1, 4, 2].forEach((o) => seq.push(ev(o)));
    expect(applied).toEqual([1, 2, 3, 4]);
    expect(seq.stats.reordered).toBe(2); // 3 and 4 had to wait
  });

  it('drops an event that arrives after its offset was already passed', () => {
    [1, 2, 3].forEach((o) => seq.push(ev(o)));
    seq.push(ev(2));
    expect(applied).toEqual([1, 2, 3]);
    expect(seq.stats.duplicates).toBe(1);
  });

  it('tolerates events up to 1 s late: no gap is reported inside the reorder window', () => {
    seq.push(ev(1));
    seq.push(ev(3));
    now = 999;
    expect(seq.hasGap()).toBe(false);
    seq.push(ev(2)); // the late one arrives
    expect(applied).toEqual([1, 2, 3]);
    now = 5000;
    expect(seq.hasGap()).toBe(false);
  });

  it('detects a gap once the missing offset is overdue, and a replay fills it', () => {
    seq.push(ev(1));
    seq.push(ev(3));
    seq.push(ev(4));
    now = 1001;
    expect(seq.hasGap()).toBe(true);

    // replay(since = lastApplied) returns everything after it, including events we already hold
    seq.applyReplay([ev(2), ev(3), ev(4)]);
    expect(applied).toEqual([1, 2, 3, 4]);
    expect(seq.hasGap()).toBe(false);
    expect(seq.stats.duplicates).toBe(0); // replayed overlap is not counted as live duplicates
  });

  it('holds events that arrive before the first baseline and drains the newer ones after it', () => {
    const fresh = new Sequencer({ reorderWindowMs: 1000, maxBuffered: 50, now: () => now }, (e) =>
      applied.push(e.offset),
    );
    applied = [];
    [5, 6, 7].forEach((o) => fresh.push(ev(o)));
    expect(applied).toEqual([]);
    fresh.baseline(5); // snapshot reflects offset 5
    expect(applied).toEqual([6, 7]);
  });

  it('asks for a resync instead of growing without bound', () => {
    [2, 3, 4, 5, 6, 7].forEach((o) => seq.push(ev(o))); // offset 1 never arrives
    expect(overflowed).toBe(1);
    expect(seq.isBaselined).toBe(false);
    expect(seq.stats.overflows).toBe(1);
  });
});
