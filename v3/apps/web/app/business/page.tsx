'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatFullJalaliDate } from '@beauclick/persian-utils';
import { useAuth } from '@/lib/auth-context';
import { ProtectedRoute } from '@/components/protected-route';
import { Alert, Button, Card, ErrorState, Input, LoadingState } from '@/components/ui';
import { Badge, ConfirmDialog, PageHeader, SegmentedControl } from '@/components/kit';
import {
  acceptStaffInvite,
  createBusiness,
  declineStaffInvite,
  getBusiness,
  inviteStaff,
  leaveBusinessStaff,
  listBusinessStaff,
  myBusiness,
  myBusinessMemberships,
  removeStaff,
  type Business,
  type BusinessStaffMember,
} from '@/lib/phase4-api';

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
type PendingAction = { kind: 'remove' | 'decline' | 'leave'; staffId: string };

const PENDING_COPY: Record<PendingAction['kind'], { title: string; confirm: string; body: string }> = {
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
const STATUS_LABELS: Record<string, string> = { invited: 'دعوت‌شده', active: 'فعال', inactive: 'غیرفعال', declined: 'رد شده' };

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'error'> = {
  invited: 'warning',
  active: 'success',
  inactive: 'neutral',
  declined: 'error',
};

export default function BusinessPage() {
  return (
    <ProtectedRoute>
      <BusinessDashboard />
    </ProtectedRoute>
  );
}

function BusinessDashboard() {
  const { api, user } = useAuth();
  const [owned, setOwned] = useState<Business | null>(null);
  const [memberships, setMemberships] = useState<BusinessStaffMember[]>([]);
  const [staffBusiness, setStaffBusiness] = useState<Business | null>(null);
  const [staff, setStaff] = useState<BusinessStaffMember[]>([]);
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
   */
  const [pending, setPending] = useState<PendingAction | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ownedRes, membershipsRes] = await Promise.all([myBusiness(api), myBusinessMemberships(api)]);
      setOwned(ownedRes.data ?? null);
      const myMemberships = membershipsRes.data ?? [];
      setMemberships(myMemberships);

      if (ownedRes.data) {
        const staffRes = await listBusinessStaff(api, ownedRes.data.id);
        setStaff(staffRes.data ?? []);
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
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ثبت کسب‌وکار انجام نشد.');
    } finally {
      setBusy(false);
    }
  }

  async function handleInvite(userId: string, role: 'manager' | 'staff') {
    if (!owned) return;
    setBusy(true);
    setError(null);
    try {
      await inviteStaff(api, owned.id, { userId, role });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'دعوت ارسال نشد.');
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
            {staff.length === 0 ? (
              <p style={{ margin: '0 0 16px', color: 'var(--bc-color-ink-soft)', fontSize: 14 }}>
                هنوز عضوی اضافه نکرده‌اید.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px', display: 'grid', gap: 8 }}>
                {staff.map((member) => (
                  <li key={member.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 14 }}>
                      {ROLE_LABELS[member.role]}
                      <Badge tone={STATUS_TONE[member.status] ?? 'neutral'}>{STATUS_LABELS[member.status]}</Badge>
                    </span>
                    <Button
                      variant="danger"
                      inline
                      disabled={busy}
                      onClick={() =>
                        setPending({ kind: 'remove', staffId: member.id })
                      }
                    >
                      حذف
                    </Button>
                  </li>
                ))}
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

function InviteForm({
  onInvite,
  busy,
}: {
  onInvite: (userId: string, role: 'manager' | 'staff') => void;
  busy: boolean;
}) {
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'manager' | 'staff'>('staff');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (userId.trim()) onInvite(userId.trim(), role);
      }}
    >
      <Input
        label="شناسه کاربری فرد مورد نظر"
        hint="شناسه کاربری (شناسه حساب کاربری) فردی که می‌خواهید دعوت کنید."
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
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
        <SegmentedControl label="نقش" value={role} options={ROLE_OPTIONS} onChange={setRole} disabled={busy} />
      </div>
      <Button type="submit" loading={busy}>
        ارسال دعوت
      </Button>
    </form>
  );
}
