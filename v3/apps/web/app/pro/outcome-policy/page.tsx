'use client';

import { useCallback, useEffect, useState } from 'react';
import { toPersianDigits } from '@beauclick/persian-utils';
import { Alert, Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { Badge, PageHeader, Textarea } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import { ApiRequestError } from '@/lib/api-client';
import {
  OutcomeSelectionGroups,
  REASON_MAX_LENGTH,
  retentionLabel,
  type DraftSelection,
} from '@/components/outcome-selection-groups';
import {
  assignOutcomePolicy,
  assignableOutcomePolicies,
  financeWorkspaces,
  outcomePolicyAssignment,
  retentionRuleIdentity,
  type AssignableOutcomePolicyV1,
  type CurrentOutcomePolicyAssignmentV1,
  type FinanceWorkspace,
} from '@/lib/pro-api';

/**
 * The seller's cancellation and no-show terms — V3.3 `#42b` / #159,
 * ADR-051 §3, design `48_SELLER_OUTCOME_POLICY.md` with its reviewer
 * corrections.
 *
 * ## The seller does not write policy
 *
 * An administrator publishes ranges and sets (screen 47); the seller picks
 * ONE member of each, per workspace. Every group here renders exactly the
 * published members and nothing else. There is no numeric or free-text input
 * for any policy term -- a percentage that appears as a choice is itself a
 * published member.
 *
 * The one free-text field is the REASON, which is a required field on the
 * PUT (`AssignOutcomePolicyDto.reason`, pinned by `story-159-boundary.spec`).
 * The design's "no free-text field on this screen" is true of the selection
 * and false of the submission.
 *
 * ## Two sections of the design are not built, and cannot be
 *
 * The non-selectable published terms (§3) and the selection history (§4)
 * have no data source: `assignablePolicies()` deliberately withholds every
 * administrator value, and the assignment read answers with the current
 * selection or `null`, never a list. Recorded on #209.
 *
 * ## Where the workspace list comes from
 *
 * `GET /v1/me/finance/workspaces`, filtered to `accessMode: 'owner'`, because
 * no ownership-scoped list exists (#210). Fail-safe rather than authoritative:
 * this only decides what to OFFER, and the server decides ownership live
 * through the opaque reference and refuses anything wrong.
 *
 * No workspace is ever pre-selected, not even when there is one and not from
 * the previous session -- `V33-DEC-020`, the rule `finance-workspace.tsx`
 * already follows.
 */

const WORKSPACE_TYPE_LABEL: Record<FinanceWorkspace['workspaceType'], string> = {
  professional: 'تخصصی',
  business: 'کسب‌وکار',
};

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** The selection as a draft, pre-filled from a current assignment when there is one. */
function draftFrom(assignment: CurrentOutcomePolicyAssignmentV1 | null): DraftSelection {
  if (!assignment) return { cutoffHours: null, lateCancellationRetention: null, noShowGraceMinutes: null, noShowRetention: null };
  return {
    cutoffHours: assignment.selection.cutoffHours,
    lateCancellationRetention: retentionRuleIdentity(assignment.selection.lateCancellationRetention),
    noShowGraceMinutes: assignment.selection.noShowGraceMinutes,
    noShowRetention: retentionRuleIdentity(assignment.selection.noShowRetention),
  };
}

export default function ProOutcomePolicyPage() {
  const { api } = useAuth();

  const [workspaces, setWorkspaces] = useState<FinanceWorkspace[] | null>(null);
  const [workspacesError, setWorkspacesError] = useState<string | null>(null);

  const [activeRef, setActiveRef] = useState<string | null>(null);

  const [policies, setPolicies] = useState<AssignableOutcomePolicyV1[] | null>(null);
  const [policiesError, setPoliciesError] = useState<string | null>(null);

  const [assignment, setAssignment] = useState<CurrentOutcomePolicyAssignmentV1 | null>(null);
  const [assignmentLoaded, setAssignmentLoaded] = useState(false);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);

  const [draft, setDraft] = useState<DraftSelection>(draftFrom(null));
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const loadWorkspaces = useCallback(async () => {
    setWorkspacesError(null);
    try {
      const res = await financeWorkspaces(api);
      setWorkspaces((res.data?.items ?? []).filter((w) => w.accessMode === 'owner'));
    } catch (err) {
      setWorkspacesError(errorMessage(err, 'فهرست فضاها بارگذاری نشد.'));
    }
  }, [api]);

  const loadPolicies = useCallback(async () => {
    setPoliciesError(null);
    try {
      const res = await assignableOutcomePolicies(api);
      setPolicies(res.data?.items ?? []);
    } catch (err) {
      setPoliciesError(errorMessage(err, 'سیاست‌های قابل انتخاب بارگذاری نشد.'));
    }
  }, [api]);

  const loadAssignment = useCallback(
    async (workspaceRef: string) => {
      setAssignmentLoaded(false);
      setAssignmentError(null);
      try {
        const res = await outcomePolicyAssignment(api, workspaceRef);
        const current = res.data?.assignment ?? null;
        setAssignment(current);
        setDraft(draftFrom(current));
        setAssignmentLoaded(true);
      } catch (err) {
        setAssignmentError(errorMessage(err, 'انتخاب فعلی بارگذاری نشد.'));
      }
    },
    [api],
  );

  useEffect(() => {
    void loadWorkspaces();
    void loadPolicies();
  }, [loadWorkspaces, loadPolicies]);

  useEffect(() => {
    if (!activeRef) return;
    setSaved(false);
    setSaveError(null);
    setReason('');
    setAttempted(false);
    void loadAssignment(activeRef);
  }, [activeRef, loadAssignment]);

  // The policy a seller is choosing inside. With exactly one published key
  // there is nothing to choose between; with none, the screen says so.
  const policy = policies && policies.length > 0 ? (assignment ? policies.find((p) => p.policyKey === assignment.policyKey) ?? policies[0] : policies[0]) : null;

  const complete =
    draft.cutoffHours !== null &&
    draft.lateCancellationRetention !== null &&
    draft.noShowGraceMinutes !== null &&
    draft.noShowRetention !== null;
  const reasonMissing = reason.trim().length === 0;

  async function save() {
    if (!activeRef || !policy) return;
    setAttempted(true);
    if (!complete || reasonMissing) return;

    const late = policy.allowed.lateCancellationRetention.find((r) => retentionRuleIdentity(r) === draft.lateCancellationRetention);
    const noShow = policy.allowed.noShowRetention.find((r) => retentionRuleIdentity(r) === draft.noShowRetention);
    if (!late || !noShow) return;

    setBusy(true);
    setSaveError(null);
    try {
      const res = await assignOutcomePolicy(api, activeRef, {
        policyKey: policy.policyKey,
        cutoffHours: draft.cutoffHours!,
        lateCancellationRetention: late,
        noShowGraceMinutes: draft.noShowGraceMinutes!,
        noShowRetention: noShow,
        reason: reason.trim(),
      });
      setAssignment(res.data?.assignment ?? null);
      setSaved(true);
      setReason('');
      setAttempted(false);
    } catch (err) {
      // Nothing is cleared: the chosen members and the typed reason stay.
      setSaveError(err instanceof ApiRequestError ? err.message : errorMessage(err, 'انتخاب ثبت نشد.'));
    } finally {
      setBusy(false);
    }
  }

  const active = workspaces?.find((w) => w.workspaceRef === activeRef) ?? null;

  return (
    <div>
      <PageHeader
        title="شرایط لغو و عدم‌حضور"
        subtitle="مدیر بازه‌ها را منتشر می‌کند و شما از میان آن‌ها یکی را برمی‌گزینید. هیچ عددی اینجا تایپ نمی‌شود."
      />

      {workspacesError ? (
        <ErrorState message={workspacesError} onRetry={() => void loadWorkspaces()} />
      ) : workspaces === null ? (
        <LoadingState label="در حال بارگذاری فضاها…" />
      ) : workspaces.length === 0 ? (
        <Card>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.9 }}>هیچ فضایی که شما مالک آن باشید پیدا نشد.</p>
        </Card>
      ) : (
        <>
          {/* Never pre-selected — V33-DEC-020. */}
          <section data-testid="workspace-chooser" style={{ marginBlockEnd: 20 }}>
            <h2 style={{ fontSize: 15, fontWeight: 800, margin: '0 0 10px' }}>کدام فضا؟</h2>
            <div style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              {workspaces.map((workspace) => (
                <Card key={workspace.workspaceRef}>
                  <div data-workspace={workspace.workspaceRef} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{workspace.displayLabel}</span>
                      <Badge>{WORKSPACE_TYPE_LABEL[workspace.workspaceType]}</Badge>
                    </div>
                    <Button
                      inline
                      variant={activeRef === workspace.workspaceRef ? 'primary' : 'ghost'}
                      onClick={() => setActiveRef(workspace.workspaceRef)}
                    >
                      {activeRef === workspace.workspaceRef ? 'انتخاب‌شده' : 'انتخاب این فضا'}
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          </section>

          {!activeRef ? (
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.9, color: 'var(--bc-color-ink-soft)' }}>
              تا وقتی فضایی انتخاب نشده، شرایطی نمایش داده نمی‌شود.
            </p>
          ) : policiesError ? (
            <ErrorState message={policiesError} onRetry={() => void loadPolicies()} />
          ) : assignmentError ? (
            <ErrorState message={assignmentError} onRetry={() => void loadAssignment(activeRef)} />
          ) : policies === null || !assignmentLoaded ? (
            <LoadingState label="در حال بارگذاری شرایط…" />
          ) : !policy ? (
            /* Nothing published to choose from — its own state, not a failure. */
            <Card>
              <p data-state="nothing-published" style={{ margin: 0, fontSize: 14, lineHeight: 1.9 }}>
                هنوز هیچ سیاستی برای انتخاب منتشر نشده است. رزروهای شما مثل گذشته ادامه دارند.
              </p>
            </Card>
          ) : (
            <section data-testid="outcome-selection">
              {/* Fail-closed: a narrowed range no longer contains this selection. */}
              {assignment && !assignment.resolvable ? (
                <div data-state="fail-closed" style={{ marginBlockEnd: 16 }}>
                  <Alert tone="warning">
                    انتخاب فعلی شما دیگر در میان گزینه‌های منتشرشده نیست، بنابراین رزروهای تازه تا انتخاب دوباره پذیرفته نمی‌شوند.{' '}
                    <strong>رزروهایی که تا این لحظه گرفته شده‌اند دست‌نخورده‌اند</strong> و با همان شرایطی که زیر آن گرفته شده‌اند پیش می‌روند.
                  </Alert>
                </div>
              ) : null}

              {/* Not enrolled is legitimate — no warning icon, no "incomplete setup". */}
              {!assignment ? (
                <p data-state="not-enrolled" style={{ margin: '0 0 16px', fontSize: 13.5, lineHeight: 1.9, color: 'var(--bc-color-ink-soft)' }}>
                  هنوز شرایطی انتخاب نکرده‌اید و رزروهای شما مثل گذشته ادامه دارند. انتخاب، اختیاری است.
                </p>
              ) : null}

              {saved ? (
                <div style={{ marginBlockEnd: 16 }}>
                  <Alert tone="success">انتخاب تازه ثبت شد. رزروهایی که پیش از این گرفته شده‌اند تغییری نمی‌کنند.</Alert>
                </div>
              ) : null}

              <OutcomeSelectionGroups
                allowed={policy.allowed}
                value={draft}
                onChange={setDraft}
                disabled={busy}
                showErrors={attempted}
              />

              <Textarea
                label="دلیل این انتخاب"
                rows={2}
                maxLength={REASON_MAX_LENGTH}
                hint={`الزامی. حداکثر ${toPersianDigits(REASON_MAX_LENGTH)} نویسه.`}
                error={attempted && reasonMissing ? 'دلیل را بنویسید.' : undefined}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={busy}
              />

              {/* What the customer will be told, in shape — screen 47's copy family owns the real text. */}
              {complete ? (
                <Card>
                  <div data-testid="customer-consequence" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 800 }}>مشتری، پیش از تأیید رزرو، این را می‌بیند</span>
                    <p style={{ margin: 0, fontSize: 13, lineHeight: 1.95, color: 'var(--bc-color-ink-soft)' }}>
                      لغو رایگان تا {toPersianDigits(draft.cutoffHours ?? 0)} ساعت پیش از نوبت. پس از آن:{' '}
                      {retentionLabel(policy.allowed.lateCancellationRetention, draft.lateCancellationRetention)}. اگر در نوبت حاضر نشود، پس از{' '}
                      {toPersianDigits(draft.noShowGraceMinutes ?? 0)} دقیقه:{' '}
                      {retentionLabel(policy.allowed.noShowRetention, draft.noShowRetention)}.
                    </p>
                    <p style={{ margin: 0, fontSize: 12, color: 'var(--bc-color-ink-soft)' }}>
                      متنِ دقیقی که مشتری می‌بیند را مدیر منتشر می‌کند؛ این‌جا فقط شکلِ پیامد نشان داده می‌شود.
                    </p>
                  </div>
                </Card>
              ) : null}

              {saveError ? (
                <p role="alert" style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.85, color: 'var(--bc-color-error)' }}>
                  {saveError}
                </p>
              ) : null}

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBlockStart: 16 }}>
                <Button onClick={() => void save()} loading={busy}>
                  ثبت انتخاب
                </Button>
              </div>

              <p style={{ margin: '12px 0 0', fontSize: 12.5, lineHeight: 1.9, color: 'var(--bc-color-ink-soft)' }}>
                انتخاب تازه، انتخاب قبلی را جایگزین می‌کند. نوبت‌هایی که تا این لحظه گرفته شده‌اند با همان شرایطی که زیر آن گرفته شده‌اند پیش می‌روند.
              </p>
            </section>
          )}

          {active ? null : null}
        </>
      )}
    </div>
  );
}
