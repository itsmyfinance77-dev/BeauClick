'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatFullJalaliDate } from '@beauclick/persian-utils';
import { useAuth } from '@/lib/auth-context';
import { ProtectedRoute } from '@/components/protected-route';
import { Alert, Button, Card, Input, LoadingState } from '@/components/ui';
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
const STATUS_LABELS: Record<string, string> = { invited: 'دعوت‌شده', active: 'فعال', inactive: 'غیرفعال', declined: 'رد شده' };

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
  const [busy, setBusy] = useState(false);

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

  async function handleRemove(staffId: string) {
    if (!owned) return;
    setBusy(true);
    try {
      await removeStaff(api, owned.id, staffId);
      await load();
    } catch (err) {
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

  async function handleDecline(staffId: string) {
    setBusy(true);
    try {
      await declineStaffInvite(api, staffId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
    } finally {
      setBusy(false);
    }
  }

  async function handleLeave(staffId: string) {
    setBusy(true);
    try {
      await leaveBusinessStaff(api, staffId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label="در حال بارگذاری…" />;

  const pendingInvites = memberships.filter((m) => m.status === 'invited');
  const activeMembership = memberships.find((m) => m.status === 'active');

  return (
    <section style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
      <h1 style={{ fontSize: 24, marginBlockEnd: 0 }}>کسب‌وکار</h1>
      {error ? <Alert tone="error">{error}</Alert> : null}

      {pendingInvites.length > 0 && (
        <Card>
          <h2 style={{ fontSize: 16, marginBlockStart: 0 }}>دعوت‌های شما</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {pendingInvites.map((invite) => (
              <li key={invite.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14 }}>دعوت به عنوان {ROLE_LABELS[invite.role]}</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button onClick={() => void handleAccept(invite.id)} loading={busy}>
                    پذیرفتن
                  </Button>
                  <Button variant="ghost" onClick={() => void handleDecline(invite.id)} disabled={busy}>
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
              <p style={{ margin: 0, color: 'var(--bc-color-ink-soft)' }}>هنوز عضوی اضافه نکرده‌اید.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px', display: 'grid', gap: 8 }}>
                {staff.map((member) => (
                  <li key={member.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14 }}>
                      {ROLE_LABELS[member.role]} — {STATUS_LABELS[member.status]}
                    </span>
                    <Button variant="ghost" onClick={() => void handleRemove(member.id)} disabled={busy}>
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
            <Button variant="ghost" onClick={() => void handleLeave(activeMembership.id)} loading={busy}>
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
      <div style={{ display: 'flex', gap: 8, marginBlockEnd: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 14 }}>
          <input type="radio" name="role" checked={role === 'staff'} onChange={() => setRole('staff')} />
          کارمند
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 14 }}>
          <input type="radio" name="role" checked={role === 'manager'} onChange={() => setRole('manager')} />
          مدیر
        </label>
      </div>
      <Button type="submit" loading={busy}>
        ارسال دعوت
      </Button>
    </form>
  );
}
