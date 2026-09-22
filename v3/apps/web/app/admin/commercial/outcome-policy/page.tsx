'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { formatZonedDateTime, toPersianDigits } from '@beauclick/persian-utils';
import {
  LEGAL_EVIDENCE_REFERENCE_KINDS,
  LEGAL_EVIDENCE_SUBJECTS,
  MAX_CUSTOMER_POLICY_COPY_BYTES,
  MAX_LEGAL_EVIDENCE_REFERENCE_LENGTH,
  MAX_LEGAL_EVIDENCE_SUMMARY_LENGTH,
  CATALOGUE_KEY_PATTERN,
  utf8ByteLength,
  type LegalEvidenceReferenceKind,
  type LegalEvidenceSubject,
} from '@beauclick/commercial-policy-contract';
import { AdminGuard } from '@/components/admin-guard';
import { Button, ErrorState, Input, LoadingState } from '@/components/ui';
import { DataCell, DataRow, DataTable, EmptyState, PageHeader, Textarea } from '@/components/kit';
import {
  LifecycleLegend,
  ReasonDialog,
  ReasonField,
  RefusalNotice,
  VersionFamilySection,
  reasonIsValid,
  type EditorProps,
} from '@/components/commercial-lifecycle';
import { useAuth } from '@/lib/auth-context';
import {
  createOutcomePolicy,
  createPolicyCopy,
  draftOutcomePolicyVersion,
  draftPolicyCopyVersion,
  legalEvidence,
  legalEvidenceRecord,
  outcomePolicies,
  outcomePolicyVersions,
  policyCopies,
  policyCopyVersion,
  policyCopyVersions,
  recordLegalEvidence,
  replaceOutcomePolicyVersion,
  replacePolicyCopyVersion,
  retireLegalEvidence,
  type LegalEvidence,
  type LegalEvidenceDetail,
  type OutcomePolicyVersion,
  type OutcomePolicyVersionBody,
  type PolicyCopyVersion,
  type PolicyCopyVersionBody,
  type PolicyCopyVersionDetail,
} from '@/lib/commercial-admin-api';
import {
  EVIDENCE_REFERENCE_KIND_LABEL,
  EVIDENCE_SUBJECT_LABEL,
  evidenceReferenceKindLabel,
  evidenceStatusView,
  evidenceSubjectLabel,
} from '@/lib/commercial-labels';
import { activeVersion, isoToLocalInput, localInputToIso, refusalFrom, type Refusal } from '@/lib/commercial-lifecycle';
import { OutcomePolicyEditor, OutcomePolicySummary } from './outcome-policy-editor';
import styles from './outcome-policy.module.css';

/**
 * `/admin/commercial/outcome-policy` — spec 47, ADR-051 §1 and §5. The
 * ADMINISTRATOR's write side of the booking-outcome policy family; the
 * seller's side, which chooses inside what is published here, is
 * `/pro/outcome-policy`.
 *
 * Three families, 22 routes on `booking-outcome-policy.controller.ts`:
 * outcome policy versions, the customer policy copy, and the Legal evidence
 * register. Nothing is seeded, so every empty list here is a first-class
 * state with its own copy, never an error.
 */
export default function AdminOutcomePolicyPage() {
  return (
    <AdminGuard capability="bc_manage_commercial_plans">
      <OutcomePolicyScreen />
    </AdminGuard>
  );
}

const PUBLISH_CONSEQUENCE = (
  <>
    <p>با تأیید، این نسخه همین لحظه مؤثر می‌شود — لحظهٔ فعال‌سازی را سرور تعیین می‌کند و انتخابی در کار نیست.</p>
    <p>شرایط نسخهٔ منتشرشده تغییرناپذیر است؛ تغییر یعنی انتشار نسخه‌ای تازه. اگر نسخهٔ دیگری از همین شناسه مؤثر باشد، انتشار پذیرفته نمی‌شود.</p>
  </>
);

