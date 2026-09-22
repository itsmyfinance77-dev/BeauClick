'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { formatZonedDateTime, toPersianDigits } from '@beauclick/persian-utils';
import { AdminGuard } from '@/components/admin-guard';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import { PageHeader } from '@/components/kit';
import { LifecycleLegend, ReasonDialog, RefusalNotice, VersionFamilySection } from '@/components/commercial-lifecycle';
import { useAuth } from '@/lib/auth-context';
import {
  collectionPolicies,
  collectionPolicyVersions,
  createCollectionPolicy,
  draftCollectionPolicyVersion,
  enforcementPreview,
  enforcementStatus,
  replaceCollectionPolicyVersion,
  runEnforcementCommand,
  type CollectionPolicyVersion,
  type CollectionPolicyVersionBody,
  type EnforcementCommand,
  type EnforcementPreview,
  type EnforcementStatus,
  type GovernanceOutcome,
} from '@/lib/commercial-admin-api';
import { killSwitchLabel, rolloutStateLabel } from '@/lib/commercial-labels';
import { refusalFrom, type Refusal } from '@/lib/commercial-lifecycle';
import { CollectionPolicyEditor, CollectionPolicySummary } from './collection-policy-editor';
import styles from './control-plane.module.css';

/**
 * `/admin/commercial/control-plane` — spec 44, ADR-048 and ADR-050.
 *
 * Two things share this screen: publishing booking collection policies (the
 * nine `collection-policies` routes on `CommercialCatalogueController`) and
 * the booking-credit enforcement control plane (the seven routes on
 * `BookingCreditEnforcementController`).
 *
 * ## Eight states, three groups, one legend
 *
 * Stored (draft, published, retired), derived from the activation window
 * (active, and its neighbours), and gates that belong to NO version: legally
 * blocked, payment-provider blocked and emergency-stopped. Only the last has
 * an API state — `killSwitchState` — and the legend says of the other two
 * that this page does not report them, rather than showing a state nobody
 * measured.
 *
 * ## The enforcement plane has no seller picker, by design
 *
 * Every command's body is exactly a reason; the governance commands are
 * set-based; the preview is aggregate-only and carries no seller-identifying
 * data. So there is no seller list here, and its absence is the design.
 * There is no deactivation route either: reversal is not an ordinary
 * transition.
 */
export default function AdminControlPlanePage() {
  return (
    <AdminGuard capability="bc_manage_commercial_plans">
      <ControlPlaneScreen />
    </AdminGuard>
  );
}

const COLLECTION_PUBLISH = (
  <>
    <p>
      با تأیید، این نسخه همین لحظه مؤثر می‌شود — لحظهٔ فعال‌سازی را پایگاه‌داده تعیین می‌کند. فقط سفارش‌هایی که از این لحظه به بعد ساخته
      می‌شوند از آن پیروی می‌کنند؛ <strong>رزروهای موجود تغییری نمی‌کنند.</strong>
    </p>
    <p>
      انتشار بازگشت‌پذیر نیست و هیچ مسیری تاریخچه را ویرایش یا حذف نمی‌کند؛ برای تغییر، نسخه‌ای تازه منتشر کنید. اگر نسخهٔ دیگری از همین
      شناسه در این لحظه مؤثر باشد، انتشار پذیرفته نمی‌شود.
    </p>
  </>
);

const COLLECTION_RETIRE =
  'با تأیید، این نسخه دیگر برای سفارش‌های تازه انتخاب نمی‌شود. سفارش‌های موجود تغییری نمی‌کنند. بازنشستگی بازگشت ندارد.';

