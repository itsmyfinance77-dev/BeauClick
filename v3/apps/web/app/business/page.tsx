'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { formatFullJalaliDate, normalizeDigits } from '@beauclick/persian-utils';
import { useAuth } from '@/lib/auth-context';
import { ApiRequestError } from '@/lib/api-client';
import { ProtectedRoute } from '@/components/protected-route';
import { Alert, Button, Card, ErrorState, Input, LoadingState } from '@/components/ui';
import { Badge, ConfirmDialog, PageHeader, SegmentedControl } from '@/components/kit';
import {
  acceptStaffInvite,
  createBusiness,
  declineStaffInvite,
  getBusiness,
  getStaffManagement,
  grantStaffRole,
  inviteStaff,
  leaveBusinessStaff,
  myBusiness,
  myBusinessMemberships,
  removeStaff,
  revokeStaffRole,
  type Business,
  type BusinessStaffMember,
  type BusinessStaffStatus,
  type StaffManagementMember,
} from '@/lib/phase4-api';

/**
 * Shown when the business was created but the session could not be rotated.
 *
 * Not phrased as a failed save: the business exists, and saying otherwise would
 * push the user toward a second `POST` that correctly conflicts.
 */
const SESSION_STALE_MESSAGE =
  'کسب‌وکار شما ثبت شد. برای فعال شدن دسترسی‌های فروشنده، یک‌بار از حساب خود خارج و دوباره وارد شوید.';

const ROLE_LABELS: Record<string, string> = { manager: 'مدیر', staff: 'کارمند' };

const ROLE_OPTIONS = [
  { value: 'staff' as const, label: 'کارمند' },
  { value: 'manager' as const, label: 'مدیر' },
];

/**
 * One irreversible action awaiting confirmation.
 *
 * Carries only the kind and the id it acts on. It deliberately does NOT carry a
 * person's name for the dialog to quote, because the staff API exposes a role
 * and a user id and no name -- writing one into the copy would mean inventing
 * it, the same reason the professional's booking card shows a truncated
 * reference rather than a customer identity.
 */
type PendingAction = { kind: 'remove' | 'decline' | 'leave' | 'revokeFinance'; staffId: string };

/**
 * Static copy for the three pre-existing pending kinds. `revokeFinance` is
 * deliberately absent -- V3.3 Story #149 requires its dialog to name the
 * EXACT member shown in the row, which static copy cannot do, so it is built
 * from the member record at render time instead (see `RevokeFinanceDialog`).
 */
const PENDING_COPY: Record<Exclude<PendingAction['kind'], 'revokeFinance'>, { title: string; confirm: string; body: string }> = {
  remove: {
    title: 'حذف عضو',
    confirm: 'حذف کن',
    body: 'این عضو از کسب‌وکار شما حذف می‌شود. برای بازگشت، باید دوباره دعوت شود.',
  },
  decline: {
    title: 'رد دعوت',
    confirm: 'رد کن',
    body: 'این دعوت رد می‌شود و از فهرست شما حذف می‌گردد. برای عضویت، باید دوباره دعوت شوید.',
  },
  leave: {
    title: 'خروج از کسب‌وکار',
    confirm: 'خارج شو',
    body: 'عضویت شما در این کسب‌وکار پایان می‌یابد. برای بازگشت، باید دوباره دعوت شوید.',
  },
};
/*
 * V3.3 Story #123. `removed` is the membership status V3.3 Story #109 (`#44c`)
 * added to the vocabulary -- privacy erasure had always written it while neither
 * the type system nor the database knew it. Without an entry here the badge for
 * an erased member rendered blank, which reads as a broken row rather than as a
 * real state.
 *
 * The copy is deliberately neutral and factual: the membership ended, and the
 * screen says nothing about the person or why.
 */
const STATUS_LABELS: Record<BusinessStaffStatus, string> = {
  invited: 'دعوت‌شده',
  active: 'فعال',
  inactive: 'غیرفعال',
  declined: 'رد شده',
  removed: 'حذف‌شده',
};

