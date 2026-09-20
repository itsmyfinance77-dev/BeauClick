'use client';

import { useCallback, useEffect, useState } from 'react';
import { toPersianDigits } from '@beauclick/persian-utils';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import { ConfirmDialog, PageHeader, Textarea } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import { COMPONENTS, COMPONENT_LABEL, ComponentCard, VersionTimeline } from '@/components/commission-policy-view';
import { CommissionRuleEditor, REASON_MAX_LENGTH, type CommissionRuleEditorValue } from '@/components/commission-rule-editor';
import {
  commissionPolicies,
  commissionPolicyVersions,
  createCommissionPolicy,
  discardCommissionVersion,
  draftCommissionVersion,
  publishCommissionVersion,
  replaceCommissionVersion,
  retireCommissionVersion,
  type CommissionComponent,
  type CommissionPolicySummary,
  type CommissionPolicyVersion,
} from '@/lib/admin-api';

/**
 * A pending confirmation. `discard` is here beside `publish` and `retire`
 * because it is a mutation like any other and carries the same mandatory
 * reason -- not because discarding a draft is dangerous.
 */
type Confirmation = { kind: 'publish' | 'retire' | 'discard'; policyKey: string; version: number };

const CONFIRM_COPY: Record<Confirmation['kind'], { title: string; label: string; consequence: string }> = {
  publish: {
    title: 'انتشار این نسخه',
    label: 'انتشار',
    // The activation instant is the server's, to the microsecond. No date
    // control anywhere, and the dialog says so rather than implying a choice.
    consequence:
      'با تأیید، این نسخه همین لحظه مؤثر می‌شود — لحظهٔ فعال‌سازی را سرور تعیین می‌کند و انتخابی در کار نیست. پس از انتشار، شرایط این نسخه تغییرناپذیر است؛ تغییر یعنی انتشار نسخه‌ای تازه.',
  },
  retire: {
    title: 'بازنشستگی این نسخه',
    label: 'بازنشستگی',
    consequence: 'با تأیید، این نسخه دیگر مؤثر نخواهد بود. تا وقتی نسخهٔ دیگری منتشر نشود، برای این مؤلفه قاعده‌ای در کار نیست.',
  },
  discard: {
    title: 'دور انداختن این پیش‌نویس',
    label: 'دور انداختن',
    consequence: 'این پیش‌نویس حذف می‌شود. هیچ نسخهٔ منتشرشده‌ای تحت تأثیر قرار نمی‌گیرد.',
  },
};

/**
 * What the platform charges -- V3.3 `#43b-1` / #173, ADR-052 §1.
 *
 * ## The read half only
 *
 * Story #205 builds what an administrator can SEE; #173's editor, publish and
 * retire dialogs are their own story. Nothing here mutates, and there is no
 * disabled write control standing in for the missing half -- a button that
 * does nothing is worse than no button, because it implies the action exists
 * and is merely unavailable to you.
 *
 * ## The first commercial admin surface
 *
 * `apps/web` had no `/admin/commercial` route group and `admin-api.ts` had no
 * commercial namespace before this. Screen 40, which this screen's spec says
 * to be consistent with, does not exist in code either -- so the patterns here
 * (route group, capability-gated nav entry, lifecycle by text and shape) are
 * established rather than followed.
 *
 * This file owns the reads and their failures; `commission-policy-view.tsx`
 * owns what each state looks like.
 */

