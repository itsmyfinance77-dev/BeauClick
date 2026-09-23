'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatZonedFullDate, formatZonedTime, toPersianDigits } from '@beauclick/persian-utils';
import { PriceDisplay } from '@/components/price-display';
import Link from 'next/link';
import { ErrorState, LoadingState } from '@/components/ui';
import { Badge, EmptyState, PageHeader, TextLink } from '@/components/kit';
import styles from './pro-today.module.css';
import { useProProfile } from '@/lib/pro-context';
import { useAuth } from '@/lib/auth-context';
import {
  financeSummary,
  financeWorkspaces,
  listMyServices,
  listMySlots,
  listProfessionalBookings,
  type ProfessionalBookingSummary,
  type FinanceSummary,
  type FinanceWorkspace,
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

  const [bookings, setBookings] = useState<ProfessionalBookingSummary[]>([]);
  const [services, setServices] = useState<ServiceOffering[]>([]);
  const [slots, setSlots] = useState<MySlot[]>([]);
  const [finance, setFinance] = useState<FinanceSummary | null>(null);
  // A dual owner has no single dashboard figure, so the tile becomes a link.
  const [multipleWorkspaces, setMultipleWorkspaces] = useState(false);
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
        /*
         * V3.3 #72 (`V33-DEC-020`). The dashboard reads the WORKSPACE LIST
         * rather than a singular summary.
         *
         * A seller may own both a professional profile and a business, each
         * with its own financial position, and there is no honest single
         * figure for such a caller -- picking one is exactly the silent choice
         * the decision forbids. So the tile below is shown only when the list
         * holds one workspace, and a dual owner is sent to the finance screen
         * where they can choose.
         *
         * A caller who owns nothing gets `[]` rather than a refusal, which is
         * not an error worth failing the whole dashboard over either.
         */
        financeWorkspaces(api).catch(() => ({ data: { items: [] as FinanceWorkspace[] } })),
      ]);
      setBookings(bookingRes.data ?? []);
      setServices(serviceRes.data ?? []);
      setSlots(slotRes.data ?? []);

      const workspaces = financeRes.data?.items ?? [];
      /*
       * Exactly one, or nothing. Never the first of several -- and, since
       * V3.3 #111/#154, never a `finance_read` grant either: this tile is the
       * OWNER's own dashboard figure, and a bookkeeper's one delegated
       * workspace is somebody else's money, not "your net receivable". A
       * finance-only grantee reads it at `/finance` instead.
       */
      if (workspaces.length === 1 && workspaces[0].accessMode === 'owner') {
        const summaryRes = await financeSummary(api, workspaces[0].workspaceRef).catch(() => ({
          data: null as FinanceSummary | null,
        }));
        setFinance(summaryRes.data ?? null);
      } else {
        setFinance(null);
      }
      setMultipleWorkspaces(workspaces.length > 1);
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
  /*
    Today's schedule as one timeline, from the two reads the page already
    makes. The design's data note calls it "derivable by combining the same
    two responses, with no new route" — and unlike two of its other claims,
    that one is true.

    Bookings and open slots are merged and sorted by start, so a free hour
    and a booked one read in the order the day happens rather than in two
    separate lists a seller has to interleave in their head.
  */
  const now = Date.now();
  const endOfDay = now + 24 * 3_600_000;
  const schedule = [
    ...today.map((booking) => ({ kind: 'booking' as const, at: booking.startAt, booking })),
    ...openSlots
      .filter((slot) => {
        const start = new Date(slot.startAt).getTime();
        return start >= now && start <= endOfDay;
      })
      .map((slot) => ({ kind: 'free' as const, at: slot.startAt, slot })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const weekSlots = openSlots.filter((slot) => {
    const start = new Date(slot.startAt).getTime();
    return start >= now && start <= now + 7 * 86_400_000;
  }).length;
  const weekBookings = bookings.filter((b) => {
    const start = new Date(b.startAt).getTime();
    return start >= now && start <= now + 7 * 86_400_000 && b.status === 'confirmed';
  }).length;
  const weekTotal = weekSlots + weekBookings;
  const weekPercent = weekTotal > 0 ? Math.round((weekBookings / weekTotal) * 100) : 0;

  return (
    <>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>امروز، {formatZonedFullDate(new Date())}</h1>
          <p className={styles.subtitle}>
            {toPersianDigits(today.length)} نوبت پیش‌رو
            {awaitingAction.length > 0 ? ` · ${toPersianDigits(awaitingAction.length)} نوبت در انتظار ثبت وضعیت` : ''}
          </p>
        </div>
        <Link href="/pro/availability" className={styles.headAction}>
          افزودن زمان آزاد
        </Link>
      </div>

      {loadError ? <ErrorState message={loadError} onRetry={() => void load()} /> : null}
      {loading && !loaded ? <LoadingState label="در حال بارگذاری نمای کلی…" /> : null}

      {/*
        The one banner on this surface. It is not a notice: until a finished
        booking's outcome is recorded the seller is not paid for it and the
        customer earns no points, so this is money sitting still.
      */}
      {loaded && awaitingAction.length > 0 ? (
        <div className={styles.blocker} data-testid="awaiting-action">
          <span className={styles.blockerDot} aria-hidden="true" />
          <div className={styles.flexMain}>
            <div className={styles.blockerTitle}>
              {toPersianDigits(awaitingAction.length)} نوبت گذشته منتظر ثبت وضعیت است
            </div>
            <div className={styles.blockerText}>
              تا وضعیت ثبت نشود، درآمد این نوبت‌ها به مالی شما و امتیاز به مشتری اضافه نمی‌شود.
            </div>
          </div>
          <Link href="/pro/bookings" className={styles.blockerAction}>
            ثبت وضعیت
          </Link>
        </div>
      ) : null}

      {loaded && remaining.length > 0 ? (
        <div className={styles.setup} data-testid="setup-checklist">
          <h2 className={styles.setupTitle}>تکمیل راه‌اندازی</h2>
          <p className={styles.subtitle}>
            تا این موارد کامل نشود، مشتری‌ها نمی‌توانند شما را پیدا کنند یا رزرو کنند.
          </p>
          <div className={styles.setupList}>
            {setupSteps.map((step) => (
              <div
                key={step.label}
                className={`${styles.setupStep} ${step.done ? styles.setupStepDone : ''}`}
                data-step-done={step.done ? 'true' : 'false'}
              >
                <Badge tone={step.done ? 'success' : 'warning'}>{step.done ? 'انجام شد' : 'باقی مانده'}</Badge>
                <span className={styles.flexMain}>{step.label}</span>
                {!step.done ? <TextLink href={step.href}>انجام بده</TextLink> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {loaded ? (
        <div className={styles.tiles} data-testid="pro-tiles">
          {/*
            The artboard's «درآمد این ماه» is a month-over-month comparison,
            and no route answers it: `FinanceSummary` is a position, not a
            series. The tile shows the net receivable it DOES have and no
            trend — an «۱۸٪ بیشتر» nobody computed is the worst kind of
            number to put on a seller's dashboard.
          */}
          <div className={styles.tile}>
            <div className={styles.tileLabel}>خالص قابل دریافت</div>
            {finance ? (
              <div className={styles.tileValueRow}>
                <span className={styles.tileValue}><PriceDisplay amount={finance.receivableNetToman} /></span>
                <span className={styles.tileUnit}>تومان</span>
              </div>
            ) : multipleWorkspaces ? (
              <>
                <div className={styles.tileNote}>چند فضای کاری دارید.</div>
                <div className={styles.tileNote}>
                  <TextLink href="/finance">انتخاب فضا در صفحهٔ مالی</TextLink>
                </div>
              </>
            ) : (
              <div className={styles.tileNote}>فضای مالی‌ای در دسترس نیست.</div>
            )}
          </div>

          <div className={styles.tile}>
            <div className={styles.tileLabel}>نوبت‌های این هفته</div>
            <div className={styles.tileValueRow}>
              <span className={styles.tileValue}>{toPersianDigits(weekBookings)}</span>
              <span className={styles.tileUnit}>از {toPersianDigits(weekTotal)} زمان</span>
            </div>
            {weekTotal > 0 ? (
              <div
                className={styles.tileBar}
                role="progressbar"
                aria-valuenow={weekPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="سهم زمان‌های رزروشده از کل زمان‌های این هفته"
              >
                <div className={styles.tileBarFill} style={{ width: `${weekPercent}%` }} />
              </div>
            ) : null}
          </div>

          <div className={styles.tile}>
            <div className={styles.tileLabel}>خدمات فعال</div>
            <div className={styles.tileValueRow}>
              <span className={styles.tileValue}>{toPersianDigits(services.length)}</span>
              <span className={styles.tileUnit}>خدمت</span>
            </div>
            <div className={styles.tileNote}>
              <TextLink href="/pro/services">مدیریت خدمات</TextLink>
            </div>
          </div>
        </div>
      ) : null}

      {loaded ? (
        <section>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>برنامه امروز</h2>
            <TextLink href="/pro/availability">دیدن هفته</TextLink>
          </div>
          <div className={styles.timeline} data-testid="today-timeline">
            {schedule.length === 0 ? (
              <p className={styles.empty}>برای امروز نه نوبتی ثبت شده و نه زمان آزادی باز است.</p>
            ) : (
              schedule.map((entry) => (
                <div
                  key={entry.kind === 'booking' ? entry.booking.id : entry.slot.id}
                  className={`${styles.row} ${entry.kind === 'booking' ? styles.rowBooked : ''}`}
                  data-entry={entry.kind}
                >
                  <div className={styles.hour}>{formatZonedTime(new Date(entry.at))}</div>
                  <div className={styles.cell}>
                    {entry.kind === 'free' ? (
                      <div className={styles.free}>
                        <span>آزاد</span>
                        {/*
                          The design draws «مسدود کردن». In the API that is
                          DELETING the slot, and a control whose word is
                          softer than its effect is the wrong word. Named for
                          what it does, and it lives where it is done.
                        */}
                        <TextLink href="/pro/availability">حذف این زمان</TextLink>
                      </div>
                    ) : (
                      <div className={styles.bookingRow}>
                        <div className={styles.minWidthMain}>
                          <div className={styles.bookingHead}>
                            <span className={styles.bookingName}>
                              {services.find((s) => s.id === entry.booking.serviceId)?.name ?? 'خدمت نامشخص'}
                            </span>
                            <span className={styles.statusChip}>تأیید شده</span>
                          </div>
                          <div className={styles.bookingCustomer}>
                            {entry.booking.customerDisplayName ?? 'نام مشتری ثبت نشده'}
                          </div>
                          <div className={styles.bookingMeta}>
                            {formatZonedTime(new Date(entry.booking.startAt))} تا{' '}
                            {formatZonedTime(new Date(entry.booking.endAt))}
                          </div>
                        </div>
                        <TextLink href="/pro/bookings">جزئیات</TextLink>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      ) : null}
    </>
  );
}
