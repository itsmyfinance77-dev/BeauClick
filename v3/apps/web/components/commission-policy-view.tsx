'use client';

import { formatToman, toPersianDigits } from '@beauclick/persian-utils';
import { Card, ErrorState, LoadingState } from '@/components/ui';
import { Badge } from '@/components/kit';
import type { ReactNode } from 'react';
import type {
  CommissionBase,
  CommissionComponent,
  CommissionLifecycleState,
  CommissionPolicySummary,
  CommissionPolicyVersion,
} from '@/lib/admin-api';

/**
 * How the commission policy surface RENDERS — V3.3 `#43b-1` / #173, ADR-052
 * §1, design `50_ADMIN_COMMISSION_POLICY.md` §D1-D2.
 *
 * Split from the page for the reason `funds-by-state.tsx` is split from
 * `finance-workspace.tsx`: the page owns fetching, retrying and which read
 * failed; this file owns what each of those states looks like. The split is
 * what lets the rendering be exercised -- in a test or in a browser -- against
 * fixed data, without a session, an API or a database.
 *
 * ## Why the three components are a constant and not a server list
 *
 * `COMMISSION_COMPONENTS` is a closed, ORDERED vocabulary: the order binds
 * (ADR-052 §3 allocates a held ceiling across components in exactly that
 * sequence), and a component nobody has created a policy for still has to
 * appear, saying so. Deriving the cards from whatever the list route returned
 * would make an unpublished component VANISH rather than report itself --
 * the difference between "nothing is charged" and "we did not look".
 */

/** Mirrors `COMMISSION_COMPONENTS` — order included, because the order binds. */
export const COMPONENTS: readonly CommissionComponent[] = ['booking_commission', 'acquisition', 'processing_recovery'];

export const COMPONENT_LABEL: Record<CommissionComponent, string> = {
  booking_commission: 'کارمزدِ نوبت',
  acquisition: 'جذبِ مشتری',
  processing_recovery: 'بازیافتِ هزینهٔ پرداخت',
};

const LIFECYCLE_LABEL: Record<CommissionLifecycleState, string> = {
  draft: 'پیش‌نویس',
  published: 'منتشرشده',
  retired: 'بازنشسته',
};

/**
 * Lifecycle by SHAPE as well as text — a filled circle, a hollow square, a
 * hollow circle. The state must survive a monochrome render and a reader who
 * cannot distinguish the tones.
 */
const LIFECYCLE_MARK: Record<CommissionLifecycleState, string> = {
  draft: '◻',
  published: '●',
  retired: '○',
};

const BASE_LABEL: Record<CommissionBase, string> = {
  platform_collected_amount: 'مبلغی که سکو واقعاً وصول کرده',
  service_total: 'مبلغ کلِ خدمت',
};

/** Basis points, never rendered as a percentage the server did not state. */
function formatBasisPoints(bp: number): string {
  return `${toPersianDigits(bp)} bp`;
}

/**
 * One rule, in the words of its own shape.
 *
 * The shape decides which fields exist: `zero` has none, `fixed` has no base,
 * `percentage` has no amount. Reading `ruleKind` first — rather than printing
 * whichever fields happen to be non-null — is what stops a future response
 * with a stray field from being rendered as though it belonged.
 */
export function RuleStatement({ version }: { version: CommissionPolicyVersion }) {
  if (version.ruleKind === 'zero') {
    return <p style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>چیزی دریافت نمی‌شود.</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {version.fixedToman !== null ? (
        <p style={{ margin: 0, fontSize: 14 }}>
          مبلغ ثابت: <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{formatToman(version.fixedToman)}</strong>
        </p>
      ) : null}
      {version.basisPoints !== null ? (
        <p style={{ margin: 0, fontSize: 14 }}>
          نرخ: <strong dir="ltr" style={{ fontVariantNumeric: 'tabular-nums' }}>{formatBasisPoints(version.basisPoints)}</strong>
        </p>
      ) : null}
      {version.base !== null ? (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>بر مبنای {BASE_LABEL[version.base]}</p>
      ) : null}
    </div>
  );
}

export function LifecycleBadge({ state }: { state: CommissionLifecycleState }) {
  return (
    <Badge tone={state === 'published' ? 'success' : 'neutral'}>
      <span aria-hidden="true">{LIFECYCLE_MARK[state]}</span> {LIFECYCLE_LABEL[state]}
    </Badge>
  );
}