function ControlPlaneScreen() {
  const { api } = useAuth();
  const [status, setStatus] = useState<EnforcementStatus | null>(null);

  const loadKeys = useCallback(async () => {
    const res = await collectionPolicies(api);
    return (res.data?.items ?? []).map((p) => ({ key: p.policyKey, label: p.displayName }));
  }, [api]);
  const loadVersions = useCallback(async (key: string) => (await collectionPolicyVersions(api, key)).data?.items ?? [], [api]);

  return (
    <div className={styles.page}>
      <PageHeader
        title="سیاست دریافت و کنترل اعمال اعتبار"
        subtitle="آنچه سکو هنگام رزرو دریافت می‌کند، و کنترل‌های سراسریِ اعمال اعتبار رزرو. هر تغییر با دلیل در گزارش عملیات ثبت می‌شود."
      />

      <LifecycleLegend gates={<GateLegend status={status} />} />

      <EnforcementPanel onStatus={setStatus} />

      <VersionFamilySection<CollectionPolicyVersion>
        id="collection-policies"
        title="نسخه‌های سیاست دریافت"
        family="collectionPolicy"
        emptyMessage="هنوز هیچ سیاست دریافتی تعریف نشده است."
        loadKeys={loadKeys}
        loadVersions={loadVersions}
        create={{
          displayName: true,
          submit: ({ key, displayName, reason }) => createCollectionPolicy(api, { policyKey: key, displayName, reason }),
        }}
        summarize={(version) => <CollectionPolicySummary version={version} />}
        renderEditor={(props) => <CollectionPolicyEditor {...props} />}
        draft={(key, body) => draftCollectionPolicyVersion(api, key, body as CollectionPolicyVersionBody)}
        replace={(key, version, body) => replaceCollectionPolicyVersion(api, key, version, body as CollectionPolicyVersionBody)}
        startIsServer
        publishConsequence={COLLECTION_PUBLISH}
        retireConsequence={COLLECTION_RETIRE}
      />
    </div>
  );
}

// ================================================================= legend

/** The third legend group: conditions that belong to no version. */
function GateLegend({ status }: { status: EnforcementStatus | null }) {
  return (
    <ul className={styles.gates}>
      <li data-gate="legal">
        <strong>انسداد حقوقی</strong>
        <span className={styles.gateState}>این صفحه گزارش نمی‌دهد.</span>
      </li>
      <li data-gate="payment-provider">
        <strong>انسداد درگاه پرداخت</strong>
        <span className={styles.gateState}>این صفحه گزارش نمی‌دهد.</span>
      </li>
      <li data-gate="kill-switch">
        <strong>توقف اضطراری</strong>
        <span className={styles.gateState}>{status ? killSwitchLabel(status.killSwitchState) : '—'}</span>
      </li>
    </ul>
  );
}

// ============================================================ enforcement

const COUNT_LABEL: Record<keyof Pick<EnforcementPreview, 'eligible' | 'governed' | 'legacyExempt' | 'unresolved' | 'wouldBeRefused'>, { label: string; hint: string }> = {
  eligible: { label: 'فروشندگان در دامنه', hint: 'همهٔ طرف‌هایی که اعمال اعتبار می‌تواند شاملشان شود.' },
  governed: { label: 'مشمول', hint: 'اعتبار رزرو برایشان اعمال می‌شود؛ یک‌طرفه و ماندگار.' },
  legacyExempt: { label: 'معافِ پیشین', hint: 'صراحتاً معاف ثبت شده‌اند.' },
  unresolved: { label: 'تعیین‌نشده', hint: 'هنوز نه مشمول‌اند نه معاف. تا وقتی عددی جز صفر است، فعال‌سازی سراسری ممکن نیست.' },
  wouldBeRefused: { label: 'رزروشان رد می‌شد', hint: 'مشمول‌هایی که اگر اکنون رزرو بگیرند، اعتبارشان کافی نیست.' },
};

interface CommandCopy {
  label: string;
  title: string;
  consequence: ReactNode;
  tone: 'primary' | 'danger';
}