const RETIRE_CONSEQUENCE = 'با تأیید، این نسخه دیگر برای انتخاب‌های تازه در دسترس نیست. بازنشستگی بازگشت ندارد؛ برای بازگرداندن، نسخه‌ای تازه منتشر کنید.';

function OutcomeSummaryCell(version: OutcomePolicyVersion) {
  return <OutcomePolicySummary version={version} />;
}

function OutcomePolicyScreen() {
  const { api } = useAuth();
  const [evidence, setEvidence] = useState<LegalEvidence[] | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [copyVersions, setCopyVersions] = useState<Record<string, PolicyCopyVersion[]>>({});

  const loadEvidence = useCallback(async () => {
    setEvidenceError(null);
    try {
      const res = await legalEvidence(api);
      setEvidence(res.data?.items ?? []);
    } catch (err) {
      setEvidenceError(err instanceof Error ? err.message : 'فهرست مدارک بارگذاری نشد.');
    }
  }, [api]);

  useEffect(() => {
    void loadEvidence();
  }, [loadEvidence]);

  const loadPolicyKeys = useCallback(async () => {
    const res = await outcomePolicies(api);
    return (res.data?.items ?? []).map((p) => ({ key: p.policyKey, label: p.displayName }));
  }, [api]);
  const loadPolicyVersions = useCallback(async (key: string) => (await outcomePolicyVersions(api, key)).data?.items ?? [], [api]);

  const loadCopyKeys = useCallback(async () => {
    const res = await policyCopies(api);
    return (res.data?.items ?? []).map((c) => ({ key: c.copyKey, label: c.displayName }));
  }, [api]);
  const loadCopyVersions = useCallback(async (key: string) => (await policyCopyVersions(api, key)).data?.items ?? [], [api]);
  const loadCopyEditable = useCallback(
    async (key: string, version: number) => {
      const res = await policyCopyVersion(api, key, version);
      if (!res.data) throw new Error('این نسخه بارگذاری نشد.');
      return res.data;
    },
    [api],
  );

  // Across every copy key: exactly one copy version is active platform-wide.
  const allCopies = Object.values(copyVersions).flat();
  const activeCopy = activeVersion(allCopies);

  return (
    <div className={styles.page}>
      <PageHeader
        title="سیاست پیامد رزرو"
        subtitle="بازه‌ها و مجموعه‌هایی که فروشنده بعداً درونشان انتخاب می‌کند. هیچ‌چیز منتشرشده در اینجا مستقیماً به یک رزرو بسته نمی‌شود."
      />
      <LifecycleLegend />

      <VersionFamilySection<OutcomePolicyVersion>
        id="outcome-policies"
        title="نسخه‌های سیاست پیامد"
        family="outcomePolicy"
        emptyMessage="هنوز هیچ سیاست پیامدی تعریف نشده است. روی پلتفرم تازه این وضعیت عادی است."
        loadKeys={loadPolicyKeys}
        loadVersions={loadPolicyVersions}
        create={{
          displayName: true,
          submit: ({ key, displayName, reason }) => createOutcomePolicy(api, { policyKey: key, displayName, reason }),
        }}
        summarize={OutcomeSummaryCell}
        renderEditor={(props: EditorProps<OutcomePolicyVersion>) => <OutcomePolicyEditor {...props} evidence={evidence} />}
        draft={(key, body) => draftOutcomePolicyVersion(api, key, body as OutcomePolicyVersionBody)}
        replace={(key, version, body) => replaceOutcomePolicyVersion(api, key, version, body as OutcomePolicyVersionBody)}
        startIsServer
        publishConsequence={PUBLISH_CONSEQUENCE}
        retireConsequence={RETIRE_CONSEQUENCE}
      />

      <section className={styles.block} aria-labelledby="active-copy-title" data-testid="active-copy">
        <h2 id="active-copy-title" className={styles.blockTitle}>
          متن سیاستِ مؤثر برای مشتری
        </h2>
        <p className={styles.hint}>در هر لحظه فقط یک نسخه از متن در همهٔ پلتفرم مؤثر است؛ مشتری همین را هنگام پرداخت می‌پذیرد.</p>
        <ActiveCopyCard version={activeCopy} />
      </section>

      <VersionFamilySection<PolicyCopyVersion>
        id="policy-copies"
        title="نسخه‌های متن سیاست برای مشتری"
        family="policyCopy"
        emptyMessage="هنوز هیچ متن سیاستی برای مشتری تعریف نشده است."
        loadKeys={loadCopyKeys}
        loadVersions={loadCopyVersions}
        loadEditable={loadCopyEditable}
        onVersions={(key, rows) => setCopyVersions((prev) => ({ ...prev, [key]: rows }))}
        create={{
          displayName: true,
          submit: ({ key, displayName, reason }) => createPolicyCopy(api, { copyKey: key, displayName, reason }),
        }}
        summarize={(version) => (
          <span className={styles.hash}>
            {version.locale} · اثر <span dir="ltr">{version.bodySha256.slice(0, 12)}</span>
          </span>
        )}
        renderEditor={(props) => <PolicyCopyEditor {...(props as EditorProps<PolicyCopyVersionDetail>)} />}
        draft={(key, body) => draftPolicyCopyVersion(api, key, body as PolicyCopyVersionBody)}
        replace={(key, version, body) => replacePolicyCopyVersion(api, key, version, body as PolicyCopyVersionBody)}
        startIsServer
        publishConsequence={PUBLISH_CONSEQUENCE}
        retireConsequence="با تأیید، این متن دیگر به مشتری نشان داده نمی‌شود. تا نسخهٔ دیگری منتشر نشود، متنی مؤثر نیست."
      />

      <EvidenceRegister evidence={evidence} error={evidenceError} onReload={loadEvidence} />
    </div>
  );
}