/** The effective version of one component, or the plain statement that none is published. */
export function ComponentCard({
  component,
  policy,
  versions,
  versionsError,
  versionsLoading,
  onRetry,
  actions,
}: {
  component: CommissionComponent;
  policy: CommissionPolicySummary | undefined;
  versions: CommissionPolicyVersion[] | undefined;
  versionsError: string | undefined;
  versionsLoading: boolean;
  onRetry: (policyKey: string) => void;
  /**
   * Write controls, supplied by the page — V3.3 #207. A slot rather than
   * props per action: this file stays presentational, and the read-only
   * caller simply passes nothing.
   */
  actions?: ReactNode;
}) {
  const effective = versions?.find((v) => v.lifecycleState === 'published') ?? null;

  return (
    <Card>
      <div data-component={component} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>{COMPONENT_LABEL[component]}</h2>
          <span dir="ltr" style={{ fontSize: 11, fontWeight: 700, color: 'var(--bc-color-ink-soft)' }}>
            {component}
          </span>
        </div>

        {/*
          No policy row at all. Distinct from a published `zero`, and distinct
          again from a failed read below — three different facts, three
          different sentences.
        */}
        {!policy ? (
          <p data-state="no-policy" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.9, color: 'var(--bc-color-ink-soft)' }}>
            برای این مؤلفه هنوز هیچ سیاستی ساخته نشده است.
          </p>
        ) : versionsError ? (
          <div data-state="error">
            <ErrorState message={versionsError} onRetry={() => onRetry(policy.policyKey)} />
          </div>
        ) : versionsLoading || versions === undefined ? (
          <div data-state="loading">
            <LoadingState label="در حال بارگذاری نسخه‌ها…" />
          </div>
        ) : effective ? (
          <div data-state="effective" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <LifecycleBadge state="published" />
            <RuleStatement version={effective} />
            <p style={{ margin: 0, fontSize: 12, color: 'var(--bc-color-ink-soft)' }}>
              نسخهٔ {toPersianDigits(effective.version)}
              {effective.publishedAt ? ` · از ${new Date(effective.publishedAt).toLocaleDateString('fa-IR')}` : ''}
            </p>
          </div>
        ) : (
          /*
            A policy exists but nothing of it is live. Still not an incident:
            a fresh platform looks exactly like this.
          */
          <p data-state="none-published" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.9, color: 'var(--bc-color-ink-soft)' }}>
            سیاستی ساخته شده، اما هیچ نسخه‌ای از آن منتشر نشده است.
          </p>
        )}
        {actions ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBlockStart: 4 }}>{actions}</div> : null}
      </div>
    </Card>
  );
}

/** Every version of one policy, newest first, with no edit affordance on any row. */
export function VersionTimeline({
  policy,
  versions,
  rowActions,
}: {
  policy: CommissionPolicySummary;
  versions: CommissionPolicyVersion[];
  /**
   * Controls for one row — V3.3 #207. Returning `null` for a published or
   * retired version is how "no edit affordance at all, not even a disabled
   * one" is expressed: the cell is empty, not greyed.
   */
  rowActions?: (version: CommissionPolicyVersion) => ReactNode;
}) {
  const headingId = `commission-timeline-${policy.component}`;
  const descriptionId = `${headingId}-description`;

  return (
    <section style={{ marginBlockStart: 20 }}>
      <h3 id={headingId} style={{ fontSize: 14, fontWeight: 800, margin: '0 0 6px' }}>
        {COMPONENT_LABEL[policy.component]} — تاریخچهٔ نسخه‌ها
      </h3>
      {/*
        The description sits OUTSIDE the scroll container and is associated by
        `aria-describedby`. As a `<caption>` it inherited the table's
        `min-width` and was clipped at the container's edge on a 390px screen
        -- a sentence the reader could only finish by scrolling sideways.
      */}
      <p id={descriptionId} style={{ margin: '0 0 8px', fontSize: 12, lineHeight: 1.85, color: 'var(--bc-color-ink-soft)' }}>
        نسخهٔ منتشرشده تغییرناپذیر است؛ تغییرِ یک قاعدهٔ زنده یعنی انتشارِ نسخه‌ای تازه.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table
          aria-labelledby={headingId}
          aria-describedby={descriptionId}
          style={{ width: '100%', minWidth: 520, borderCollapse: 'collapse', fontSize: 13 }}
        >
          <thead>
            <tr style={{ borderBottom: '1px solid var(--bc-color-line)' }}>
              <th style={{ textAlign: 'start', padding: '8px 10px', fontWeight: 700 }}>نسخه</th>
              <th style={{ textAlign: 'start', padding: '8px 10px', fontWeight: 700 }}>وضعیت</th>
              <th style={{ textAlign: 'start', padding: '8px 10px', fontWeight: 700 }}>قاعده</th>
              <th style={{ textAlign: 'start', padding: '8px 10px', fontWeight: 700 }}>انتشار</th>
              {rowActions ? <th style={{ textAlign: 'start', padding: '8px 10px', fontWeight: 700 }}>اقدام</th> : null}
            </tr>
          </thead>
          <tbody>
            {[...versions]
              .sort((a, b) => b.version - a.version)
              .map((version) => (
                <tr key={version.version} data-version={version.version} style={{ borderBottom: '1px solid var(--bc-color-line)' }}>
                  <td style={{ padding: '10px', fontVariantNumeric: 'tabular-nums' }}>{toPersianDigits(version.version)}</td>
                  <td style={{ padding: '10px' }}>
                    <LifecycleBadge state={version.lifecycleState} />
                  </td>
                  <td style={{ padding: '10px' }}>
                    <RuleStatement version={version} />
                  </td>
                  <td style={{ padding: '10px', fontSize: 12, color: 'var(--bc-color-ink-soft)' }}>
                    {version.publishedAt ? new Date(version.publishedAt).toLocaleDateString('fa-IR') : '—'}
                  </td>
                  {rowActions ? (
                    <td style={{ padding: '10px' }}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{rowActions(version)}</div>
                    </td>
                  ) : null}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
