'use client';

import { useCallback, useState } from 'react';
import { toPersianDigits } from '@beauclick/persian-utils';
import { PRICE_SCHEDULE_PURPOSES } from '@beauclick/commercial-policy-contract';
import { AdminGuard } from '@/components/admin-guard';
import { Button } from '@/components/ui';
import { PageHeader } from '@/components/kit';
import { LifecycleLegend, VersionFamilySection, type EditorProps } from '@/components/commercial-lifecycle';
import { useAuth } from '@/lib/auth-context';
import {
  createPlan,
  createPriceSchedule,
  draftPlanVersion,
  draftPriceScheduleVersion,
  planVersions,
  plans,
  priceSchedules,
  priceScheduleVersion,
  priceScheduleVersions,
  replacePlanVersion,
  replacePriceScheduleVersion,
  type PlanVersion,
  type PlanVersionBody,
  type PriceScheduleSummary,
  type PriceScheduleVersion,
  type PriceScheduleVersionBody,
  type PriceScheduleVersionDetail,
  type PriceTier,
} from '@/lib/commercial-admin-api';
import { SCHEDULE_PURPOSE_LABEL, schedulePurposeLabel } from '@/lib/commercial-labels';
import { PlanEditor, PlanSummary, PriceScheduleEditor, tierSummary } from './catalogue-editors';
import styles from './plans.module.css';

/**
 * `/admin/commercial/plans` — spec 40, ADR-041. The plan catalogue and the
 * price-schedule catalogue: 18 routes on `CommercialCatalogueController`.
 *
 * ## Drafting a new plan version
 *
 * `WritePlanVersionDto` requires a `priceScheduleVersionId`, which the
 * schedule reads now return (#271). The editor picks one: a schedule key,
 * then a version within it.
 *
 * Every version is offered, whatever its lifecycle state, and each one shows
 * that state beside it. That mirrors the server exactly —
 * `createPlanVersionDraft` checks only that the referenced version EXISTS —
 * rather than the UI inventing a narrower rule the API does not have. An
 * administrator drafting a plan against a schedule draft is doing something
 * the server permits, and seeing «پیش‌نویس» next to it is what tells them so.
 *
 * ## The base workspace is a row
 *
 * The seeded base plan is listed like any other — published, zero price,
 * auto-assignable — because the catalogue ratifies it as a row, not a code
 * path. This page names no key.
 */
export default function AdminPlansPage() {
  return (
    <AdminGuard capability="bc_manage_commercial_plans">
      <PlansScreen />
    </AdminGuard>
  );
}

const PUBLISH = (
  <>
    <p>با تأیید، شرایط این نسخه برای همیشه ثابت می‌شود؛ تغییر یعنی انتشار نسخه‌ای تازه.</p>
    <p>نسخه در بازهٔ فعال‌سازی‌ای مؤثر می‌شود که در پیش‌نویس آمده است. اگر این بازه با نسخهٔ دیگری از همین شناسه هم‌پوشانی داشته باشد، انتشار پذیرفته نمی‌شود.</p>
  </>
);

const RETIRE =
  'با تأیید، این نسخه دیگر برای انتخاب‌های آینده در دسترس نیست. بازنشسته نه ویرایش می‌شود و نه دوباره فعال؛ برای بازگرداندن، نسخه‌ای تازه منتشر کنید.';

