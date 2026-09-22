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
 * ## What cannot be done from here, and why
 *
 * A NEW plan version cannot be drafted: `WritePlanVersionDto` requires a
 * `priceScheduleVersionId`, and no read returns a schedule version's id
 * (#271). Offering a picker built from whatever ids existing plans happen to
 * carry would present schedules nobody has used yet as unavailable, for a
 * reason the administrator cannot see. So plan keys, plan history, and the
 * edit, publish, retire and discard of EXISTING plan drafts all work, and a
 * new plan draft waits for the API.
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

const NEW_PLAN_BLOCKED =
  'پیش‌نویس تازهٔ طرح از این صفحه ساختنی نیست: هر نسخهٔ طرح باید به یک نسخهٔ جدول قیمت اشاره کند و هیچ خواندنی شناسهٔ آن نسخه‌ها را برنمی‌گرداند (#271). ویرایش، انتشار و بازنشستگی پیش‌نویس‌ها و نسخه‌های موجود ممکن است.';

function PlansScreen() {
  const { api } = useAuth();
  const [schedules, setSchedules] = useState<PriceScheduleSummary[]>([]);

  const loadScheduleKeys = useCallback(async () => {
    const rows = (await priceSchedules(api)).data?.items ?? [];
    setSchedules(rows);
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
        renderEditor={(props) => <PlanEditor {...props} creditScheduleKeys={creditScheduleKeys} />}
        draft={null}
        newDraftBlocked={NEW_PLAN_BLOCKED}
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