// ============================================================ customer copy

/** The one active copy, with its text — fetched on its own, because the list carries only the hash. */
function ActiveCopyCard({ version }: { version: PolicyCopyVersion | null }) {
  const { api } = useAuth();
  const [detail, setDetail] = useState<PolicyCopyVersionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const copyKey = version?.copyKey ?? null;
  const number = version?.version ?? null;

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (copyKey === null || number === null) return;
    let cancelled = false;
    policyCopyVersion(api, copyKey, number)
      .then((res) => {
        if (!cancelled) setDetail(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'متن بارگذاری نشد.');
      });
    return () => {
      cancelled = true;
    };
  }, [api, copyKey, number]);

  if (!version) return <EmptyState message="هیچ متنی برای مشتری مؤثر نیست." />;
  return (
    <div className={styles.copyCard} data-copy={`${version.copyKey}:${version.version}`}>
      <p className={styles.copyMeta}>
        <span dir="ltr">{version.copyKey}</span> · نسخهٔ {toPersianDigits(version.version)}
        {version.activationStartsAt ? ` · از ${formatZonedDateTime(new Date(version.activationStartsAt))}` : ''}
      </p>
      {error ? <p role="alert" className={styles.fieldError}>{error}</p> : null}
      {detail ? <div className={styles.copyBody}>{detail.body}</div> : !error ? <LoadingState label="در حال بارگذاری متن…" lines={2} /> : null}
    </div>
  );
}