const COMMANDS: Record<EnforcementCommand, CommandCopy> = {
  transition: {
    label: 'مشمول‌کردن فروشندگان دارای اعتبار',
    title: 'مشمول‌کردن فروشندگان دارای اعتبار',
    consequence:
      'هر فروشندهٔ در دامنه که تعیین‌نشده یا معافِ پیشین است و دست‌کم یک اعتبار مثبت دارد، مشمول می‌شود. بقیه دست‌نخورده می‌مانند و «کنارگذاشته» شمرده می‌شوند. مشمول‌شدن یک‌طرفه است: مسیری برای بازگرداندن آن وجود ندارد. هیچ اعتبار، اشتراک یا مانده‌ای نوشته نمی‌شود.',
    tone: 'primary',
  },
  exempt: {
    label: 'معاف‌کردن فروشندگان بی‌اعتبار',
    title: 'معاف‌کردن فروشندگان بی‌اعتبار',
    consequence:
      'هر فروشندهٔ تعیین‌نشده‌ای که هیچ اعتبار مثبتی ندارد، معافِ پیشین ثبت می‌شود. فروشندهٔ دارای اعتبار مثبت دست‌نخورده می‌ماند؛ جای او فرمان مشمول‌کردن است.',
    tone: 'primary',
  },
  engage: {
    label: 'درگیر کردن توقف اضطراری',
    title: 'درگیر کردن توقف اضطراری',
    consequence: 'اعمال اعتبار رزرو در همهٔ پلتفرم متوقف می‌شود تا وقتی توقف آزاد شود. این کلید فعال‌سازی را دور نمی‌زند و فعال‌سازی هم آن را.',
    tone: 'danger',
  },
  release: {
    label: 'آزاد کردن توقف اضطراری',
    title: 'آزاد کردن توقف اضطراری',
    consequence: 'اعمال اعتبار رزرو دوباره مطابق وضعیت فعال‌سازی ادامه می‌یابد.',
    tone: 'primary',
  },
  activate: {
    label: 'فعال‌سازی سراسری',
    title: 'فعال‌سازی سراسریِ اعمال اعتبار',
    consequence:
      'یک‌بار و یکجا. از این لحظه هر فروشندهٔ تازه هنگام ساخت مشمول می‌شود. مسیر غیرفعال‌سازی وجود ندارد: بازگشت یک تغییر عادی نیست.',
    tone: 'danger',
  },
};

function isStatus(value: unknown): value is EnforcementStatus {
  return typeof value === 'object' && value !== null && 'rolloutState' in value;
}

