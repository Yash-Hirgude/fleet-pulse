import { ChartBox, buildChartModel, niceCeil } from './chart-model';

const BOX: ChartBox = { width: 100, height: 60, left: 10, right: 10, top: 10, bottom: 10 };

describe('niceCeil', () => {
  it.each([
    [0, 1],
    [0.7, 1],
    [1.5, 2],
    [3, 5],
    [5.1, 10],
    [182, 200],
    [1340, 2000],
  ])('rounds %s up to %s', (input, expected) => expect(niceCeil(input)).toBe(expected));
});

describe('buildChartModel', () => {
  it('returns null for no data', () => {
    expect(buildChartModel([], BOX, 0)).toBeNull();
  });

  it('draws a path from the first to the last point inside the plot area', () => {
    const model = buildChartModel(
      [
        { ts: 0, v: 0 },
        { ts: 10, v: 100 },
      ],
      BOX,
      0,
    );
    expect(model?.path.startsWith('M10.0 ')).toBe(true);
    expect(model?.path).toContain('L90.0');
    expect(model?.last).toBe(100);
    expect(model?.yTicks).toHaveLength(3);
  });

  it('handles a single point', () => {
    expect(buildChartModel([{ ts: 5, v: 3 }], BOX, 0)?.path).toMatch(/^M50\.0 /);
  });

  it.each([Number.NaN, Infinity, -Infinity])(
    'throws for %s so the panel can show its own error',
    (bad) => {
      expect(() => buildChartModel([{ ts: 0, v: bad }], BOX, 0)).toThrow();
      expect(() => buildChartModel([{ ts: bad, v: 1 }], BOX, 0)).toThrow();
    },
  );
});
