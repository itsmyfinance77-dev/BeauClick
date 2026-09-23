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
import styles from './outcome-policy.module.css';

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

  /**
   * Which published key the seller is choosing INSIDE.
   *
   * `null` until it is known, and never guessed. An administrator may publish
   * more than one key -- screen 50's own sample identifiers are
   * `standard-outcome` and `strict-outcome` -- and picking `items[0]` for the
   * seller is exactly the defect `V33-DEC-020` names, applied to a policy key
   * instead of a workspace. It is set without asking only when there is
   * nothing to ask about: one published key, or a key the seller has already
   * chosen before.
   */
  const [activePolicyKey, setActivePolicyKey] = useState<string | null>(null);

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
    setActivePolicyKey(null);
    void loadAssignment(activeRef);
  }, [activeRef, loadAssignment]);

  useEffect(() => {
    if (!policies || !assignmentLoaded || activePolicyKey !== null) return;
    // The key the seller already chose -- not a guess, a fact.
    if (assignment && policies.some((p) => p.policyKey === assignment.policyKey)) {
      setActivePolicyKey(assignment.policyKey);
      return;
    }
    // One published key: nothing to choose between.
    if (policies.length === 1) setActivePolicyKey(policies[0].policyKey);
  }, [policies, assignment, assignmentLoaded, activePolicyKey]);

  const policy = policies?.find((p) => p.policyKey === activePolicyKey) ?? null;
  const mustChoosePolicy = !!policies && policies.length > 1 && activePolicyKey === null;

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
          <p className={styles.simpleCardText}>هیچ فضایی که شما مالک آن باشید پیدا نشد.</p>
        </Card>
      ) : (
        <>
          {/* Never pre-selected — V33-DEC-020. */}
          <section data-testid="workspace-chooser" className={styles.workspaceSection}>
            <h2 className={styles.sectionTitle}>کدام فضا؟</h2>
            <div className={styles.cardGrid}>
              {workspaces.map((workspace) => (
                <Card key={workspace.workspaceRef}>
                  <div data-workspace={workspace.workspaceRef} className={styles.optionCard}>
                    <div className={styles.optionHeader}>
                      <span className={styles.optionName}>{workspace.displayLabel}</span>
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
            <p className={styles.hintNote}>تا وقتی فضایی انتخاب نشده، شرایطی نمایش داده نمی‌شود.</p>
          ) : policiesError ? (
            <ErrorState message={policiesError} onRetry={() => void loadPolicies()} />
          ) : assignmentError ? (
            <ErrorState message={assignmentError} onRetry={() => void loadAssignment(activeRef)} />
          ) : policies === null || !assignmentLoaded ? (
            <LoadingState label="در حال بارگذاری شرایط…" />
          ) : policies.length === 0 ? (
            /*
              Nothing published to choose from — its own state, not a failure.
              Keyed on the LIST being empty, not on `policy` being null: with
              two keys published and none chosen yet `policy` is also null,
              and telling that seller nothing is published would be a worse
              lie than the `items[0]` guess this branch order replaced.
            */
            <Card>
              <p data-state="nothing-published" className={styles.simpleCardText}>
                هنوز هیچ سیاستی برای انتخاب منتشر نشده است. رزروهای شما مثل گذشته ادامه دارند.
              </p>
            </Card>
          ) : mustChoosePolicy ? (
            /*
              More than one key is published and this seller has never chosen.
              Nothing below renders until they do -- the same rule the
              workspace chooser follows, for the same reason.
            */
            <section data-testid="policy-chooser">
              <h2 className={styles.sectionTitle}>کدام مجموعه شرایط؟</h2>
              <div className={styles.cardGrid}>
                {policies!.map((option) => (
                  <Card key={option.policyKey}>
                    <div data-policy={option.policyKey} className={styles.optionCard}>
                      <span className={styles.optionName}>{option.displayName}</span>
                      <Button inline variant="ghost" onClick={() => setActivePolicyKey(option.policyKey)}>
                        انتخاب
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          ) : !policy ? (
            <LoadingState label="در حال بارگذاری شرایط…" />
          ) : (
            <section data-testid="outcome-selection">
              {/* Fail-closed: a narrowed range no longer contains this selection. */}
              {assignment && !assignment.resolvable ? (
                <div data-state="fail-closed" className={styles.blockGap}>
                  <Alert tone="warning">
                    انتخاب فعلی شما دیگر در میان گزینه‌های منتشرشده نیست، بنابراین رزروهای تازه تا انتخاب دوباره پذیرفته نمی‌شوند.{' '}
                    <strong>رزروهایی که تا این لحظه گرفته شده‌اند دست‌نخورده‌اند</strong> و با همان شرایطی که زیر آن گرفته شده‌اند پیش می‌روند.
                  </Alert>
                </div>
              ) : null}

              {/* Not enrolled is legitimate — no warning icon, no "incomplete setup". */}
              {!assignment ? (
                <p data-state="not-enrolled" className={styles.notEnrolledNote}>
                  هنوز شرایطی انتخاب نکرده‌اید و رزروهای شما مثل گذشته ادامه دارند. انتخاب، اختیاری است.
                </p>
              ) : null}

              {saved ? (
                <div className={styles.blockGap}>
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
                  <div data-testid="customer-consequence" className={styles.consequenceStack}>
                    <span className={styles.consequenceTitle}>مشتری، پیش از تأیید رزرو، این را می‌بیند</span>
                    <p className={styles.consequenceText}>
                      لغو رایگان تا {toPersianDigits(draft.cutoffHours ?? 0)} ساعت پیش از نوبت. پس از آن:{' '}
                      {retentionLabel(policy.allowed.lateCancellationRetention, draft.lateCancellationRetention)}. اگر در نوبت حاضر نشود، پس از{' '}
                      {toPersianDigits(draft.noShowGraceMinutes ?? 0)} دقیقه:{' '}
                      {retentionLabel(policy.allowed.noShowRetention, draft.noShowRetention)}.
                    </p>
                    <p className={styles.consequenceFootnote}>
                      متنِ دقیقی که مشتری می‌بیند را مدیر منتشر می‌کند؛ این‌جا فقط شکلِ پیامد نشان داده می‌شود.
                    </p>
                  </div>
                </Card>
              ) : null}

              {saveError ? (
                <p role="alert" className={styles.saveError}>
                  {saveError}
                </p>
              ) : null}

              <div className={styles.saveActions}>
                <Button onClick={() => void save()} loading={busy}>
                  ثبت انتخاب
                </Button>
              </div>

              <p className={styles.replaceNote}>
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
