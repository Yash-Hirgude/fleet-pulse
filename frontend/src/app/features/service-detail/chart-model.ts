export interface ChartPoint {
  readonly ts: number;
  readonly v: number;
}

export interface ChartModel {
  readonly path: string;
  readonly yTicks: readonly { readonly y: number; readonly label: string }[];
  readonly firstTs: number;
  readonly lastTs: number;
  readonly last: number;
  readonly min: number;
  readonly max: number;
}

export interface ChartBox {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** Smallest 1, 2, 5 x 10^n at or above `v`, so axis labels are round numbers. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const f = v / 10 ** exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * 10 ** exp;
}

/**
 * Turns points into SVG geometry. Pure, and strict: a non-finite value throws, which the chart turns into
 * its own error panel instead of drawing garbage or taking the page down.
 */
export function buildChartModel(
  points: readonly ChartPoint[],
  box: ChartBox,
  decimals: number,
): ChartModel | null {
  if (points.length === 0) return null;
  for (const p of points) {
    if (!Number.isFinite(p.ts) || !Number.isFinite(p.v))
      throw new Error('chart data contains a non-finite value');
  }

  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const yMax = niceCeil(max * 1.1);
  const firstTs = points[0].ts;
  const lastTs = points[points.length - 1].ts;
  const plotW = box.width - box.left - box.right;
  const plotH = box.height - box.top - box.bottom;

  const x = (ts: number) =>
    box.left + (lastTs === firstTs ? plotW / 2 : ((ts - firstTs) / (lastTs - firstTs)) * plotW);
  const y = (v: number) => box.top + plotH - (v / yMax) * plotH;

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.ts).toFixed(1)} ${y(p.v).toFixed(1)}`)
    .join(' ');
  const yTicks = [0, 0.5, 1].map((f) => ({ y: y(f * yMax), label: (f * yMax).toFixed(decimals) }));
  return { path, yTicks, firstTs, lastTs, last: points[points.length - 1].v, min, max };
}
