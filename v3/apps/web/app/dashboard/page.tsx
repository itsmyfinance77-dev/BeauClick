'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatFullJalaliDate, formatIranianPhone, toPersianDigits } from '@beauclick/persian-utils';
import { PriceDisplay } from '@/components/price-display';
import { useAuth } from '@/lib/auth-context';
import { ProtectedRoute } from '@/components/protected-route';
import { ErrorState, LoadingState } from '@/components/ui';
import { LoyaltyCard } from '@/components/loyalty-card';
import {
  bookingApi,
  isUpcomingBooking,
  slotTimeLabel,
  type BookingSummary,
  type CustomerBookingSummary,
  type ProviderSummary,
} from '@/lib/booking-api';
import {
  journeyGoals,
  journeyProfile,
  listNotifications,
  loyaltySummary,
  type BeautyGoal,
  type BeautyProfile,
  type LoyaltySummary,
  type NotificationItem,
} from '@/lib/phase3-api';
import styles from './dashboard.module.css';

/**
 * The customer's account page — `Prototype - Customer.dc.html` §07.
 *
 * ## Why this page changed shape entirely
 *
 * It was a 75-line proof that `GET /v1/me` worked end to end, written in
 * Phase 1 and never replaced. `V3_INFORMATION_ARCHITECTURE.md` §2 makes it
 * the level-two page that gathers "my history with this product" — bookings,
 * loyalty, the beauty journey, notifications — which is what let the header
 * drop from eleven destinations to three. The four separate pages keep
 * working and are linked from here; nothing was taken away.
 *
 * ## The professional's name is not on a booking
 *
 * `BookingSummary` carries `professionalId` and `serviceId` and no names, so
 * a booking row would read as two uuids. The names are resolved by reading
 * the professionals the visible bookings actually reference — a handful, not
 * a page — and each read is allowed to fail on its own. A row whose name
 * could not be resolved shows the service time and omits the name, rather
 * than showing an identifier or inventing a label.
 *
 * ## The amount on the upcoming card
 *
 * The design shows «پرداخت‌شده ۸۰۷٬۵۰۰». Since #225 the customer's own read of
 * a booking names the order it produced, so the figure is read from that order
 * — `collectedTotalToman`, the server's own record of what BeauClick actually
 * collected, never a sum computed here. One read, for the one booking the card
 * shows, and it is allowed to fail alone like the provider names are.
 *
 * Its LABEL carries «تومان» and the figure does not — the unit once per block
 * (`V3_DESIGN_SYSTEM.md` §«پول»), in the shape #287 settled on for a labelled
 * figure. The prototype draws the label bare; #287 landed after it.
 *
 * It is shown only when something WAS collected. An order that is still
 * pending, or one BeauClick collects nothing online for (`#41b`), reports zero,
 * and «پرداخت‌شده ۰ تومان» would assert a payment that did not happen. Saying
 * instead what is still owed would be a new line the design does not have.
 *
 * ## One thing the design shows that still has no data
 *
 * «عضویت از تیر ۱۴۰۴»: `/v1/me` has no `createdAt`. It is not guessed; it is
 * simply absent.
 */

interface MeResponse {
  id: string;
  phone: string;
  displayName: string | null;
  roles: string[];
  capabilities: string[];
}

/** How many past bookings the summary list shows before deferring to `/bookings`. */
const PAST_LIMIT = 3;

const STATUS_LABEL: Record<BookingSummary['status'], { label: string; tone: string }> = {
  pending: { label: 'در انتظار پرداخت', tone: 'statusWarn' },
  confirmed: { label: 'تأیید شده', tone: 'statusDone' },
  completed: { label: 'انجام شده', tone: 'statusDone' },
  cancelled: { label: 'لغو شده', tone: 'statusError' },
  expired: { label: 'منقضی شده', tone: 'statusNeutral' },
  no_show: { label: 'عدم مراجعه', tone: 'statusError' },
};

