'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatToman, formatZonedFullDate, formatZonedTime, toPersianDigits } from '@beauclick/persian-utils';
import { Card, ErrorState, LoadingState } from '@/components/ui';
import { Badge, EmptyState, PageHeader, TextLink } from '@/components/pro-ui';
import { useProProfile } from '@/lib/pro-context';
import { useAuth } from '@/lib/auth-context';
import {
  financeSummary,
  listMyServices,
  listMySlots,
  listProfessionalBookings,
  type BookingSummary,
  type FinanceSummary,
  type MySlot,
  type ServiceOffering,
} from '@/lib/pro-api';

/**
 * The professional's landing screen.
 *
 * Two jobs, and the second is the one that matters for a brand-new
 * professional: show what is happening today, and say plainly what is still
 * missing before anyone can book them. A supply-side user who publishes no
 * availability simply never receives a booking and is given no reason why --
 * so the setup checklist below is not decoration, it is the answer to the
 * only question a new professional actually has.
 */
export default function ProOverviewPage() {
  const { state, profile, error, reload } = useProProfile();
  const { api } = useAuth();

  const [bookings, setBookings] = useState<BookingSummary[]>([]);
  const [services, setServices] = useState<ServiceOffering[]>([]);
  const [slots, setSlots] = useState<MySlot[]>([]);
  const [finance, setFinance] = useState<FinanceSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (state !== 'ready' || !profile) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [bookingRes, serviceRes, slotRes, financeRes] = await Promise.all([
        listProfessionalBookings(api, 1, 50),
        listMyServices(api, profile.id),
        listMySlots(api, {
          from: new Date().toISOString(),
          to: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        }),
        // A professional with no paid order yet has no seller party, and the
        // finance route correctly answers NOT_FOUND_OR_NOT_YOURS. That is not
        // an error worth failing the whole dashboard over.
        financeSummary(api).catch(() => ({ data: null as FinanceSummary | null })),
      ]);
      setBookings(bookingRes.data ?? []);
      setServices(serviceRes.data ?? []);
      setSlots(slotRes.data ?? []);
      setFinance(financeRes.data ?? null);
      setLoaded(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'اطلاعات نمای کلی بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api, state, profile]);

  useEffect(() => {
    void load();
  }, [load]);

  const { today, awaitingAction, openSlots } = useMemo(() => {
    const now = Date.now();
    const endOfWindow = now + 24 * 3_600_000;
    return {
      today: bookings.filter((b) => {
        const start = new Date(b.startAt).getTime();
        return start >= now && start <= endOfWindow && b.status === 'confirmed';
      }),
      // Finished, still confirmed: these are exactly the bookings whose
      // completion nothing else in the platform can trigger.
      awaitingAction: bookings.filter(
        (b) => b.status === 'confirmed' && new Date(b.endAt).getTime() <= now,
      ),
      openSlots: slots.filter((s) => s.status === 'open'),
    };
  }, [bookings, slots]);

  if (state === 'loading') return <LoadingState label="در حال بارگذاری پروفایل متخصص…" />;
  if (state === 'error') {
    return <ErrorState message={error ?? 'پروفایل متخصص بارگذاری نشد.'} onRetry={() => void reload()} />;
  }
  if (state === 'none' || !profile) {
    return (
      <>
        <PageHeader title="حالت متخصص" subtitle="برای شروع، پروفایل متخصص خود را بسازید." />
        <EmptyState
          message="هنوز پروفایل متخصص ندارید. با ساخت پروفایل می‌توانید خدمات خود را ثبت کنید، زمان‌های آزاد بگذارید و رزرو بگیرید."
          action={<TextLink href="/pro/profile">ساخت پروفایل متخصص</TextLink>}
        />
      </>
    );
  }

  const setupSteps = [
    { done: services.length > 0, label: 'ثبت حداقل یک خدمت', href: '/pro/services' },
    { done: openSlots.length > 0, label: 'ثبت زمان‌های آزاد', href: '/pro/availability' },
    { done: profile.specialties.length > 0, label: 'انتخاب تخصص‌ها', href: '/pro/profile' },
    { done: profile.cityId !== null, label: 'انتخاب شهر', href: '/pro/profile' },
  ];
  const remaining = setupSteps.filter((step) => !step.done);

  return (
    <>
      <PageHeader title={`سلام، ${profile.displayName}`} subtitle="نمای کلی کسب‌وکار شما." />

      {loadError ? <ErrorState message={loadError} onRetry={() => void load()} /> : null}
      {loading && !loaded ? <LoadingState label="در حال بارگذاری نمای کلی…" /> : null}

      {loaded && remaining.length > 0 ? (
        <Card>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>تکمیل راه‌اندازی</h2>
          <p style={{ fontSize: 13, color: 'var(--bc-color-ink-soft)', margin: '0 0 12px' }}>
            تا این موارد کامل نشود، مشتری‌ها نمی‌توانند شما را پیدا کنند یا رزرو کنند.
          </p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
            {setupSteps.map((step) => (
              <li key={step.label} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <Badge tone={step.done ? 'success' : 'warning'}>{step.done ? 'انجام شد' : 'باقی مانده'}</Badge>
                <span style={{ fontSize: 14 }}>{step.label}</span>
                {!step.done ? <TextLink href={step.href}>انجام بده</TextLink> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {loaded ? (
        <div
          style={{
            display: 'grid',
            gap: 'var(--bc-spacing-card-gap)',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            marginBlockStart: remaining.length > 0 ? 20 : 0,
          }}
        >
          <Card>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>نوبت‌های ۲۴ ساعت آینده</p>
            <p style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 800 }}>{toPersianDigits(today.length)}</p>
          </Card>
          <Card>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>زمان‌های آزاد</p>
            <p style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 800 }}>{toPersianDigits(openSlots.length)}</p>
          </Card>
          <Card>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>خدمات</p>
            <p style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 800 }}>{toPersianDigits(services.length)}</p>
          </Card>
          {finance ? (
            <Card>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>خالص قابل دریافت</p>
              <p style={{ margin: '6px 0 0', fontSize: 18, fontWeight: 800 }}>
                {formatToman(finance.receivableNetToman)}
              </p>
            </Card>
          ) : null}
        </div>
      ) : null}

      {loaded && awaitingAction.length > 0 ? (
        <div style={{ marginBlockStart: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>در انتظار ثبت وضعیت</h2>
          <p style={{ fontSize: 13, color: 'var(--bc-color-ink-soft)', margin: '0 0 12px' }}>
            زمان این نوبت‌ها گذشته است. تا وضعیت آن‌ها را ثبت نکنید، امتیاز باشگاه مشتری و آمار شما به‌روز نمی‌شود.
          </p>
          <div style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
            {awaitingAction.slice(0, 5).map((booking) => (
              <Card key={booking.id}>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--bc-spacing-chip-gap)',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>
                      {formatZonedFullDate(new Date(booking.startAt))}
                    </p>
                    <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>
                      ساعت {formatZonedTime(new Date(booking.startAt))}
                    </p>
                  </div>
                  <TextLink href="/pro/bookings">ثبت وضعیت</TextLink>
                </div>
              </Card>
            ))}
          </div>
        </div>
      ) : null}

      {loaded && today.length > 0 ? (
        <div style={{ marginBlockStart: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>نوبت‌های پیش‌رو</h2>
          <div style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
            {today.map((booking) => (
              <Card key={booking.id}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>
                  {formatZonedFullDate(new Date(booking.startAt))} — ساعت {formatZonedTime(new Date(booking.startAt))}
                </p>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>
                  {services.find((s) => s.id === booking.serviceId)?.name ?? 'خدمت نامشخص'}
                </p>
              </Card>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