function PolicyCopyEditor({ initial, busy, refusal, onSubmit, onCancel }: EditorProps<PolicyCopyVersionDetail>) {
  const [body, setBody] = useState(initial?.body ?? '');
  const [endsAt, setEndsAt] = useState(isoToLocalInput(initial?.activationEndsAt ?? null));
  const [reason, setReason] = useState('');
  const bytes = utf8ByteLength(body);
  const endsIso = localInputToIso(endsAt);
  const valid = body.trim().length > 0 && bytes <= MAX_CUSTOMER_POLICY_COPY_BYTES && (endsAt === '' || endsIso !== null) && reasonIsValid(reason);

  return (
    <form
      className={styles.editor}
      data-testid="policy-copy-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit({ locale: 'fa-IR', body, activationEndsAt: endsIso, reason: reason.trim() } satisfies PolicyCopyVersionBody);
      }}
    >
      <p className={styles.note}>زبان متن: fa-IR — تنها زبانی که این قرارداد می‌پذیرد.</p>
      <Textarea
        label="متن سیاست"
        rows={8}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={busy}
        hint={`${toPersianDigits(bytes.toLocaleString('en-US'))} از ${toPersianDigits(MAX_CUSTOMER_POLICY_COPY_BYTES.toLocaleString('en-US'))} بایت`}
        error={bytes > MAX_CUSTOMER_POLICY_COPY_BYTES ? 'متن از اندازهٔ مجاز بلندتر است.' : null}
      />
      <Input
        label="پایان فعال‌سازی (اختیاری)"
        type="datetime-local"
        dir="ltr"
        value={endsAt}
        onChange={(e) => setEndsAt(e.target.value)}
        disabled={busy}
        hint="شروع را سرور هنگام انتشار تعیین می‌کند."
      />
      <ReasonField value={reason} onChange={setReason} disabled={busy} />
      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      <div className={styles.actions}>
        <Button type="submit" inline disabled={!valid || busy} loading={busy}>
          {initial ? 'ذخیرهٔ پیش‌نویس' : 'ثبت پیش‌نویس'}
        </Button>
        <Button type="button" variant="ghost" inline onClick={onCancel} disabled={busy}>
          انصراف
        </Button>
      </div>
    </form>
  );
}

// ========================================================= evidence register

/**
 * The Legal evidence register — spec 47 §1.3. A record stores a REFERENCE and
 * a summary, never the document. `recorded → retired`, one way. The list
 * carries vocabulary and instants only; a record's reference and summary are
 * read on demand.
 */
type EvidenceDetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; detail: LegalEvidenceDetail };