function PlansScreen() {
  const { api } = useAuth();
  const [schedules, setSchedules] = useState<PriceScheduleSummary[]>([]);
  /*
   * Every schedule version the page has loaded, keyed by its schedule. The
   * plan editor picks from these, so it offers exactly what the administrator
   * can already see on this page rather than a second, separately-fetched
   * idea of what exists.
   */
  const [scheduleVersionsByKey, setScheduleVersionsByKey] = useState<Record<string, PriceScheduleVersion[]>>({});
  /*
   * Whether the KEYS read has returned, which `schedules.length` cannot say.
   * An empty `schedules` means either "not read yet" or "this platform has no
   * price schedules", and those need different sentences from the plan editor
   * -- the same distinction `scheduleVersionsComplete` below exists to make,
   * one level up. Without this flag the zero-schedule platform would be told
   * its list is incomplete forever.
   */
  const [schedulesLoaded, setSchedulesLoaded] = useState(false);

  const loadScheduleKeys = useCallback(async () => {
    const rows = (await priceSchedules(api)).data?.items ?? [];
    setSchedules(rows);
    setSchedulesLoaded(true);
    return rows.map((s) => ({ key: s.scheduleKey, label: null, meta: schedulePurposeLabel(s.purpose) }));
  }, [api]);
  const loadScheduleVersions = useCallback(async (key: string) => (await priceScheduleVersions(api, key)).data?.items ?? [], [api]);
  const loadScheduleEditable = useCallback(
    async (key: string, version: number) => {
      const res = await priceScheduleVersion(api, key, version);
      if (!res.data) throw new Error('این نسخه بارگذاری نشد.');
      return res.data;
    },
    [api],
  );

  const loadPlanKeys = useCallback(async () => ((await plans(api)).data?.items ?? []).map((p) => ({ key: p.planKey, label: null })), [api]);
  const loadPlanVersions = useCallback(async (key: string) => (await planVersions(api, key)).data?.items ?? [], [api]);

  const creditScheduleKeys = schedules.filter((s) => s.purpose === 'booking_credit').map((s) => s.scheduleKey);

  /*
   * Flattened for the plan editor. Every version is offered whatever its
   * lifecycle state, because `createPlanVersionDraft` checks only that the id
   * EXISTS -- the state travels with it so the administrator sees what they
   * are choosing rather than being silently prevented from choosing it.
   */
  const scheduleVersionChoices = Object.entries(scheduleVersionsByKey).flatMap(([key, versions]) =>
    versions.map((version) => ({
      id: version.id,
      scheduleKey: key,
      version: version.version,
      displayName: version.displayName,
      lifecycleState: version.lifecycleState,
    })),
  );

  /*
   * Whether every schedule key has reported its versions yet.
   *
   * The family reads all of them on mount, so the complete list is normally
   * there before the plans family's own button is clickable. But "normally" is
   * not "always": until each key has reported, the list is SHORT, not empty,
   * and a short list is the dangerous state -- it looks like the whole
   * catalogue. The editor is told so it can say so, rather than presenting a
   * partial list as complete.
   *
   * It stays false when a versions read FAILED, which is correct: the family
   * shows that error with its own retry, and the honest thing for the picker
   * to say is that the list is incomplete, not why. Same for a failed KEYS
   * read: `schedulesLoaded` stays false, and "incomplete" is the truth.
   *
   * `schedulesLoaded` rather than `schedules.length > 0`, because `every` over
   * an empty array is `true` -- so during the initial load the picker would
   * otherwise claim a complete, empty catalogue. On a platform that genuinely
   * has no price schedules this is then complete and empty, which is the state
   * the "none has been made yet" sentence is written for.
   */
  const scheduleVersionsComplete =
    schedulesLoaded && schedules.every((s) => s.scheduleKey in scheduleVersionsByKey);

  return (
    <div className={styles.page}>
      <PageHeader
        title="طرح‌ها و جدول‌های قیمت"
        subtitle="کاتالوگ طرح‌های فروشنده و جدول‌های قیمتشان. هیچ عدد نهایی در کد نیست؛ هر رقمی که اینجا دیده می‌شود را یک مدیر منتشر کرده است."
      />
      <LifecycleLegend />

      <VersionFamilySection<PriceScheduleVersion>
        id="price-schedules"
        title="جدول‌های قیمت"
        family="priceSchedule"
        emptyMessage="هنوز هیچ جدول قیمتی تعریف نشده است."
        loadKeys={loadScheduleKeys}
        loadVersions={loadScheduleVersions}
        loadEditable={loadScheduleEditable}
        create={{
          displayName: false,
          choice: { legend: 'کاربرد جدول', options: PRICE_SCHEDULE_PURPOSES.map((p) => ({ value: p, label: SCHEDULE_PURPOSE_LABEL[p] })) },
          submit: ({ key, choice, reason }) =>
            createPriceSchedule(api, { scheduleKey: key, purpose: choice as (typeof PRICE_SCHEDULE_PURPOSES)[number], reason }),
        }}
        summarize={(version) => <ScheduleSummary version={version} />}
        renderEditor={(props) => <PriceScheduleEditor {...(props as EditorProps<PriceScheduleVersionDetail>)} />}
        draft={(key, body) => draftPriceScheduleVersion(api, key, body as PriceScheduleVersionBody)}
        replace={(key, version, body) => replacePriceScheduleVersion(api, key, version, body as PriceScheduleVersionBody)}
        onVersions={(key, versions) => setScheduleVersionsByKey((prev) => ({ ...prev, [key]: versions }))}
        startIsServer={false}
        publishConsequence={PUBLISH}
        retireConsequence={RETIRE}
      />

      <VersionFamilySection<PlanVersion>
        id="plans"
        title="طرح‌ها"
        family="plan"
        emptyMessage="هیچ طرحی هنوز تعریف نشده است."
        loadKeys={loadPlanKeys}
        loadVersions={loadPlanVersions}
        create={{ displayName: false, submit: ({ key, reason }) => createPlan(api, { planKey: key, reason }) }}
        summarize={(version) => <PlanSummary version={version} />}
        renderEditor={(props) => (
          <PlanEditor
            {...props}
            creditScheduleKeys={creditScheduleKeys}
            scheduleVersions={scheduleVersionChoices}
            scheduleVersionsComplete={scheduleVersionsComplete}
          />
        )}
        draft={(key, body) => draftPlanVersion(api, key, body as PlanVersionBody)}
        replace={(key, version, body) => replacePlanVersion(api, key, version, body as PlanVersionBody)}
        startIsServer={false}
        publishConsequence={PUBLISH}
        retireConsequence={RETIRE}
      />
    </div>
  );
}

