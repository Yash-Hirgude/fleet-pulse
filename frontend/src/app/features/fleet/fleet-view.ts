import { METRIC_STATUSES, MetricStatus } from '../../core/stream/stream.models';
import { ServiceRow } from '../../core/stream/metrics-store';

export type SortKey = 'name' | 'p95' | 'errRate' | 'rps' | 'status';
export type SortDir = 'asc' | 'desc';
export type StatusFilter = 'all' | MetricStatus;

export interface FleetQuery {
  readonly q: string;
  readonly status: StatusFilter;
  readonly sort: SortKey;
  readonly dir: SortDir;
}

export const SORT_KEYS: readonly SortKey[] = ['name', 'p95', 'errRate', 'rps', 'status'];
export const DEFAULT_QUERY: FleetQuery = { q: '', status: 'all', sort: 'name', dir: 'asc' };

/** Query-string values are untrusted: anything unknown falls back to the default instead of breaking the view. */
export function parseQuery(params: {
  q?: string | null;
  status?: string | null;
  sort?: string | null;
  dir?: string | null;
}): FleetQuery {
  const status = params.status;
  const sort = params.sort;
  return {
    q: params.q ?? DEFAULT_QUERY.q,
    status:
      status && (METRIC_STATUSES as readonly string[]).includes(status)
        ? (status as MetricStatus)
        : 'all',
    sort:
      sort && (SORT_KEYS as readonly string[]).includes(sort)
        ? (sort as SortKey)
        : DEFAULT_QUERY.sort,
    dir: params.dir === 'desc' ? 'desc' : 'asc',
  };
}

/** Defaults are left out (null removes the parameter) so a plain view has a clean URL. */
export function toQueryParams(query: FleetQuery): Record<string, string | null> {
  return {
    q: query.q || null,
    status: query.status === DEFAULT_QUERY.status ? null : query.status,
    sort: query.sort === DEFAULT_QUERY.sort ? null : query.sort,
    dir: query.dir === DEFAULT_QUERY.dir ? null : query.dir,
  };
}

const SEVERITY: Record<MetricStatus, number> = { healthy: 0, degraded: 1, down: 2 };

/** Filters and sorts. Reads each row's current metrics once, so callers should wrap it in `untracked`. */
export function applyQuery(rows: readonly ServiceRow[], query: FleetQuery): ServiceRow[] {
  const needle = query.q.trim().toLowerCase();
  const filtered = rows.filter(
    (row) =>
      (query.status === 'all' || row.metrics().status === query.status) &&
      (needle === '' || row.searchKey.includes(needle)),
  );

  const sign = query.dir === 'asc' ? 1 : -1;
  const value = (row: ServiceRow): number => {
    const m = row.metrics();
    switch (query.sort) {
      case 'p95':
        return m.p95;
      case 'errRate':
        return m.errRate;
      case 'rps':
        return m.rps;
      default:
        return SEVERITY[m.status];
    }
  };

  if (query.sort === 'name') {
    return filtered.sort(
      (a, b) =>
        sign * (a.nameKey < b.nameKey ? -1 : a.nameKey > b.nameKey ? 1 : a.id < b.id ? -1 : 1),
    );
  }
  // read every value once, then sort by the cached numbers (not 2,000 * log(2,000) signal reads)
  const keyed = filtered.map((row) => ({ row, v: value(row) }));
  keyed.sort((a, b) => sign * (a.v - b.v) || (a.row.id < b.row.id ? -1 : 1));
  return keyed.map((k) => k.row);
}
