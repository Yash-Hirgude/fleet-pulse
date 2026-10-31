import { ServiceRow } from '../../core/stream/metrics-store';
import { MetricStatus } from '../../core/stream/stream.models';
import { DEFAULT_QUERY, applyQuery, parseQuery, toQueryParams } from './fleet-view';

const row = (
  id: string,
  name: string,
  team: string,
  p95: number,
  errRate: number,
  rps: number,
  status: MetricStatus,
) => new ServiceRow(id, name, team, { p95, errRate, rps, status, ts: 0, statusChanges: 0 });

const rows = [
  row('svc-0001', 'payments-api', 'payments', 300, 0.4, 900, 'healthy'),
  row('svc-0002', 'auth-cache', 'auth', 40, 5, 100, 'degraded'),
  row('svc-0003', 'checkout-edge', 'checkout', 700, 30, 50, 'down'),
  row('svc-0004', 'payments-worker', 'payments', 120, 0.1, 400, 'healthy'),
];
const ids = (list: ServiceRow[]) => list.map((r) => r.id);

describe('applyQuery', () => {
  it('sorts by name by default', () => {
    expect(ids(applyQuery(rows, DEFAULT_QUERY))).toEqual([
      'svc-0002',
      'svc-0003',
      'svc-0001',
      'svc-0004',
    ]);
  });

  it.each([
    ['p95', 'asc', ['svc-0002', 'svc-0004', 'svc-0001', 'svc-0003']],
    ['p95', 'desc', ['svc-0003', 'svc-0001', 'svc-0004', 'svc-0002']],
    ['errRate', 'desc', ['svc-0003', 'svc-0002', 'svc-0001', 'svc-0004']],
    ['rps', 'asc', ['svc-0003', 'svc-0002', 'svc-0004', 'svc-0001']],
    ['status', 'desc', ['svc-0003', 'svc-0002', 'svc-0001', 'svc-0004']],
  ] as const)('sorts by %s %s', (sort, dir, expected) => {
    expect(ids(applyQuery(rows, { ...DEFAULT_QUERY, sort, dir }))).toEqual(expected);
  });

  it('filters by status', () => {
    expect(ids(applyQuery(rows, { ...DEFAULT_QUERY, status: 'healthy' }))).toEqual([
      'svc-0001',
      'svc-0004',
    ]);
  });

  it('searches name, team and id, case-insensitively', () => {
    expect(ids(applyQuery(rows, { ...DEFAULT_QUERY, q: 'PAYMENTS' }))).toEqual([
      'svc-0001',
      'svc-0004',
    ]);
    expect(ids(applyQuery(rows, { ...DEFAULT_QUERY, q: 'svc-0003' }))).toEqual(['svc-0003']);
  });

  it('combines search, filter and sort', () => {
    const q = {
      q: 'payments',
      status: 'healthy' as const,
      sort: 'p95' as const,
      dir: 'asc' as const,
    };
    expect(ids(applyQuery(rows, q))).toEqual(['svc-0004', 'svc-0001']);
  });
});

describe('URL state', () => {
  it('round-trips a view through query parameters', () => {
    const view = { q: 'pay', status: 'down' as const, sort: 'rps' as const, dir: 'desc' as const };
    expect(parseQuery(toQueryParams(view) as Record<string, string | null>)).toEqual(view);
  });

  it('leaves defaults out of the URL', () => {
    expect(toQueryParams(DEFAULT_QUERY)).toEqual({ q: null, status: null, sort: null, dir: null });
  });

  it('falls back to defaults for unknown or hostile values', () => {
    expect(parseQuery({ status: 'on-fire', sort: '__proto__', dir: 'sideways' })).toEqual(
      DEFAULT_QUERY,
    );
  });
});