/**
 * The bookings this page will actually show, in the order it will show them.
 *
 * One function, used by BOTH the render and the name resolution, because
 * having two was a real defect: `load()` took the first upcoming booking in
 * ARRIVAL order to decide which professional to look up, while the render
 * took the earliest by TIME. Whenever the server returned them in any other
 * order, the upcoming card showed one appointment's date beside a different
 * appointment's salon.
 */
function visible<T extends BookingSummary>(bookings: T[]): { upcoming: T | null; past: T[] } {
  const upcoming = bookings.filter(isUpcomingBooking).sort((a, b) => a.startAt.localeCompare(b.startAt));
  const past = bookings.filter((b) => !isUpcomingBooking(b)).sort((a, b) => b.startAt.localeCompare(a.startAt));
  return { upcoming: upcoming[0] ?? null, past };
}

function DashboardContent() {
  const { api, logout } = useAuth();

  const [me, setMe] = useState<MeResponse | null>(null);
  const [bookings, setBookings] = useState<CustomerBookingSummary[]>([]);
  /** What the upcoming booking's order collected, or null when there is no order to read or the read failed. */
  const [collected, setCollected] = useState<number | null>(null);
  const [providers, setProviders] = useState<Map<string, ProviderSummary>>(new Map());
  const [loyalty, setLoyalty] = useState<LoyaltySummary | null>(null);
  const [notices, setNotices] = useState<NotificationItem[]>([]);
  const [goals, setGoals] = useState<BeautyGoal[]>([]);
  const [profile, setProfile] = useState<BeautyProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      /*
        `/v1/me` and the bookings are what the page is FOR, so a failure in
        either fails the page. Loyalty, notifications and the journey are
        sections of it: a dashboard missing its loyalty card is still a
        dashboard, and blanking the whole page for one of them would be a
        worse answer than rendering the rest.
      */
      const [meRes, bookingsRes, loyaltyRes, noticesRes, goalsRes, profileRes] = await Promise.all([
        api.get<MeResponse>('/v1/me'),
        bookingApi.myBookings(api),
        loyaltySummary(api).catch(() => null),
        listNotifications(api, 1).catch(() => null),
        journeyGoals(api).catch(() => null),
        journeyProfile(api).catch(() => null),
      ]);

      const mine = bookingsRes.data ?? [];
      setMe(meRes.data);
      setBookings(mine);
      setLoyalty(loyaltyRes?.data ?? null);
      setNotices(noticesRes?.data?.items ?? []);
      setGoals(goalsRes?.data ?? []);
      setProfile(profileRes?.data ?? null);

      /*
        One read per DISTINCT professional the visible bookings reference,
        and never one per row: the same salon appearing four times is one
        request. Each is allowed to fail alone — a missing name is a missing
        name, not a broken page.

        `visible()` decides which bookings those are, and the render calls
        the same function: two orderings here is how a card ends up showing
        one appointment's time beside another one's salon.
      */
      const shape = visible(mine);
      const shown = [...(shape.upcoming ? [shape.upcoming] : []), ...shape.past.slice(0, PAST_LIMIT)];
      const ids = [...new Set(shown.map((b) => b.professionalId))];
      const upcomingOrderId = shape.upcoming?.orderId ?? null;
      const [resolved, order] = await Promise.all([
        Promise.all(ids.map((id) => bookingApi.getProvider(api, id).then((r) => r.data).catch(() => null))),
        /*
          Only the booking the card shows, and only when it produced an order.
          A booking with no order asks nothing, and a failed read leaves the
          line off rather than failing the page.
        */
        upcomingOrderId === null
          ? Promise.resolve(null)
          : bookingApi.getOrder(api, upcomingOrderId).then((r) => r.data).catch(() => null),
      ]);
      setProviders(new Map(resolved.filter((p): p is ProviderSummary => p !== null).map((p) => [p.id, p])));
      setCollected(order?.collectedTotalToman ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!loaded) return <LoadingState label="در حال بارگذاری…" />;
  if (error && !me) return <ErrorState message={error} onRetry={() => void load()} />;

  const { upcoming, past } = visible(bookings);
  const unread = notices.filter((n) => !n.read).length;
  const activeGoals = goals.filter((g) => g.status !== 'abandoned');

  /** The professional's display name, or null when the read did not resolve. */
  const nameOf = (booking: BookingSummary) => providers.get(booking.professionalId)?.displayName ?? null;

  return (
    <section>
      <div className={styles.head}>
        <div>
          <h1 className={styles.greeting}>
            {me?.displayName ? `سلام ${me.displayName}` : 'حساب من'}
          </h1>
          <p className={styles.subtitle}>
            {upcoming
              ? 'یک نوبت پیش‌رو دارید.'
              : 'نوبت پیش‌رویی ندارید.'}
            {loyalty?.pointsToNextTier && loyalty.nextTier
              ? ` ${toPersianDigits(loyalty.pointsToNextTier)} امتیاز تا ${loyalty.nextTier.name}.`
              : ''}
          </p>
        </div>
        <Link href="/search" className={styles.headAction}>
          رزرو نوبت تازه
        </Link>
      </div>

      <div className={styles.columns}>
        <div className={styles.main}>
          <section>
            <h2 className={`${styles.sectionTitle} ${styles.sectionTitleSpaced}`}>نوبت پیش‌رو</h2>
            {upcoming ? (
              <div className={styles.next} data-testid="upcoming-booking">
                <div className={styles.nextBar}>
                  <span className={styles.nextWhen}>
                    {formatFullJalaliDate(new Date(upcoming.startAt))}، {slotTimeLabel(upcoming.startAt)}
                  </span>
                  <span className={styles.nextStatus}>{STATUS_LABEL[upcoming.status].label}</span>
                </div>
                <div className={styles.nextBody}>
                  <span className={styles.thumb} aria-hidden="true" />
                  <div className={styles.nextMain}>
                    <div className={styles.nextTitle}>{nameOf(upcoming) ?? 'نوبت شما'}</div>
                    <div className={styles.nextTime}>
                      {slotTimeLabel(upcoming.startAt)} تا {slotTimeLabel(upcoming.endAt)}
                    </div>
                  </div>
                  {/*
                    The label carries the unit and the figure does not — the unit
                    once per block (`V3_DESIGN_SYSTEM.md` §«پول»), in the shape
                    #287 settled for a labelled figure (`StatCard`'s «فروش ناخالص
                    (تومان)»). Absent entirely when nothing was collected.
                  */}
                  {collected !== null && collected > 0 ? (
                    <div className={styles.nextPaid} data-testid="upcoming-paid">
                      <div className={styles.nextPaidLabel}>پرداخت‌شده (تومان)</div>
                      <div className={styles.nextPaidValue}>
                        <PriceDisplay amount={collected} />
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className={styles.nextActions}>
                  <Link href="/bookings" className={styles.action}>
                    جزئیات و رسید
                  </Link>
                  <Link href="/bookings" className={`${styles.action} ${styles.actionDanger}`}>
                    مدیریت رزرو
                  </Link>
                </div>
              </div>
            ) : (
              <p className={styles.empty}>
                هنوز نوبتی رزرو نکرده‌اید. از <Link href="/search">جست‌وجو</Link> شروع کنید.
              </p>
            )}
          </section>

          <section>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>نوبت‌های گذشته</h2>
              {past.length > 0 ? (
                <Link href="/bookings" className={styles.sectionLink}>
                  همه ({toPersianDigits(past.length)})
                </Link>
              ) : null}
            </div>
            {past.length === 0 ? (
              <p className={styles.empty}>نوبت گذشته‌ای ندارید.</p>
            ) : (
              <div className={styles.pastList} data-testid="past-bookings">
                {past.slice(0, PAST_LIMIT).map((booking, index) => {
                  const status = STATUS_LABEL[booking.status];
                  const name = nameOf(booking);
                  return (
                    <div key={booking.id} className={styles.pastRow} data-booking={booking.id}>
                      <span
                        className={`${styles.pastThumb} ${index % 2 === 1 ? styles.pastThumbBronze : ''}`}
                        aria-hidden="true"
                      />
                      <div className={styles.pastBody}>
                        {name ? <div className={styles.pastTitle}>{name}</div> : null}
                        <div className={styles.pastWhen}>
                          {formatFullJalaliDate(new Date(booking.startAt))}، {slotTimeLabel(booking.startAt)}
                        </div>
                      </div>
                      <span className={`${styles.status} ${styles[status.tone]}`}>{status.label}</span>
                      <Link href={`/providers/${booking.professionalId}`} className={styles.rebook}>
                        رزرو دوباره
                      </Link>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {activeGoals.length > 0 || profile ? (
            <section>
              <div className={styles.sectionHead}>
                <h2 className={styles.sectionTitle}>مسیر زیبایی من</h2>
                <Link href="/journey" className={styles.sectionLink}>
                  ویرایش
                </Link>
              </div>
              <div className={styles.journey} data-testid="journey">
                <div>
                  <div className={styles.journeyTitle}>اهداف فعال</div>
                  {activeGoals.length === 0 ? (
                    <p className={styles.empty}>هدفی ثبت نشده است.</p>
                  ) : (
                    activeGoals.slice(0, 4).map((goal) => (
                      <div
                        key={goal.id}
                        className={`${styles.goal} ${goal.status === 'achieved' ? styles.goalDone : ''}`}
                      >
                        {goal.title}
                      </div>
                    ))
                  )}
                </div>
                <div>
                  <div className={styles.journeyTitle}>ترجیح‌های من</div>
                  {profile?.budgetMaxToman === null && profile?.notes === null ? (
                    <p className={styles.empty}>ترجیحی ثبت نشده است.</p>
                  ) : (
                    <dl className={styles.prefs}>
                      {profile?.budgetMaxToman !== null && profile?.budgetMaxToman !== undefined ? (
                        <>
                          <dt>حداکثر بودجه</dt>
                          <dd><PriceDisplay amount={profile.budgetMaxToman} /> تومان</dd>
                        </>
                      ) : null}
                      {profile?.notes ? (
                        <>
                          <dt>یادداشت</dt>
                          <dd>{profile.notes}</dd>
                        </>
                      ) : null}
                    </dl>
                  )}
                </div>
              </div>
            </section>
          ) : null}
        </div>

        <aside className={styles.sidebar}>
          {loyalty ? <LoyaltyCard summary={loyalty} /> : null}

          <div className={styles.card}>
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle}>اعلان‌ها</h2>
              {unread > 0 ? <span className={styles.unreadCount}>{toPersianDigits(unread)}</span> : null}
            </div>
            {notices.length === 0 ? (
              <p className={styles.empty}>اعلانی ندارید.</p>
            ) : (
              <div data-testid="notifications">
                {notices.slice(0, 3).map((notice) => (
                  <Link key={notice.id} href="/notifications" className={styles.notice}>
                    <span
                      className={`${styles.noticeDot} ${notice.read ? styles.noticeDotRead : ''}`}
                      aria-hidden="true"
                    />
                    <span>
                      <span className={styles.noticeText}>{notice.title}</span>
                      <span className={styles.noticeWhen}>{formatFullJalaliDate(new Date(notice.createdAt))}</span>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className={styles.card}>
            <h2 className={`${styles.cardTitle} ${styles.cardTitleSpaced}`}>حساب من</h2>
            <dl className={styles.prefs}>
              <dt>شماره موبایل</dt>
              <dd className={styles.ltr}>{formatIranianPhone(me?.phone ?? '')}</dd>
            </dl>
            <div className={styles.accountList}>
              <Link href="/waitlist" className={styles.accountLink}>
                لیست انتظار من
              </Link>
              <Link href="/pro" className={styles.accountLink}>
                ثبت‌نام به‌عنوان متخصص
              </Link>
              <button
                type="button"
                className={`${styles.accountLink} ${styles.accountLinkDanger}`}
                onClick={() => void logout()}
              >
                خروج از حساب
              </button>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

export default function DashboardPage() {
  return (
    <ProtectedRoute>
      <DashboardContent />
    </ProtectedRoute>
  );
}