/** A schedule version's quantities, and its tiers on demand — the list does not carry them. */
function ScheduleSummary({ version }: { version: PriceScheduleVersion }) {
  const { api } = useAuth();
  const [tiers, setTiers] = useState<PriceTier[] | 'loading' | { error: string } | null>(null);

  async function load() {
    setTiers('loading');
    try {
      const res = await priceScheduleVersion(api, version.scheduleKey, version.version);
      setTiers(res.data?.tiers ?? []);
    } catch (err) {
      setTiers({ error: err instanceof Error ? err.message : 'ردیف‌ها بارگذاری نشد.' });
    }
  }

  return (
    <div className={styles.summary}>
      <strong>{version.displayName}</strong>
      <span>
        {' '}
        · تعداد {toPersianDigits(version.minPurchaseQuantity)} تا {toPersianDigits(version.maxPurchaseQuantity)} · {version.currency}
      </span>
      {Array.isArray(tiers) ? (
        <p className={styles.tierLine} data-tiers={version.version}>
          {tiers.length === 0 ? 'بدون ردیف' : tierSummary(tiers)}
        </p>
      ) : tiers === 'loading' ? (
        <p className={styles.tierLine}>در حال بارگذاری ردیف‌ها…</p>
      ) : tiers && 'error' in tiers ? (
        <p role="alert" className={styles.fieldError}>
          {tiers.error}
        </p>
      ) : (
        <Button type="button" variant="ghost" inline onClick={() => void load()} aria-label={`نمایش ردیف‌های نسخهٔ ${toPersianDigits(version.version)}`}>
          نمایش ردیف‌ها
        </Button>
      )}
    </div>
  );
}