export default function AdminCommissionPoliciesPage() {
  const { api } = useAuth();

  const [policies, setPolicies] = useState<CommissionPolicySummary[] | null>(null);
  const [policiesError, setPoliciesError] = useState<string | null>(null);
  const [policiesLoading, setPoliciesLoading] = useState(true);

  // Keyed by `policyKey`, because each policy's versions are their own read
  // and their own failure — one component's timeline failing must not blank
  // the other two.
  const [versions, setVersions] = useState<Record<string, CommissionPolicyVersion[]>>({});
  const [versionErrors, setVersionErrors] = useState<Record<string, string>>({});
  const [versionsLoading, setVersionsLoading] = useState<Record<string, boolean>>({});

  // ---- write state (V3.3 #207) --------------------------------------------
  // `editing` carries the version being replaced, or `null` for a new draft.
  const [editing, setEditing] = useState<{ policyKey: string; version: number | null } | null>(null);
  const [creating, setCreating] = useState<CommissionComponent | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [confirmReason, setConfirmReason] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * The server's refusal, held OUTSIDE the editor so the editor's own fields
   * survive it. Four codes reach here -- COMMERCIAL_ACTIVATION_OVERLAP,
   * COMMERCIAL_LIFECYCLE_CONFLICT, COMMERCIAL_TERMS_INVALID and
   * COMMERCIAL_REASON_REQUIRED -- and not one of them may clear the form. A
   * conflict means somebody else moved first; retyping a paragraph of
   * justification is the wrong penalty for that.
   */
  const [mutationError, setMutationError] = useState<string | null>(null);

  const loadVersions = useCallback(
    async (policyKey: string) => {
      setVersionsLoading((prev) => ({ ...prev, [policyKey]: true }));
      setVersionErrors((prev) => {
        const next = { ...prev };
        delete next[policyKey];
        return next;
      });
      try {
        const res = await commissionPolicyVersions(api, policyKey);
        setVersions((prev) => ({ ...prev, [policyKey]: res.data?.items ?? [] }));
      } catch (err) {
        setVersionErrors((prev) => ({
          ...prev,
          [policyKey]: err instanceof Error ? err.message : 'نسخه‌های این سیاست بارگذاری نشد.',
        }));
      } finally {
        setVersionsLoading((prev) => ({ ...prev, [policyKey]: false }));
      }
    },
    [api],
  );

  const loadPolicies = useCallback(async () => {
    setPoliciesLoading(true);
    setPoliciesError(null);
    try {
      const res = await commissionPolicies(api);
      const items = res.data?.items ?? [];
      setPolicies(items);
      await Promise.all(items.map((policy) => loadVersions(policy.policyKey)));
    } catch (err) {
      setPoliciesError(err instanceof Error ? err.message : 'سیاست‌های کمیسیون بارگذاری نشد.');
    } finally {
      setPoliciesLoading(false);
    }
  }, [api, loadVersions]);

  useEffect(() => {
    void loadPolicies();
  }, [loadPolicies]);

  const policyFor = (component: CommissionComponent) => policies?.find((p) => p.component === component);

  /**
   * One place every mutation passes through.
   *
   * On refusal it records the message and returns false, leaving `editing`,
   * `creating` and `confirmation` exactly as they were -- which is what keeps
   * the administrator's typed reason and chosen shape on screen. Only a
   * SUCCESS closes anything.
   */
  async function runMutation(action: () => Promise<unknown>, reloadKey: string | null): Promise<boolean> {
    setBusy(true);
    setMutationError(null);
    try {
      await action();
      if (reloadKey) await loadVersions(reloadKey);
      else await loadPolicies();
      return true;
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'این تغییر ثبت نشد.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitDraft(policyKey: string, version: number | null, value: CommissionRuleEditorValue) {
    const ok = await runMutation(
      () => (version === null ? draftCommissionVersion(api, policyKey, value) : replaceCommissionVersion(api, policyKey, version, value)),
      policyKey,
    );
    if (ok) setEditing(null);
  }

  async function submitNewPolicy(component: CommissionComponent, value: CommissionRuleEditorValue) {
    // The key is derived from the component, not typed: a free-text key on
    // this surface would be one more value an administrator could get wrong,
    // and `CATALOGUE_KEY_PATTERN` is the only shape the server accepts.
    const policyKey = `${component.replace(/_/g, '-')}-standard`;
    const ok = await runMutation(
      () =>
        createCommissionPolicy(api, {
          policyKey,
          component,
          displayName: COMPONENT_LABEL[component],
          reason: value.reason,
        }),
      null,
    );
    if (ok) setCreating(null);
  }

  async function confirmPending() {
    if (!confirmation) return;
    const { kind, policyKey, version } = confirmation;
    const reason = confirmReason.trim();
    const ok = await runMutation(() => {
      if (kind === 'publish') return publishCommissionVersion(api, policyKey, version, reason);
      if (kind === 'retire') return retireCommissionVersion(api, policyKey, version, reason);
      return discardCommissionVersion(api, policyKey, version, reason);
    }, policyKey);
    if (ok) {
      setConfirmation(null);
      setConfirmReason('');
    }
  }

  function openConfirmation(next: Confirmation) {
    setConfirmation(next);
    setConfirmReason('');
    setMutationError(null);
  }

  /**
   * The controls one version row carries.
   *
   * A published row gets exactly one -- retire -- and a retired row gets
   * none. Neither gets an edit control, not even a disabled one: editing
   * exists on drafts only, and a greyed-out Edit implies the action exists
   * and is merely unavailable to you.
   */
  function rowActionsFor(policyKey: string) {
    return (version: CommissionPolicyVersion) => {
      if (version.lifecycleState === 'retired') return null;
      if (version.lifecycleState === 'published') {
        return (
          <Button variant="ghost" inline onClick={() => openConfirmation({ kind: 'retire', policyKey, version: version.version })}>
            بازنشستگی
          </Button>
        );
      }
      return (
        <>
          <Button
            inline
            onClick={() => {
              setEditing({ policyKey, version: version.version });
              setMutationError(null);
            }}
          >
            ویرایش
          </Button>
          <Button variant="ghost" inline onClick={() => openConfirmation({ kind: 'publish', policyKey, version: version.version })}>
            انتشار
          </Button>
          <Button variant="ghost" inline onClick={() => openConfirmation({ kind: 'discard', policyKey, version: version.version })}>
            دور انداختن
          </Button>
        </>
      );
    };
  }

  return (
    <div>
      <PageHeader
        title="سیاست کمیسیون"
        subtitle="آنچه سکو دریافت می‌کند. هیچ نرخی در کد نیست — هر رقمی که اینجا دیده می‌شود را یک مدیر منتشر کرده است."
      />

      {policiesError ? (
        <ErrorState message={policiesError} onRetry={() => void loadPolicies()} />
      ) : policiesLoading || policies === null ? (
        <LoadingState label="در حال بارگذاری سیاست‌ها…" />
      ) : (
        <>
          <div
            data-testid="commission-components"
            style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}
          >
            {COMPONENTS.map((component) => {
              const policy = policyFor(component);
              return (
                <ComponentCard
                  key={component}
                  component={component}
                  policy={policy}
                  versions={policy ? versions[policy.policyKey] : undefined}
                  versionsError={policy ? versionErrors[policy.policyKey] : undefined}
                  versionsLoading={policy ? !!versionsLoading[policy.policyKey] : false}
                  onRetry={(policyKey) => void loadVersions(policyKey)}
                  actions={
                    policy ? (
                      <Button
                        inline
                        onClick={() => {
                          setEditing({ policyKey: policy.policyKey, version: null });
                          setMutationError(null);
                        }}
                      >
                        پیش‌نویسِ تازه
                      </Button>
                    ) : (
                      <Button
                        inline
                        onClick={() => {
                          setCreating(component);
                          setMutationError(null);
                        }}
                      >
                        ساختِ سیاست
                      </Button>
                    )
                  }
                />
              );
            })}
          </div>

          {COMPONENTS.map((component) => {
            const policy = policyFor(component);
            const rows = policy ? versions[policy.policyKey] : undefined;
            if (!policy || !rows || rows.length === 0) return null;
            return <VersionTimeline key={component} policy={policy} versions={rows} rowActions={rowActionsFor(policy.policyKey)} />;
          })}

          {editing ? (
            <section style={{ marginBlockStart: 24 }}>
              <h3 style={{ fontSize: 15, fontWeight: 800, margin: '0 0 10px' }}>
                {editing.version === null ? 'پیش‌نویسِ تازه' : `ویرایشِ پیش‌نویس ${editing.version}`}
              </h3>
              <CommissionRuleEditor
                busy={busy}
                serverError={mutationError}
                submitLabel={editing.version === null ? 'ثبتِ پیش‌نویس' : 'ذخیرهٔ پیش‌نویس'}
                onCancel={() => {
                  setEditing(null);
                  setMutationError(null);
                }}
                onSubmit={(value) => void submitDraft(editing.policyKey, editing.version, value)}
              />
            </section>
          ) : null}

          {creating ? (
            <section style={{ marginBlockStart: 24 }}>
              <h3 style={{ fontSize: 15, fontWeight: 800, margin: '0 0 10px' }}>ساختِ سیاست برای {COMPONENT_LABEL[creating]}</h3>
              <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.9, color: 'var(--bc-color-ink-soft)' }}>
                ساختِ سیاست چیزی را منتشر نمی‌کند. پس از آن می‌توانید پیش‌نویسی بسازید و منتشرش کنید.
              </p>
              <CommissionRuleEditor
                busy={busy}
                serverError={mutationError}
                submitLabel="ساختِ سیاست"
                onCancel={() => {
                  setCreating(null);
                  setMutationError(null);
                }}
                onSubmit={(value) => void submitNewPolicy(creating, value)}
              />
            </section>
          ) : null}

          <ConfirmDialog
            open={confirmation !== null}
            busy={busy}
            title={confirmation ? CONFIRM_COPY[confirmation.kind].title : ''}
            confirmLabel={confirmation ? CONFIRM_COPY[confirmation.kind].label : ''}
            tone={confirmation?.kind === 'discard' ? 'danger' : 'primary'}
            describedById="commission-confirm-consequence"
            confirmDisabled={confirmReason.trim().length === 0}
            onCancel={() => {
              setConfirmation(null);
              setConfirmReason('');
              setMutationError(null);
            }}
            onConfirm={() => void confirmPending()}
            body={
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <p id="commission-confirm-consequence" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.95 }}>
                  {confirmation ? CONFIRM_COPY[confirmation.kind].consequence : ''}
                </p>
                <Textarea
                  label="دلیل"
                  rows={2}
                  maxLength={REASON_MAX_LENGTH}
                  hint={`الزامی. حداکثر ${toPersianDigits(REASON_MAX_LENGTH)} نویسه. در گزارش عملیات ثبت می‌شود.`}
                  value={confirmReason}
                  onChange={(e) => setConfirmReason(e.target.value)}
                  disabled={busy}
                />
                {mutationError ? (
                  <p role="alert" style={{ margin: 0, fontSize: 13, lineHeight: 1.85, color: 'var(--bc-color-error)' }}>
                    {mutationError}
                  </p>
                ) : null}
              </div>
            }
          />
        </>
      )}
    </div>
  );
}
