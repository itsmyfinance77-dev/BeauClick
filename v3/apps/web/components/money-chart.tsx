'use client';

import type { CSSProperties } from 'react';
import { useId, useState } from 'react';
import { toPersianDigits } from '@beauclick/persian-utils';
import styles from './money-chart.module.css';

/**
 * A simple vertical bar chart, one bar per day — `24_MONEYCHART_DECISION.md`.
 *
 * Drawn by hand as SVG rectangles: for this volume of data a charting library
 * is not justified, and the design asks for a simple bar chart, not an
 * interactive one. It is one component for two places (`/pro/analytics`,
 * later `/pro/finance`); the data is whatever the caller measures, so the name
 * is the spec's, not a claim that it can only draw money.
 *
 * ## The decisions worth stating
 *
 * **Time runs left to right, newest on the right.** This is the one explicit
 * exception to the page's right-to-left layout. The two design documents that
 * cover it (`07_PRO_ANALYTICS`, `24_MONEYCHART_DECISION`) agree on the outcome
 * — "the time axis does not rotate", "the newer day on the right" — but 24's
 * sentence also says "from right to left in chronological order", which would
 * put the newest on the LEFT. The outcome both documents state is followed, and
 * the contradiction is recorded here rather than resolved silently. Date labels
 * stay Persian and right-aligned; only the order of the bars is left to right.
 *
 * **One label on the plot.** Only the tallest bar carries its value — no
 * numeric ruler, to avoid a wall of digits. The exact value of any bar is on
 * hover or touch, in a tooltip, and in the table.
 *
 * **Accessible as a table, not as a hundred bars.** The plot is a single
 * `role="img"` with a summary label, so a screen reader is not read thirty
 * values; the same data is ALWAYS in the document as a real `<table>` (visually
 * hidden until the "show as table" button is pressed), which is the
 * accessible equivalent the design requires. A keyboard user therefore gets
 * every value from the table; the tooltip is a pointer and touch affordance.
 *
 * **On a phone the bars keep their width and the plot scrolls sideways** —
 * squeezing thirty bars into 300px would make them indistinguishable. From
 * 1024 every bar of the range fits in one row.
 */
export type ChartPoint = {
  /** Stable identity, usually the ISO day. */
  key: string;
  /** The (Persian) label shown in the tooltip, the axis and the table. */
  label: string;
  value: number;
  /** A second figure for the tooltip and the table, e.g. «۳ سفارش». */
  detail?: string;
};

const BAR_STEP = 10;
const BAR_WIDTH = 7;
const PLOT_HEIGHT = 100;
const MAX_BAR = 96;

export function MoneyChart({
  points,
  title,
  formatValue,
  valueHeading,
  detailHeading,
  emptyMessage,
  loading = false,
}: {
  points: readonly ChartPoint[];
  /** Names the chart: «روند روزانهٔ فروش». */
  title: string;
  /** How a value is written — Persian digits, «تومان», etc. */
  formatValue: (value: number) => string;
  /** The value column's heading in the table. */
  valueHeading: string;
  /** The detail column's heading in the table, when points carry a detail. */
  detailHeading?: string;
  /** Shown instead of a flat, empty plot. */
  emptyMessage: string;
  loading?: boolean;
}) {
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();

  if (loading) {
    return (
      <div className={styles.skeleton} role="status" aria-live="polite">
        <span className={styles.srOnly}>در حال بارگذاری نمودار…</span>
        {Array.from({ length: 14 }, (_, i) => (
          <span key={i} className={styles.skeletonBar} aria-hidden="true" />
        ))}
      </div>
    );
  }

  if (points.length === 0) {
    return <p className={styles.empty}>{emptyMessage}</p>;
  }

  const n = points.length;
  const max = points.reduce((m, p) => Math.max(m, p.value), 0);
  const total = points.reduce((sum, p) => sum + p.value, 0);
  const tallest = points.findIndex((p) => p.value === max);
  const hasDetail = points.some((p) => p.detail);

  const heightOf = (value: number) => (max > 0 ? Math.max(value > 0 ? 2 : 0.8, (value / max) * MAX_BAR) : 0.8);
  const centre = (i: number) => ((i + 0.5) / n) * 100;

  const summary = `${title}: ${toPersianDigits(n)} روز، بیشترین ${formatValue(max)} در ${points[tallest].label}، جمع ${formatValue(total)}.`;

  const shown = active === null ? null : points[active];

  return (
    <div className={styles.chart}>
      <div
        className={styles.scroller}
        style={{ '--n': n } as CSSProperties}
        role="region"
        aria-label={`${title} — قابل پیمایش افقی`}
        tabIndex={0}
      >
        <div className={styles.plot} role="img" aria-label={summary} onPointerLeave={() => setActive(null)}>
          <svg className={styles.svg} viewBox={`0 0 ${n * BAR_STEP} ${PLOT_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
            {points.map((p, i) => {
              const h = heightOf(p.value);
              return (
                <g key={p.key}>
                  {/* A full-height, invisible hit area, so a short bar is as easy to touch as a tall one. */}
                  <rect
                    x={i * BAR_STEP}
                    y={0}
                    width={BAR_STEP}
                    height={PLOT_HEIGHT}
                    fill="transparent"
                    data-bar={i}
                    onPointerEnter={() => setActive(i)}
                    onPointerDown={() => setActive((current) => (current === i ? null : i))}
                  />
                  <rect
                    className={`${styles.bar} ${active === i ? styles.barActive : ''}`}
                    x={i * BAR_STEP + (BAR_STEP - BAR_WIDTH) / 2}
                    y={PLOT_HEIGHT - h}
                    width={BAR_WIDTH}
                    height={h}
                    pointerEvents="none"
                  />
                </g>
              );
            })}
          </svg>

          {max > 0 && active === null ? (
            <span className={styles.maxLabel} style={{ left: `${centre(tallest)}%` }} aria-hidden="true">
              {formatValue(max)}
            </span>
          ) : null}

          {shown ? (
            <div
              className={`${styles.tooltip} ${centre(active as number) < 18 ? styles.tipStart : centre(active as number) > 82 ? styles.tipEnd : ''}`}
              style={{ left: `${centre(active as number)}%` }}
              aria-hidden="true"
            >
              <span className={styles.tipDate}>{shown.label}</span>
              <span className={styles.tipValue}>{formatValue(shown.value)}</span>
              {shown.detail ? <span className={styles.tipDetail}>{shown.detail}</span> : null}
            </div>
          ) : null}
        </div>

        {/* The first and last day, so the axis is legible without a ruler. */}
        <div className={styles.axis} aria-hidden="true">
          <span>{points[0].label}</span>
          <span>{points[n - 1].label}</span>
        </div>
      </div>

      <button
        type="button"
        className={styles.toggle}
        aria-expanded={showTable}
        aria-controls={tableId}
        onClick={() => setShowTable((v) => !v)}
      >
        {showTable ? 'پنهان کردن جدول' : 'نمایش به‌صورت جدول'}
      </button>

      {/* Always in the document: this is the accessible equivalent of the plot. */}
      <table id={tableId} className={showTable ? styles.table : styles.srOnly}>
        <caption className={styles.srOnly}>{title}</caption>
        <thead>
          <tr>
            <th scope="col">روز</th>
            <th scope="col">{valueHeading}</th>
            {hasDetail ? <th scope="col">{detailHeading ?? 'جزئیات'}</th> : null}
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.key}>
              <th scope="row">{p.label}</th>
              <td>{formatValue(p.value)}</td>
              {hasDetail ? <td>{p.detail ?? ''}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