const STATUS_TONE: Record<BusinessStaffStatus, 'neutral' | 'success' | 'warning' | 'error'> = {
  invited: 'warning',
  active: 'success',
  inactive: 'neutral',
  declined: 'error',
  // Terminal and not an error the owner can act on -- the same quiet tone
  // `inactive` carries, for the same reason.
  removed: 'neutral',
};

/**
 * A row's identity, in the ONE plain-text form used everywhere it must be
 * spoken rather than shown: an action's accessible name, a dialog title, a
 * live-region announcement -- V3.3 Story #149 (`#149a`), screen 45 §1-a/§6.
 *
 * `labelSource: 'phone'` means the server's `displayLabel` already IS the
 * four-digit hint (no live professional profile), so repeating it verbatim
 * would read as "به ۰۰۰۰، شمارهٔ منتهی به ۰۰۰۰" -- the same four digits
 * twice. The neutral "عضوِ با شمارهٔ منتهی به …" frame is used instead, which
 * is also the only frame available when there is no name at all.
 */
function memberIdentityText(member: StaffManagementMember): string {
  return member.labelSource === 'phone'
    ? `عضوِ با شمارهٔ منتهی به ${member.identificationHint}`
    : `${member.displayLabel}، شمارهٔ منتهی به ${member.identificationHint}`;
}

/** The four-digit hint, LTR-isolated so it is never reordered inside an RTL line -- screen 45 §6. */
function HintDigits({ value }: { value: string }) {
  return (
    <span dir="ltr" style={{ unicodeBidi: 'isolate', fontVariantNumeric: 'tabular-nums' }}>
      {value}
    </span>
  );
}

/** The row's primary identity line -- screen 45 §1-b: a phone-labelled row is framed, never left as bare digits. */
function MemberIdentityLine({ member }: { member: StaffManagementMember }) {
  return member.labelSource === 'phone' ? (
    <span style={{ fontSize: 14, fontWeight: 700 }}>
      شمارهٔ منتهی به <HintDigits value={member.identificationHint} />
    </span>
  ) : (
    <span style={{ fontSize: 14, fontWeight: 700 }}>{member.displayLabel}</span>
  );
}

const FINANCE_READ = 'finance_read' as const;
const PRACTITIONER_CHAT = 'practitioner_chat' as const;

export default function BusinessPage() {
  return (
    <ProtectedRoute>
      <BusinessDashboard />
    </ProtectedRoute>
  );
}

