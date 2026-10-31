import { parseFrame } from './stream-parser';

const valid = {
  type: 'metric',
  offset: 9182733,
  serviceId: 'svc-0412',
  seq: 18233,
  ts: 1791302400123,
  p95: 182,
  errRate: 0.7,
  rps: 1340,
  status: 'degraded',
};

describe('parseFrame', () => {
  it('parses a metric event', () => {
    expect(parseFrame(JSON.stringify(valid))).toEqual({ kind: 'metric', event: valid });
  });

  it('parses a ping', () => {
    expect(parseFrame('{"type":"ping","ts":1791302400123}')).toEqual({
      kind: 'ping',
      ts: 1791302400123,
    });
  });

  it('reports invalid JSON as malformed instead of throwing', () => {
    expect(parseFrame('{"type":"metric","offset":')).toMatchObject({ kind: 'malformed' });
    expect(parseFrame('not json at all')).toMatchObject({ kind: 'malformed' });
    expect(parseFrame('null')).toMatchObject({ kind: 'malformed' });
  });

  it.each(['offset', 'serviceId', 'seq', 'ts', 'p95', 'errRate', 'rps', 'status'])(
    'reports a metric event without %s as malformed',
    (field) => {
      const rest: Record<string, unknown> = { ...valid };
      delete rest[field];
      expect(parseFrame(JSON.stringify(rest))).toMatchObject({ kind: 'malformed' });
    },
  );

  it('rejects wrong types and unknown values', () => {
    expect(parseFrame(JSON.stringify({ ...valid, offset: '1' }))).toMatchObject({
      kind: 'malformed',
    });
    expect(parseFrame(JSON.stringify({ ...valid, p95: null }))).toMatchObject({
      kind: 'malformed',
    });
    expect(parseFrame(JSON.stringify({ ...valid, status: 'on-fire' }))).toMatchObject({
      kind: 'malformed',
    });
    expect(parseFrame('{"type":"mystery"}')).toMatchObject({ kind: 'malformed' });
  });
});