function EnforcementPanel({ onStatus }: { onStatus: (status: EnforcementStatus) => void }) {
  const { api } = useAuth();
  const [status, setStatus] = useState<EnforcementStatus | null>(null);
  const [preview, setPreview] = useState<EnforcementPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<EnforcementCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, p] = await Promise.all([enforcementStatus(api), enforcementPreview(api)]);
      setStatus(s.data);
      setPreview(p.data);
      if (s.data) onStatus(s.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'وضعیت اعمال اعتبار بارگذاری نشد.');
    }
  }, [api, onStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(command: EnforcementCommand, reason: string) {
    setBusy(true);
    setRefusal(null);
    try {
      const res = await runEnforcementCommand(api, command, reason);
      const outcome = res.data;
      setPending(null);
      setAnnouncement(
        isStatus(outcome)
          ? `${COMMANDS[command].label}: ثبت شد.`
          : `${COMMANDS[command].label}: ${toPersianDigits((outcome as GovernanceOutcome).affected)} فروشنده تغییر کرد، ${toPersianDigits((outcome as GovernanceOutcome).skipped)} فروشنده کنار گذاشته شد.`,
      );
      await load();
    } catch (err) {
      setRefusal(refusalFrom(err));
      // The refusal may carry fresher counts than the ones on screen.
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!status || !preview) return <LoadingState label="در حال بارگذاری وضعیت اعمال اعتبار…" lines={4} />;

  const active = status.rolloutState === 'active';
  const engaged = status.killSwitchState === 'engaged';
  const activationBlocked =
    preview.unresolved > 0 ? `فعال‌سازی ممکن نیست: وضعیت ${toPersianDigits(preview.unresolved)} فروشنده هنوز تعیین نشده است. نخست آنان را مشمول یا معاف کنید.` : null;

  return (
    <section className={styles.panel} aria-labelledby="enforcement-title" data-testid="enforcement">
      <h2 id="enforcement-title" className={styles.panelTitle}>
        اعمال اعتبار رزرو
      </h2>
      <p className={styles.hint}>
        فرمان‌ها روی مجموعه‌ها کار می‌کنند و فهرستی از فروشندگان در کار نیست: این نما فقط شمار را نشان می‌دهد، نه اینکه چه کسی.
      </p>
      <p className={styles.live} aria-live="polite">
        {announcement}
      </p>

      <dl className={styles.status}>
        <div data-status="rollout">
          <dt>وضعیت فعال‌سازی</dt>
          <dd>{rolloutStateLabel(status.rolloutState)}</dd>
          {status.activatedAt ? <dd className={styles.when}>از {formatZonedDateTime(new Date(status.activatedAt))}</dd> : null}
        </div>
        <div data-status="kill-switch">
          <dt>توقف اضطراری</dt>
          <dd>{killSwitchLabel(status.killSwitchState)}</dd>
          {status.killSwitchChangedAt ? <dd className={styles.when}>آخرین تغییر {formatZonedDateTime(new Date(status.killSwitchChangedAt))}</dd> : null}
        </div>
      </dl>

      <ul className={styles.counts} aria-label="شمار فروشندگان">
        {(Object.keys(COUNT_LABEL) as (keyof typeof COUNT_LABEL)[]).map((key) => (
          <li key={key} data-count={key}>
            <span className={styles.countValue}>{toPersianDigits(preview[key])}</span>
            <span className={styles.countLabel}>{COUNT_LABEL[key].label}</span>
            <span className={styles.countHint}>{COUNT_LABEL[key].hint}</span>
          </li>
        ))}
      </ul>

      <div className={styles.commands}>
        <Button type="button" variant="ghost" inline onClick={() => { setRefusal(null); setPending('transition'); }}>
          {COMMANDS.transition.label}
        </Button>
        <Button type="button" variant="ghost" inline onClick={() => { setRefusal(null); setPending('exempt'); }}>
          {COMMANDS.exempt.label}
        </Button>
        {engaged ? (
          <Button type="button" variant="ghost" inline onClick={() => { setRefusal(null); setPending('release'); }}>
            {COMMANDS.release.label}
          </Button>
        ) : (
          <Button type="button" variant="danger" inline onClick={() => { setRefusal(null); setPending('engage'); }}>
            {COMMANDS.engage.label}
          </Button>
        )}
        {active ? null : (
          <Button
            type="button"
            variant="danger"
            inline
            disabled={activationBlocked !== null}
            aria-describedby={activationBlocked ? 'activation-blocked' : undefined}
            onClick={() => { setRefusal(null); setPending('activate'); }}
          >
            {COMMANDS.activate.label}
          </Button>
        )}
      </div>
      {!active && activationBlocked ? (
        <p id="activation-blocked" className={styles.blocked} role="note">
          {activationBlocked}
        </p>
      ) : null}

      {!pending && refusal ? <RefusalNotice refusal={refusal} /> : null}

      <ReasonDialog
        open={pending !== null}
        title={pending ? COMMANDS[pending].title : ''}
        confirmLabel={pending ? COMMANDS[pending].label : ''}
        tone={pending ? COMMANDS[pending].tone : 'primary'}
        busy={busy}
        refusal={pending ? refusal : null}
        confirmBlocked={pending === 'activate' ? activationBlocked : null}
        consequence={
          pending ? (
            <>
              <p>{COMMANDS[pending].consequence}</p>
              {pending === 'activate' || pending === 'transition' || pending === 'exempt' ? (
                <p>
                  شمار کنونی: {toPersianDigits(preview.eligible)} در دامنه، {toPersianDigits(preview.governed)} مشمول، {toPersianDigits(preview.legacyExempt)} معاف،{' '}
                  {toPersianDigits(preview.unresolved)} تعیین‌نشده.
                </p>
              ) : null}
            </>
          ) : null
        }
        onCancel={() => {
          setPending(null);
          setRefusal(null);
        }}
        onConfirm={(reason) => {
          if (pending) void run(pending, reason);
        }}
      />
    </section>
  );
}