function BusinessDashboard() {
  const { api, user, refreshSession } = useAuth();
  const [owned, setOwned] = useState<Business | null>(null);
  const [memberships, setMemberships] = useState<BusinessStaffMember[]>([]);
  const [staffBusiness, setStaffBusiness] = useState<Business | null>(null);
  /**
   * The owner-only staff-management read -- V3.3 #154, consumed by Story #149
   * (`#149a`). A sibling of the general roster (`GET .../staff`), never a
   * replacement for it: this is the ONLY source this screen reads a member's
   * identity from, because it is the only read that carries one safely.
   */
  const [staffManagement, setStaffManagement] = useState<StaffManagementMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A failed load leaves `owned` null, which is indistinguishable from
  // "you don't own a business" -- and that branch renders the CREATE form.
  // Offering to create a second business to someone who already has one,
  // because we couldn't reach the server, is not an acceptable fallback.
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * The pending destructive confirmation, if any.
   *
   * Removing a member, declining an invitation and leaving a business are all
   * irreversible through the product -- there is no undo, and re-entry needs a
   * fresh invitation from the owner. All three fired on a single click. The
   * professional surface confirms every destructive action through
   * `ConfirmDialog`; this surface simply predates that contract.
   *
   * `revokeFinance` (V3.3 Story #149, `#149a`) joins the same union rather
   * than a second dialog: revoking `finance_read` is exactly as destructive
   * and confirmed exactly the same way, and one dialog implementation is what
   * keeps the focus-trap/return contract from drifting between two.
   */
  const [pending, setPending] = useState<PendingAction | null>(null);
  /**
   * One in-flight grant per membership, keyed by staff id. Grant has NO
   * confirmation dialog (screen 45 §3-a): the button submits immediately, so
   * this is what disables it, marks it `aria-busy`, and prevents a duplicate
   * submission while the request is open. `{ error }` is a failed grant
   * that returned the row to its previous state and needs a retry control.
   */
  const [grantState, setGrantState] = useState<Record<string, 'pending' | { error: string } | undefined>>({});
  /** The last grant/revoke outcome, announced once through a shared polite live region -- screen 45 §3-a/§6. */
  const [financeAnnouncement, setFinanceAnnouncement] = useState('');
  /** The revoke dialog's own in-flight/failure state -- kept separate from `busy` so a failure keeps the dialog OPEN with a retry, unlike remove/decline/leave. */
  const [revokePending, setRevokePending] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  /** The explicit acknowledgement checkbox -- gates the confirm button (screen 45 §4 state 14). */
  const [revokeAcknowledged, setRevokeAcknowledged] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ownedRes, membershipsRes] = await Promise.all([myBusiness(api), myBusinessMemberships(api)]);
      setOwned(ownedRes.data ?? null);
      const myMemberships = membershipsRes.data ?? [];
      setMemberships(myMemberships);

      if (ownedRes.data) {
        const managementRes = await getStaffManagement(api, ownedRes.data.id);
        setStaffManagement(managementRes.data?.items ?? []);
      } else {
        // Not an owner -- am I an ACTIVE staff member of someone else's business?
        const activeMembership = myMemberships.find((m) => m.status === 'active');
        if (activeMembership) {
          const businessRes = await getBusiness(api, activeMembership.businessId);
          setStaffBusiness(businessRes.data ?? null);
        }
      }
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'اطلاعات کسب‌وکار بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(displayName: string) {
    setBusy(true);
    setError(null);
    try {
      await createBusiness(api, { displayName });

      /*
       * V3.3 #75 (`V33-DEC-021` Ruling 9). The `business` role was granted
       * server-side in the same transaction as the business row, but this
       * browser still holds the token it had before. Rotating the session here
       * is what makes the seller surfaces reachable now rather than at the next
       * natural refresh.
       *
       * The business EXISTS whether or not the rotation succeeds, so a failed
       * refresh is reported as a stale session and never as a failed creation --
       * retrying would `409` against the business just created.
       */
      const rotated = await refreshSession();
      await load();
      if (!rotated) setError(SESSION_STALE_MESSAGE);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ثبت کسب‌وکار انجام نشد.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Invite by phone -- V3.3 Story #123, migrating this screen onto the contract
   * V3.3 Story #109 (`#44c`) shipped.
   *
   * ## Why this returns a result instead of setting the page error
   *
   * The outcome belongs to the form: a malformed phone must come back as a
   * correctable field error with the number still in the box, which a
   * page-level alert cannot express. `InviteForm` owns both, so the two states
   * cannot drift apart.
   *
   * ## Why there is no `load()` here any more
   *
   * It used to refresh the roster immediately after inviting. Under the new
   * contract that would be an enumeration oracle rebuilt in the browser: a row
   * appearing next to the confirmation means the phone belonged to a real
   * eligible account, and no row means it did not -- exactly the difference
   * `V33-DEC-033` R3 removed from the response. A `202` is success either way,
   * so the confirmation is unconditional and the roster refreshes on the next
   * ordinary load.
   */
  async function handleInvite(
    phone: string,
    role: 'manager' | 'staff',
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!owned) return { ok: false, message: 'کسب‌وکاری برای دعوت یافت نشد.' };
    setBusy(true);
    setError(null);
    try {
      await inviteStaff(api, owned.id, { phone, role });
      return { ok: true };
    } catch (err) {
      // The server's own Persian text, never patched or re-interpreted here --
      // and never mapped onto a semantic outcome, because the response carries
      // none to map.
      return { ok: false, message: err instanceof Error ? err.message : 'دعوت ارسال نشد.' };
    } finally {
      setBusy(false);
    }
  }

  /**
   * Runs whichever irreversible action the dialog was opened for.
   *
   * One function rather than three near-identical ones: they differed only in
   * which API call they made, and the error/reload/busy handling was copied
   * three times with no variation -- which is how the three drifted into having
   * three different failure behaviours in the first place.
   */
  async function confirmPending() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      if (pending.kind === 'remove') {
        if (!owned) return;
        await removeStaff(api, owned.id, pending.staffId);
      } else if (pending.kind === 'decline') {
        await declineStaffInvite(api, pending.staffId);
      } else {
        await leaveBusinessStaff(api, pending.staffId);
      }
      setPending(null);
      await load();
    } catch (err) {
      // Close the dialog and surface the error on the page: a modal left open
      // over an error the user cannot act on inside it is a trap.
      setPending(null);
      setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
    } finally {
      setBusy(false);
    }
  }

  /** Merges a grant/revoke response's live `roles` into the one row it belongs to -- never a client-side guess. */
  function reconcileRoles(staffId: string, roles: readonly StaffManagementMember['roles'][number][]) {
    setStaffManagement((current) =>
      current.map((member) => (member.id === staffId ? { ...member, roles: [...roles] } : member)),
    );
  }

  /**
   * Grants `finance_read`, immediately -- V3.3 Story #149 (`#149a`), screen 45
   * §3-a. NO confirmation dialog: the action is reversible, so the button
   * itself (already carrying the member's identity in its accessible name)
   * submits on activation. `grantState[member.id] === 'pending'` both disables
   * the control and stops a second click from firing a second request.
   */
  async function handleGrant(member: StaffManagementMember) {
    if (!owned || grantState[member.id] === 'pending') return;
    const identity = memberIdentityText(member);
    setGrantState((current) => ({ ...current, [member.id]: 'pending' }));
    setFinanceAnnouncement(`در حال اعطای دسترسیِ فقط‌خواندنیِ مالی به ${identity}…`);
    try {
      const res = await grantStaffRole(api, owned.id, member.id, FINANCE_READ);
      reconcileRoles(member.id, res.data?.roles ?? []);
      setGrantState((current) => {
        const next = { ...current };
        delete next[member.id];
        return next;
      });
      setFinanceAnnouncement(`دسترسیِ فقط‌خواندنیِ مالی به ${identity} اعطا شد.`);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        // The membership stopped being grantable between the read and this
        // request (removed, deactivated, or the owner's own authority
        // lapsed). Re-reading the roster drops the row rather than leaving a
        // stale control behind it.
        setGrantState((current) => {
          const next = { ...current };
          delete next[member.id];
          return next;
        });
        setFinanceAnnouncement('');
        await load();
        // `load()` resets the page-level error to null at its own start, so
        // the neutral refusal is set AFTER it resolves -- otherwise the
        // reload would silently swallow the message this branch exists to
        // show.
        setError(err.message);
        return;
      }
      const message = err instanceof Error ? err.message : 'اعطا انجام نشد.';
      setGrantState((current) => ({ ...current, [member.id]: { error: message } }));
      setFinanceAnnouncement(`اعطای دسترسیِ مالی به ${identity} انجام نشد. وضعیتِ قبلیِ ردیف دست‌نخورده مانده است.`);
    }
  }

  /**
   * Revokes `finance_read` for the member named in `pending` -- V3.3 Story
   * #149 (`#149a`). Unlike `confirmPending`, a failure here does NOT close
   * the dialog: it stays open with the error and a retry, per screen 45 §4
   * state 13 ("the dialog stays open with its buttons disabled" while
   * pending, and offers retry on failure rather than dropping the owner back
   * to the roster with no path forward).
   */
  async function confirmRevoke() {
    if (!pending || pending.kind !== 'revokeFinance' || !owned) return;
    const member = staffManagement.find((m) => m.id === pending.staffId);
    if (!member) {
      setPending(null);
      return;
    }
    const identity = memberIdentityText(member);
    setRevokePending(true);
    setRevokeError(null);
    try {
      const res = await revokeStaffRole(api, owned.id, member.id, FINANCE_READ);
      reconcileRoles(member.id, res.data?.roles ?? []);
      setFinanceAnnouncement(`دسترسیِ فقط‌خواندنیِ مالیِ ${identity} بازپس گرفته شد.`);
      setPending(null);
      setRevokeAcknowledged(false);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        setPending(null);
        setRevokeAcknowledged(false);
        await load();
        // Set AFTER `load()` resolves -- `load()` clears the page-level error
        // at its own start, which would otherwise erase this message.
        setError(err.message);
        return;
      }
      setRevokeError(err instanceof Error ? err.message : 'بازپس‌گیری انجام نشد.');
    } finally {
      setRevokePending(false);
    }
  }

  async function handleAccept(staffId: string) {
    setBusy(true);
    try {
      await acceptStaffInvite(api, staffId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label="در حال بارگذاری…" />;
  if (!loaded) return <ErrorState message={error ?? 'اطلاعات کسب‌وکار بارگذاری نشد.'} onRetry={() => void load()} />;

  const pendingInvites = memberships.filter((m) => m.status === 'invited');
  const activeMembership = memberships.find((m) => m.status === 'active');

  return (
    <section style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
      {/* `PageHeader` rather than a bare `<h1>`, and a subtitle that says what
          this screen is FOR. The UI/UX backlog's item 17 records that this page
          "mixes three concerns in one undifferentiated stack" -- your
          invitations, the business you own, and the business you work for. It
          still shows whichever of those apply, because that is the real data
          model, but each is now a named section instead of an unlabelled
          card. */}
      <PageHeader title="کسب‌وکار" subtitle="دعوت‌ها، کسب‌وکار شما و اعضای آن." />
      {error ? <Alert tone="error">{error}</Alert> : null}

      {pendingInvites.length > 0 && (
        <Card>
          <h2 style={{ fontSize: 16, marginBlockStart: 0 }}>دعوت‌های شما</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {pendingInvites.map((invite) => (
              <li key={invite.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14 }}>دعوت به عنوان {ROLE_LABELS[invite.role]}</span>
                {/* `inline`, so two buttons in one row are two buttons rather
                    than two full-width blocks stacked by flex. */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button inline onClick={() => void handleAccept(invite.id)} loading={busy}>
                    پذیرفتن
                  </Button>
                  <Button
                    variant="danger"
                    inline
                    disabled={busy}
                    onClick={() =>
                      setPending({ kind: 'decline', staffId: invite.id })
                    }
                  >
                    رد کردن
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {owned ? (
        <>
          <Card>
            <h2 style={{ fontSize: 18, marginBlockStart: 0 }}>{owned.displayName}</h2>
            {owned.bio ? <p style={{ color: 'var(--bc-color-ink-soft)' }}>{owned.bio}</p> : null}
            <p style={{ fontSize: 13, color: 'var(--bc-color-ink-faint)', margin: 0 }}>
              ثبت‌شده در {formatFullJalaliDate(new Date(owned.createdAt))}
            </p>
          </Card>

          <Card>
            <h2 style={{ fontSize: 16, marginBlockStart: 0 }}>اعضای کسب‌وکار</h2>

            {/*
              V3.3 Story #149 (`#149a`) §3 -- standing informational copy above
              the roster, always visible and outside the action path: what a
              `finance_read` grant lets a member read (this business's
              summary, outstanding orders, settlement history, per-order
              ledger) and what it never lets them do (settle, pay out, refund,
              touch any ledger row, pick or cancel a subscription, buy
              booking credit, assign a collection policy, or manage staff
              authority).
            */}
            <div
              style={{
                marginBlockEnd: 16,
                padding: '12px 14px',
                borderRadius: 'var(--bc-radius-row)',
                background: 'var(--bc-color-surface-tint)',
                fontSize: 12.5,
                lineHeight: 1.8,
                color: 'var(--bc-color-ink-soft)',
              }}
            >
              «دسترسیِ فقط‌خواندنیِ مالی» به عضو اجازه می‌دهد خلاصهٔ مالی، سفارش‌های در انتظارِ تسویه، تاریخچهٔ تسویه و ریزِ
              تراکنشِ هر سفارشِ همین کسب‌وکار را بخواند. او نمی‌تواند تسویه، پرداخت، بازگشتِ وجه یا هیچ ردیفِ دفترِ مالی را
              تغییر دهد، اشتراک را انتخاب یا لغو کند، اعتبار بخرد، سیاستِ دریافت را انتساب دهد یا اختیارِ کارکنان را مدیریت کند.
            </div>

            {/* Announces the start, success and failure of every grant/revoke,
                naming the member each time -- screen 45 §3-a/§6. The node
                stays mounted so a live region's text-only changes keep
                announcing on every transition. */}
            <div role="status" aria-live="polite" style={{ fontSize: 12.5, color: 'var(--bc-color-ink-soft)', minHeight: financeAnnouncement ? undefined : 0, marginBlockEnd: financeAnnouncement ? 12 : 0 }}>
              {financeAnnouncement}
            </div>

            {staffManagement.length === 0 ? (
              <p style={{ margin: '0 0 16px', color: 'var(--bc-color-ink-soft)', fontSize: 14 }}>
                هنوز عضوی اضافه نکرده‌اید.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px', display: 'grid', gap: 0 }}>
                {staffManagement.map((member) => {
                  const grant = grantState[member.id];
                  const isGranting = grant === 'pending';
                  const grantError = grant && typeof grant === 'object' ? grant.error : null;
                  const hasFinance = member.roles.includes(FINANCE_READ);
                  const hasPractitioner = member.roles.includes(PRACTITIONER_CHAT);
                  const identity = memberIdentityText(member);
                  const grantErrorId = `finance-grant-error-${member.id}`;

                  return (
                    <li
                      key={member.id}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                        padding: '14px 0',
                        borderBlockEnd: '1px solid var(--bc-color-line)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 12,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 240 }}>
                          <MemberIdentityLine member={member} />
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                            {ROLE_LABELS[member.role]}
                            <Badge tone={STATUS_TONE[member.status] ?? 'neutral'}>{STATUS_LABELS[member.status]}</Badge>
                            {member.labelSource === 'professional' ? (
                              <span>
                                شمارهٔ منتهی به <HintDigits value={member.identificationHint} />
                              </span>
                            ) : null}
                          </span>
                        </span>

                        <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          {hasPractitioner ? <Badge tone="neutral">اختیارِ گفتگوی متخصص</Badge> : null}

                          {member.status === 'active' ? (
                            hasFinance ? (
                              <>
                                <Badge tone="success">دسترسیِ فقط‌خواندنیِ مالی — فعال</Badge>
                                <Button
                                  type="button"
                                  variant="danger"
                                  inline
                                  aria-label={`بازپس‌گیریِ دسترسیِ مالی از ${identity}`}
                                  onClick={() => {
                                    setRevokeAcknowledged(false);
                                    setRevokeError(null);
                                    setPending({ kind: 'revokeFinance', staffId: member.id });
                                  }}
                                >
                                  بازپس‌گیری
                                </Button>
                              </>
                            ) : (
                              <>
                                <Badge tone="neutral">بدونِ دسترسیِ مالی</Badge>
                                <Button
                                  type="button"
                                  inline
                                  disabled={isGranting}
                                  busy={isGranting}
                                  aria-label={
                                    isGranting
                                      ? `در حالِ اعطای دسترسیِ مالی به ${identity}`
                                      : `اعطای دسترسیِ فقط‌خواندنیِ مالی به ${identity}`
                                  }
                                  onClick={() => void handleGrant(member)}
                                >
                                  {isGranting ? 'در حالِ اعطا…' : 'اعطای دسترسیِ فقط‌خواندنیِ مالی'}
                                </Button>
                              </>
                            )
                          ) : member.status === 'invited' ? (
                            <span style={{ fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                              تا پیش از پذیرشِ دعوت، اعطا ممکن نیست
                            </span>
                          ) : null}
                        </span>
                      </div>

                      {grantError ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <span id={grantErrorId} role="alert" style={{ fontSize: 12.5, color: 'var(--bc-color-error)' }}>
                            {grantError}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            inline
                            aria-describedby={grantErrorId}
                            aria-label={`تلاشِ دوباره برای اعطای دسترسیِ مالی به ${identity}`}
                            onClick={() => void handleGrant(member)}
                          >
                            تلاشِ دوباره
                          </Button>
                        </div>
                      ) : null}

                      <div>
                        <Button
                          variant="danger"
                          inline
                          disabled={busy}
                          onClick={() => setPending({ kind: 'remove', staffId: member.id })}
                        >
                          حذف
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <InviteForm onInvite={handleInvite} busy={busy} />
          </Card>
        </>
      ) : staffBusiness ? (
        <Card>
          <h2 style={{ fontSize: 18, marginBlockStart: 0 }}>{staffBusiness.displayName}</h2>
          {staffBusiness.bio ? <p style={{ color: 'var(--bc-color-ink-soft)' }}>{staffBusiness.bio}</p> : null}
          <p style={{ fontSize: 13, color: 'var(--bc-color-ink-faint)' }}>شما به عنوان عضو این کسب‌وکار فعالیت می‌کنید.</p>
          {activeMembership && (
            <Button
              variant="danger"
              inline
              disabled={busy}
              onClick={() =>
                setPending({ kind: 'leave', staffId: activeMembership.id })
              }
            >
              خروج از کسب‌وکار
            </Button>
          )}
        </Card>
      ) : (
        <Card>
          <h2 style={{ fontSize: 16, marginBlockStart: 0 }}>ثبت کسب‌وکار جدید</h2>
          <p style={{ color: 'var(--bc-color-ink-soft)' }}>
            {user?.displayName ?? user?.phone} عزیز، برای مدیریت کارکنان و مالی کسب‌وکار خود، ابتدا آن را ثبت کنید.
          </p>
          <CreateBusinessForm onCreate={handleCreate} busy={busy} />
        </Card>
      )}

      {(() => {
        const revokeMember =
          pending?.kind === 'revokeFinance' ? staffManagement.find((m) => m.id === pending.staffId) ?? null : null;
        const revokeIdentity = revokeMember ? memberIdentityText(revokeMember) : '';
        const revokeDescriptionId = 'finance-revoke-description';

        if (pending?.kind === 'revokeFinance') {
          return (
            <ConfirmDialog
              open
              title={`بازپس‌گیریِ دسترسیِ مالیِ ${revokeIdentity}؟`}
              tone="danger"
              confirmLabel={revokeError ? 'تلاشِ دوباره' : 'بازپس می‌گیرم'}
              busy={revokePending}
              confirmDisabled={!revokeAcknowledged}
              describedById={revokeDescriptionId}
              onConfirm={() => void confirmRevoke()}
              onCancel={() => {
                setPending(null);
                setRevokeError(null);
                setRevokeAcknowledged(false);
              }}
              body={
                <div id={revokeDescriptionId} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <p style={{ margin: 0 }}>
                    از درخواستِ بعدیِ این عضو، دسترسی‌اش به اطلاعاتِ مالیِ این کسب‌وکار قطع می‌شود. اگر همین حالا صفحهٔ مالی را
                    باز داشته باشد، داده‌های نمایش‌داده‌شده پاک می‌شوند و به فهرستِ فضاهای باقی‌مانده بازمی‌گردد.
                  </p>
                  <p style={{ margin: 0 }}>عضویتِ او در کسب‌وکار دست‌نخورده می‌ماند؛ فقط این اختیار برداشته می‌شود.</p>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={revokeAcknowledged}
                      disabled={revokePending}
                      onChange={(event) => setRevokeAcknowledged(event.target.checked)}
                      style={{ marginTop: 3, width: 18, height: 18, flexShrink: 0 }}
                    />
                    <span>می‌دانم که این کار دسترسیِ مالیِ {revokeIdentity} را قطع می‌کند.</span>
                  </label>
                  {revokeError ? (
                    <span role="alert" style={{ fontSize: 12.5, color: 'var(--bc-color-error)' }}>
                      {revokeError}
                    </span>
                  ) : null}
                </div>
              }
            />
          );
        }

        return (
          <ConfirmDialog
            open={pending !== null}
            title={pending ? PENDING_COPY[pending.kind].title : ''}
            tone="danger"
            confirmLabel={pending ? PENDING_COPY[pending.kind].confirm : ''}
            busy={busy}
            onConfirm={() => void confirmPending()}
            onCancel={() => setPending(null)}
            body={pending ? <p style={{ margin: 0 }}>{PENDING_COPY[pending.kind].body}</p> : null}
          />
        );
      })()}
    </section>
  );
}

function CreateBusinessForm({ onCreate, busy }: { onCreate: (displayName: string) => void; busy: boolean }) {
  const [displayName, setDisplayName] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (displayName.trim()) onCreate(displayName.trim());
      }}
    >
      <Input label="نام کسب‌وکار" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
      <Button type="submit" loading={busy}>
        ثبت کسب‌وکار
      </Button>
    </form>
  );
}

/**
 * Invite a colleague by phone -- V3.3 Story #123.
 *
 * ## One confirmation, for every outcome
 *
 * `V33-DEC-033` R3 makes the server answer a byte-identical `202 {}` whether the
 * phone belongs to a known eligible account, to nobody, to the owner
 * themselves, to someone already invited, to someone affiliated with another
 * business, or to a deleted account. The browser cannot tell those apart, and
 * must not appear to: there is exactly ONE success message, it is set
 * unconditionally, and nothing in this component branches on anything the
 * response contains -- because it contains nothing.
 *
 * The copy says only that the request was received. It does not say a person
 * exists, that a membership was created, that an SMS went out, or who was
 * invited. Any of those would rebuild in the UI the enumeration oracle the
 * backend removed.
 *
 * ## The phone rule is the server's
 *
 * Digits are normalised to ASCII with the platform's existing `normalizeDigits`
 * -- the same call `/admin/users` already makes -- so a number typed with
 * Persian digits reaches the API in the form it expects. Nothing here decides
 * whether a string IS an Iranian mobile: `canonicalizePhone` on the server is
 * the single authority, and a second grammar in the browser would be one more
 * rule to drift. A malformed number therefore comes back as the ordinary
 * syntactic `400` and is shown against the field.
 */
function InviteForm({
  onInvite,
  busy,
}: {
  onInvite: (phone: string, role: 'manager' | 'staff') => Promise<{ ok: true } | { ok: false; message: string }>;
  busy: boolean;
}) {
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<'manager' | 'staff'>('staff');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    // Guards a second submit from a double click or a repeated Enter while the
    // first request is still open.
    if (submitting || busy) return;
    const entered = normalizeDigits(phone.trim());
    if (!entered) return;

    setSubmitting(true);
    setFieldError(null);
    setSent(false);
    const result = await onInvite(entered, role);
    setSubmitting(false);

    if (result.ok) {
      setSent(true);
      // Cleared only on success, so a rejected number stays on screen to be
      // corrected rather than retyped.
      setPhone('');
      return;
    }
    setFieldError(result.message);
  }

  const pending = submitting || busy;

  return (
    <form onSubmit={submit} noValidate>
      {sent ? <Alert tone="success">درخواست دعوت دریافت شد و در حال بررسی است.</Alert> : null}
      <Input
        label="شماره موبایل همکار"
        name="phone"
        type="tel"
        inputMode="numeric"
        autoComplete="tel"
        placeholder="09123456789"
        hint="دعوت به این شماره ارسال می‌شود."
        value={phone}
        onChange={(e) => {
          setPhone(e.target.value);
          // Editing after a refusal clears the stale message; the confirmation
          // is left alone so it does not flicker away as the next number is
          // typed.
          if (fieldError) setFieldError(null);
        }}
        error={fieldError ?? undefined}
        required
      />
      {/* Two bare radios in labels with no `minHeight`, so the tappable area was
          the glyph plus a 14px line -- around 20px, well under the project's own
          44px baseline. The pattern `/pro` uses for a checkbox (a 44px label
          WRAPPING the input, which is what makes the whole chip tappable) does
          not apply cleanly to a two-option exclusive choice, and this is exactly
          that: `SegmentedControl` is the component for it, already carries the
          baseline, and is what the analytics range and availability horizon
          use. */}
      <div style={{ marginBlockEnd: 16 }}>
        <SegmentedControl label="نقش" value={role} options={ROLE_OPTIONS} onChange={setRole} disabled={pending} />
      </div>
      <Button type="submit" loading={pending}>
        ارسال دعوت
      </Button>
    </form>
  );
}