function EvidenceRegister({
  evidence,
  error,
  onReload,
}: {
  evidence: LegalEvidence[] | null;
  error: string | null;
  onReload: () => Promise<void>;
}) {
  const { api } = useAuth();
  const [recording, setRecording] = useState(false);
  const [opened, setOpened] = useState<Record<string, EvidenceDetailState>>({});
  const [retiring, setRetiring] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const titleId = useId();

  async function open(key: string) {
    if (opened[key]?.status === 'ready') {
      setOpened((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    setOpened((prev) => ({ ...prev, [key]: { status: 'loading' } }));
    try {
      const res = await legalEvidenceRecord(api, key);
      setOpened((prev) => ({ ...prev, [key]: res.data ? { status: 'ready', detail: res.data } : { status: 'error', message: 'بارگذاری نشد.' } }));
    } catch (err) {
      setOpened((prev) => ({ ...prev, [key]: { status: 'error', message: err instanceof Error ? err.message : 'بارگذاری نشد.' } }));
    }
  }

  async function run(action: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(true);
    setRefusal(null);
    try {
      await action();
      await onReload();
      setAnnouncement(success);
      return true;
    } catch (err) {
      setRefusal(refusalFrom(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.block} aria-labelledby={titleId} data-testid="evidence-register">
      <div className={styles.blockHead}>
        <h2 id={titleId} className={styles.blockTitle}>
          فهرست مدارک حقوقی
        </h2>
        {!recording ? (
          <Button type="button" variant="ghost" inline onClick={() => { setRecording(true); setRefusal(null); }}>
            ثبت مدرک
          </Button>
        ) : null}
      </div>
      <p className={styles.hint}>هر مدرک یک ارجاع و یک خلاصه است، نه خودِ سند. ثبت‌شده ← بازنشسته، یک‌طرفه.</p>
      <p className={styles.live} aria-live="polite">
        {announcement}
      </p>

      {recording ? (
        <RecordEvidenceForm
          busy={busy}
          refusal={refusal}
          onCancel={() => {
            setRecording(false);
            setRefusal(null);
          }}
          onSubmit={async (input) => {
            const ok = await run(() => recordLegalEvidence(api, input), `مدرک «${input.evidenceKey}» ثبت شد.`);
            if (ok) setRecording(false);
          }}
        />
      ) : null}

      {error ? (
        <ErrorState message={error} onRetry={() => void onReload()} />
      ) : evidence === null ? (
        <LoadingState label="در حال بارگذاری مدارک…" lines={3} />
      ) : evidence.length === 0 ? (
        <EmptyState message="هنوز هیچ مدرکی ثبت نشده است. تا وقتی مدرکی دربارهٔ «سقف نگه‌داشت» ثبت نشود، هیچ نسخه‌ای سقف قانونی نمی‌گیرد." />
      ) : (
        <DataTable head={['شناسه', 'موضوع', 'نوع ارجاع', 'وضعیت', 'زمان', 'کنش']} aria-labelledby={titleId}>
          {evidence.map((record) => {
            const status = evidenceStatusView(record.status);
            const detail = opened[record.evidenceKey];
            return (
              <DataRow key={record.evidenceKey} data-evidence={record.evidenceKey}>
                <DataCell label="شناسه">
                  <span className={styles.key} dir="ltr">
                    {record.evidenceKey}
                  </span>
                </DataCell>
                <DataCell label="موضوع">{evidenceSubjectLabel(record.subject)}</DataCell>
                <DataCell label="نوع ارجاع">{evidenceReferenceKindLabel(record.referenceKind)}</DataCell>
                <DataCell label="وضعیت">
                  <span className={styles.status} data-status={record.status}>
                    <span aria-hidden="true">{status.glyph}</span> {status.label}
                  </span>
                </DataCell>
                <DataCell label="زمان">
                  ثبت {formatZonedDateTime(new Date(record.recordedAt))}
                  {record.retiredAt ? <><br />بازنشسته {formatZonedDateTime(new Date(record.retiredAt))}</> : null}
                </DataCell>
                <DataCell label="کنش">
                  <div className={styles.rowActions}>
                    <Button
                      type="button"
                      variant="ghost"
                      inline
                      aria-expanded={detail?.status === 'ready'}
                      aria-label={`${detail?.status === 'ready' ? 'بستن' : 'مشاهدهٔ'} ارجاع و خلاصهٔ ${record.evidenceKey}`}
                      onClick={() => void open(record.evidenceKey)}
                    >
                      {detail?.status === 'ready' ? 'بستن' : 'مشاهده'}
                    </Button>
                    {record.status === 'recorded' ? (
                      <Button
                        type="button"
                        variant="ghost"
                        inline
                        aria-label={`بازنشستگی مدرک ${record.evidenceKey}`}
                        onClick={() => {
                          setRefusal(null);
                          setRetiring(record.evidenceKey);
                        }}
                      >
                        بازنشستگی
                      </Button>
                    ) : null}
                  </div>
                  {detail?.status === 'loading' ? <p className={styles.hint}>در حال بارگذاری…</p> : null}
                  {detail?.status === 'error' ? (
                    <p role="alert" className={styles.fieldError}>
                      {detail.message}
                    </p>
                  ) : null}
                  {detail?.status === 'ready' ? (
                    <dl className={styles.evidenceDetail}>
                      <dt>ارجاع</dt>
                      <dd dir="auto">{detail.detail.reference}</dd>
                      <dt>خلاصه</dt>
                      <dd>{detail.detail.summary}</dd>
                    </dl>
                  ) : null}
                </DataCell>
              </DataRow>
            );
          })}
        </DataTable>
      )}

      {!recording && !retiring && refusal ? <RefusalNotice refusal={refusal} /> : null}

      <ReasonDialog
        open={retiring !== null}
        title="بازنشستگی این مدرک"
        confirmLabel="بازنشستگی"
        busy={busy}
        refusal={retiring ? refusal : null}
        consequence="مدرک بازنشسته دیگر پشتوانهٔ هیچ انتشار تازه‌ای نیست. بازگشت ندارد؛ برای استفادهٔ دوباره، مدرکی تازه ثبت کنید."
        onCancel={() => {
          setRetiring(null);
          setRefusal(null);
        }}
        onConfirm={(reason) =>
          void (async () => {
            if (!retiring) return;
            const key = retiring;
            const ok = await run(() => retireLegalEvidence(api, key, reason), `مدرک «${key}» بازنشسته شد.`);
            if (ok) setRetiring(null);
          })()
        }
      />
    </section>
  );
}

function RecordEvidenceForm({
  busy,
  refusal,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  refusal: Refusal | null;
  onSubmit: (input: {
    evidenceKey: string;
    subject: LegalEvidenceSubject;
    referenceKind: LegalEvidenceReferenceKind;
    reference: string;
    summary: string;
    reason: string;
  }) => void;
  onCancel: () => void;
}) {
  const [key, setKey] = useState('');
  const [subject, setSubject] = useState<LegalEvidenceSubject | null>(null);
  const [referenceKind, setReferenceKind] = useState<LegalEvidenceReferenceKind | null>(null);
  const [reference, setReference] = useState('');
  const [summary, setSummary] = useState('');
  const [reason, setReason] = useState('');
  const subjectName = useId();
  const kindName = useId();

  const keyValid = CATALOGUE_KEY_PATTERN.test(key);
  const valid =
    keyValid &&
    subject !== null &&
    referenceKind !== null &&
    reference.trim().length >= 1 &&
    reference.length <= MAX_LEGAL_EVIDENCE_REFERENCE_LENGTH &&
    summary.trim().length >= 1 &&
    summary.length <= MAX_LEGAL_EVIDENCE_SUMMARY_LENGTH &&
    reasonIsValid(reason);

  return (
    <form
      className={styles.editor}
      data-testid="record-evidence-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && subject && referenceKind) {
          onSubmit({ evidenceKey: key, subject, referenceKind, reference: reference.trim(), summary: summary.trim(), reason: reason.trim() });
        }
      }}
    >
      <Input
        label="شناسه"
        dir="ltr"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        disabled={busy}
        error={key !== '' && !keyValid ? 'این شناسه قالب مجاز را ندارد.' : null}
      />
      <fieldset className={styles.group}>
        <legend className={styles.legend}>موضوع</legend>
        {LEGAL_EVIDENCE_SUBJECTS.map((value) => (
          <label key={value} className={styles.radio}>
            <input type="radio" name={subjectName} checked={subject === value} onChange={() => setSubject(value)} disabled={busy} />
            <span>{EVIDENCE_SUBJECT_LABEL[value]}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className={styles.group}>
        <legend className={styles.legend}>نوع ارجاع</legend>
        {LEGAL_EVIDENCE_REFERENCE_KINDS.map((value) => (
          <label key={value} className={styles.radio}>
            <input type="radio" name={kindName} checked={referenceKind === value} onChange={() => setReferenceKind(value)} disabled={busy} />
            <span>{EVIDENCE_REFERENCE_KIND_LABEL[value]}</span>
          </label>
        ))}
      </fieldset>
      <Input label="ارجاع" value={reference} maxLength={MAX_LEGAL_EVIDENCE_REFERENCE_LENGTH} onChange={(e) => setReference(e.target.value)} disabled={busy} hint="شمارهٔ سند، نامه یا تیکت — نه خودِ سند." />
      <Textarea label="خلاصه" rows={3} value={summary} maxLength={MAX_LEGAL_EVIDENCE_SUMMARY_LENGTH} onChange={(e) => setSummary(e.target.value)} disabled={busy} />
      <ReasonField value={reason} onChange={setReason} disabled={busy} />
      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      <div className={styles.actions}>
        <Button type="submit" inline disabled={!valid || busy} loading={busy}>
          ثبت مدرک
        </Button>
        <Button type="button" variant="ghost" inline onClick={onCancel} disabled={busy}>
          انصراف
        </Button>
      </div>
    </form>
  );
}
