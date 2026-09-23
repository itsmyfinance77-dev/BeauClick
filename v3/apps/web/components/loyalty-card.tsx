'use client';

import { toPersianDigits } from '@beauclick/persian-utils';
import { ProgressBar } from '@/components/kit';
import type { LoyaltySummary } from '@/lib/phase3-api';
import styles from './loyalty-card.module.css';

/**
 * The dashboard's compact loyalty widget — `V3_COMPONENT_INVENTORY.md`'s
 * `LoyaltyCard`, extracted out of the dashboard sidebar where it rendered in
 * place.
 *
 * Not shared with `LoyaltySummaryPanel` below despite both reading a
 * `LoyaltySummary`: comparing the two call sites before extracting showed
 * they share no real logic (no tier math, no label lookup) beyond calling
 * `toPersianDigits` on the same fields — the actual markup, container style
 * and even which fields are shown (this card folds benefits in and drops
 * lifetime-earned to one line; the panel gives it an equal-weight figure and
 * puts benefits in a separate block) are unrelated. Two small components
 * beat one with a variant switch that only forks presentation.
 */
export function LoyaltyCard({ summary }: { summary: LoyaltySummary }) {
  return (
    <div className={styles.sidebarCard} data-testid="loyalty-card">
      <div className={styles.loyaltyHead}>
        <span className={styles.loyaltyLabel}>باشگاه مشتریان</span>
        {summary.tier ? <span className={styles.tierChip}>{summary.tier.name}</span> : null}
      </div>
      <div className={styles.balanceRow}>
        <span className={styles.balance}>{toPersianDigits(summary.balance)}</span>
        <span className={styles.balanceUnit}>امتیاز قابل استفاده</span>
      </div>
      <div className={styles.lifetime}>مجموع کسب‌شده: {toPersianDigits(summary.lifetimeEarned)}</div>

      {summary.nextTier && summary.pointsToNextTier !== null && summary.percentToNextTier !== null ? (
        <>
          <div className={styles.progressLabel}>
            <span>
              {toPersianDigits(summary.pointsToNextTier)} امتیاز تا {summary.nextTier.name}
            </span>
            <span>{toPersianDigits(summary.percentToNextTier)}٪</span>
          </div>
          <div className={styles.progressWrap}>
            <ProgressBar
              tone="onDark"
              value={summary.percentToNextTier}
              label={`پیشرفت تا ${summary.nextTier.name}`}
            />
          </div>
        </>
      ) : null}

      {summary.benefits.length > 0 ? (
        <div className={styles.benefits}>
          <div className={styles.benefitsTitle}>مزایای فعال شما</div>
          {summary.benefits.map((benefit) => (
            <div key={benefit.type} className={styles.benefit}>
              <span className={styles.benefitDot} aria-hidden="true" />
              {benefit.label}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The `/loyalty` page's own detailed summary — balance and lifetime earned
 * as two equal figures, plus the current-tier line and next-tier progress.
 * Extracted out of `app/loyalty/page.tsx`; see `LoyaltyCard` above for why
 * this is a separate component rather than a variant of it.
 */
export function LoyaltySummaryPanel({ summary }: { summary: LoyaltySummary }) {
  return (
    <div className={styles.panel} data-testid="loyalty-summary">
      <div className={styles.figures}>
        <div>
          <p className={styles.figureLabel}>امتیاز قابل استفاده</p>
          <p className={styles.figure}>{toPersianDigits(summary.balance)}</p>
        </div>
        <div>
          {/* Two different numbers, shown side by side deliberately: spending
              points reduces the balance but never the lifetime total, which
              is what tier qualification uses. */}
          <p className={styles.figureLabel}>مجموع امتیاز کسب‌شده</p>
          <p className={styles.figure}>{toPersianDigits(summary.lifetimeEarned)}</p>
        </div>
      </div>

      {summary.tier && (
        <p className={styles.tier}>
          سطح فعلی شما: <strong>{summary.tier.name}</strong>
        </p>
      )}

      {summary.nextTier && summary.pointsToNextTier !== null && (
        <div className={styles.progress}>
          <p className={styles.progressText}>
            <span>
              {toPersianDigits(summary.pointsToNextTier)} امتیاز تا سطح {summary.nextTier.name}
            </span>
            <span>{toPersianDigits(Math.round(summary.percentToNextTier ?? 0))}٪</span>
          </p>
          <ProgressBar value={summary.percentToNextTier ?? 0} label={`پیشرفت تا سطح ${summary.nextTier.name}`} />
        </div>
      )}
    </div>
  );
}
