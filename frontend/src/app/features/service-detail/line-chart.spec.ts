import { TestBed } from '@angular/core/testing';
import { LineChart } from './line-chart';

function render(points: { ts: number; v: number }[]) {
  const fixture = TestBed.createComponent(LineChart);
  fixture.componentRef.setInput('title', 'p95 latency');
  fixture.componentRef.setInput('unit', 'ms');
  fixture.componentRef.setInput('points', points);
  return fixture;
}

describe('LineChart', () => {
  it('draws the line for valid data', async () => {
    const fixture = render([
      { ts: 0, v: 100 },
      { ts: 3000, v: 200 },
    ]);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('path.line')?.getAttribute('d')).toMatch(/^M/);
    expect(el.querySelector('svg')?.getAttribute('aria-label')).toContain('latest 200');
  });

  it('shows "No data yet" when there are no points', async () => {
    const fixture = render([]);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No data yet');
  });

  it('shows its own error with a Retry button for bad data instead of throwing, and Retry emits', async () => {
    const fixture = render([{ ts: 0, v: Number.NaN }]);
    let retried = 0;
    fixture.componentInstance.retry.subscribe(() => retried++);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('could not be drawn');
    el.querySelector<HTMLButtonElement>('button')?.click();
    expect(retried).toBe(1);
  });
});
