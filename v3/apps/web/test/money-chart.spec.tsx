import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MoneyChart, type ChartPoint } from '@/components/money-chart';

/**
 * The bar chart, against `24_MONEYCHART_DECISION.md`.
 *
 * jsdom draws nothing, so what is asserted is what the chart MEANS: the bar
 * geometry the data implies, that exactly one bar carries a label, that the
 * accessible equivalent is always in the document, and that an empty or
 * loading chart never draws a plot.
 */

const fmt = (v: number) => `${v} تومان`;

const POINTS: ChartPoint[] = [
  { key: '2026-09-01', label: 'روز اول', value: 100, detail: '۱ سفارش' },
  { key: '2026-09-02', label: 'روز دوم', value: 400, detail: '۴ سفارش' },
  { key: '2026-09-03', label: 'روز سوم', value: 0, detail: '۰ سفارش' },
  { key: '2026-09-04', label: 'روز چهارم', value: 1, detail: '۱ سفارش' },
];

function renderChart(points: ChartPoint[] = POINTS, over: Partial<React.ComponentProps<typeof MoneyChart>> = {}) {
  return render(
    <MoneyChart
      points={points}
      title="روند روزانهٔ فروش"
      formatValue={fmt}
      valueHeading="فروش"
      detailHeading="سفارش"
      emptyMessage="هنوز داده‌ای برای این بازه نیست."
      {...over}
    />,
  );
}

/** The visible bars (not the transparent hit areas), in DOM order. */
function bars(container: HTMLElement): SVGRectElement[] {
  return [...container.querySelectorAll<SVGRectElement>('svg rect')].filter((r) => r.getAttribute('class')?.includes('bar'));
}

describe('geometry', () => {
  it('draws one bar per point, in the order given — oldest first, so the newest is on the right', () => {
    const { container } = renderChart();
    expect(bars(container)).toHaveLength(4);
    const xs = bars(container).map((b) => Number(b.getAttribute('x')));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it('scales every bar to the tallest, gives a zero a visible stub and a tiny value a visible bar', () => {
    const { container } = renderChart();
    const heights = bars(container).map((b) => Number(b.getAttribute('height')));
    expect(heights[1]).toBe(96); // the tallest
    expect(heights[0]).toBeCloseTo(24, 5); // 100/400 of the tallest
    expect(heights[2]).toBeGreaterThan(0); // a zero is still a mark, not a hole
    expect(heights[2]).toBeLessThan(heights[3]); // ...but smaller than any real value
    expect(heights[3]).toBeGreaterThanOrEqual(2); // 1/400 would be a hairline; it is lifted
  });

  it('draws no NaN when every value is zero, and labels nothing as the maximum', () => {
    const zeros = POINTS.map((p) => ({ ...p, value: 0 }));
    const { container } = renderChart(zeros);
    for (const bar of bars(container)) expect(Number.isFinite(Number(bar.getAttribute('height')))).toBe(true);
    expect(container.querySelectorAll('[class*=maxLabel]')).toHaveLength(0);
  });
});

describe('labels', () => {
  it('labels exactly one bar on the plot — the tallest — not every bar', () => {
    const { container } = renderChart();
    const labels = container.querySelectorAll('[class*=maxLabel]');
    expect(labels).toHaveLength(1);
    expect(labels[0]).toHaveTextContent('400 تومان');
  });

  it('is one image with a summary, not a bar-by-bar reading', () => {
    renderChart();
    const image = screen.getByRole('img');
    expect(image).toHaveAccessibleName(/روند روزانهٔ فروش: ۴ روز/);
    expect(image).toHaveAccessibleName(/بیشترین 400 تومان در روز دوم/);
    expect(image).toHaveAccessibleName(/جمع 501 تومان/);
  });
});

describe('the accessible equivalent', () => {
  it('always has the data in a real table, one row per day, even before anyone asks for it', () => {
    renderChart();
    const table = screen.getByRole('table', { name: 'روند روزانهٔ فروش' });
    expect(within(table).getAllByRole('row')).toHaveLength(5); // header + 4
    expect(within(table).getByRole('columnheader', { name: 'سفارش' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'روز دوم' })).toBeInTheDocument();
    expect(within(table).getByText('400 تومان')).toBeInTheDocument();
    expect(within(table).getByText('۴ سفارش')).toBeInTheDocument();
  });

  it('is hidden visually until asked for, and shown by the toggle, which says what it controls', async () => {
    const user = userEvent.setup();
    renderChart();
    const table = screen.getByRole('table');
    const toggle = screen.getByRole('button', { name: 'نمایش به‌صورت جدول' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', table.id);
    expect(table.className).toContain('srOnly');

    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'پنهان کردن جدول' })).toHaveAttribute('aria-expanded', 'true');
    expect(table.className).not.toContain('srOnly');
  });

  it('omits the detail column when no point carries a detail', () => {
    renderChart(POINTS.map(({ detail: _detail, ...rest }) => rest));
    expect(screen.queryByRole('columnheader', { name: 'سفارش' })).toBeNull();
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
  });

  it('makes the scrolling region reachable by keyboard and names it', () => {
    renderChart();
    const region = screen.getByRole('region', { name: /قابل پیمایش افقی/ });
    expect(region).toHaveAttribute('tabindex', '0');
  });
});

describe('the tooltip', () => {
  it('shows the full date, the value and the detail for the bar under the pointer, and clears when it leaves', () => {
    const { container } = renderChart();
    const hit = container.querySelector('[data-bar="1"]') as Element;
    fireEvent.pointerEnter(hit);
    const tip = container.querySelector('[class*=tooltip]') as HTMLElement;
    expect(tip).toHaveTextContent('روز دوم');
    expect(tip).toHaveTextContent('400 تومان');
    expect(tip).toHaveTextContent('۴ سفارش');

    fireEvent.pointerLeave(screen.getByRole('img'));
    expect(container.querySelector('[class*=tooltip]')).toBeNull();
  });

  it('works by touch: a tap opens it and a second tap on the same bar closes it', () => {
    const { container } = renderChart();
    const hit = container.querySelector('[data-bar="2"]') as Element;
    fireEvent.pointerDown(hit);
    expect(container.querySelector('[class*=tooltip]')).not.toBeNull();
    fireEvent.pointerDown(hit);
    expect(container.querySelector('[class*=tooltip]')).toBeNull();
  });

  it('replaces the single maximum label while a tooltip is open, so the two never collide', () => {
    const { container } = renderChart();
    expect(container.querySelectorAll('[class*=maxLabel]')).toHaveLength(1);
    fireEvent.pointerEnter(container.querySelector('[data-bar="0"]') as Element);
    expect(container.querySelectorAll('[class*=maxLabel]')).toHaveLength(0);
  });
});

describe('empty and loading', () => {
  it('says there is no data instead of drawing a flat plot, and has no table to read', () => {
    renderChart([]);
    expect(screen.getByText('هنوز داده‌ای برای این بازه نیست.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('announces loading politely and draws no plot while it does', () => {
    const { container } = renderChart(POINTS, { loading: true });
    expect(screen.getByRole('status')).toHaveTextContent('در حال بارگذاری نمودار…');
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelectorAll('[class*=skeletonBar]').length).toBeGreaterThan(5);
  });
});
