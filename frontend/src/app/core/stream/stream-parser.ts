import { METRIC_STATUSES, MetricEvent, MetricStatus } from './stream.models';

export type ParsedFrame =
  | { readonly kind: 'metric'; readonly event: MetricEvent }
  | { readonly kind: 'ping'; readonly ts: number }
  | { readonly kind: 'malformed'; readonly reason: string };

const malformed = (reason: string): ParsedFrame => ({ kind: 'malformed', reason });
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Turns one raw frame into a typed message. Never throws: bad JSON or missing fields come back as 'malformed'. */
export function parseFrame(raw: string): ParsedFrame {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return malformed('invalid JSON');
  }
  if (typeof value !== 'object' || value === null) return malformed('not an object');
  const o = value as Record<string, unknown>;

  if (o['type'] === 'ping')
    return isNum(o['ts']) ? { kind: 'ping', ts: o['ts'] } : malformed('ping without ts');
  if (o['type'] !== 'metric') return malformed('unknown type');

  const { offset, serviceId, seq, ts, p95, errRate, rps, status } = o;
  if (!isInt(offset)) return malformed('offset missing or not an integer');
  if (typeof serviceId !== 'string' || serviceId === '') return malformed('serviceId missing');
  if (!isInt(seq)) return malformed('seq missing or not an integer');
  if (!isNum(ts)) return malformed('ts missing');
  if (!isNum(p95) || !isNum(errRate) || !isNum(rps)) return malformed('metric value missing');
  if (typeof status !== 'string' || !METRIC_STATUSES.includes(status as MetricStatus)) {
    return malformed('status missing or unknown');
  }
  return {
    kind: 'metric',
    event: {
      type: 'metric',
      offset,
      serviceId,
      seq,
      ts,
      p95,
      errRate,
      rps,
      status: status as MetricStatus,
    },
  };
}
