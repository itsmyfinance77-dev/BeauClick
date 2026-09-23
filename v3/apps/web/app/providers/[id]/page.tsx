'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatFullJalaliDate, formatShortDate, formatToman, toPersianDigits } from '@beauclick/persian-utils';

import { useAuth } from '@/lib/auth-context';
import { Alert, Button, ErrorState, LoadingState } from '@/components/ui';
import {
  bookingApi,
  groupSlotsByDay,
  slotTimeLabel,
  type AvailableSlot,
  type CityRef,
  type PortfolioItem,
  type ProviderSummary,
  type ServiceOffering,
} from '@/lib/booking-api';
import { joinWaitlist } from '@/lib/phase4-api';
import { removeFromWishlist, saveToWishlist } from '@/lib/phase3-api';
import { saveFailureMessage } from '@/lib/wishlist-api';
import { ApiRequestError } from '@/lib/api-client';
import styles from './provider.module.css';

/**
 * The professional's profile and booking panel —
 * `Prototype - Customer.dc.html` §05 and §06, `02_PROVIDER_PROFILE.md`.
 *
 * Two things about the booking half are load-bearing rather than cosmetic,
 * and both are carried over unchanged:
 *
 * **No price is ever sent.** The customer sees the catalogue price, but the
 * confirm request carries only ids. The server prices the order from its own
 * catalogue, so what is charged cannot be influenced by anything the browser
 * holds.
 *
 * **One idempotency key per checkout attempt.** Generated when the customer
 * commits and reused for every retry of THAT attempt, so a double-tapped
 * confirm converges on one booking rather than claiming a second slot.
 *
 * ## Four fields the server always returned and no surface could use
 *
 * `ProviderSummary` in this app named six fields. The server's shape has
 * ten: `images` (avatar and cover), `rating` (average null until somebody
 * reviews), `saved`, and `createdAt`. There is also a public
 * `GET /v1/providers/:id/portfolio`. So the design's gallery, the join date
 * and both save controls are real data, not placeholders — and the page
 * renders a placeholder only where a picture genuinely does not exist.
 *
 * ## The city needed a second read
 *
 * The professional shape carries `cityId` and not a name. `GET
 * /v1/providers/cities` is public and small, so the name comes from there.
 * A page that shows a customer a raw uuid is showing them nothing.
 *
 * ## What the design shows and this does not
 *
 * «۴۸ نوبت انجام‌شده» twice — as a stat card and as a credibility card. The
 * design's data note calls it countable from the professional's completed
 * bookings, and no public route exposes that count. Neither card is rendered
 * with a guessed number; the credibility section keeps its other three.
 *
 * The reviews card IS rendered, as the dashed placeholder the design draws,
 * because the design is explicit that its place in the layout is held on
 * purpose so the page does not rearrange when reviews arrive.
 */

/** How many gallery tiles the desktop artboard holds: one large, two small. */
const GALLERY_TILES = 3;

export default function ProviderBookingPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { api, status } = useAuth();

  const professionalId = params.id;
  const [provider, setProvider] = useState<ProviderSummary | null>(null);
  const [services, setServices] = useState<ServiceOffering[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([]);
  const [cities, setCities] = useState<CityRef[]>([]);
  const [slots, setSlots] = useState<AvailableSlot[]>([]);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingTarget, setSavingTarget] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [waitlistState, setWaitlistState] = useState<'idle' | 'joining' | 'joined' | 'already'>('idle');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      /*
        Four reads in parallel. The portfolio and the city list are not
        allowed to fail the page: a profile with no pictures and a profile
        whose city cannot be named are both still a usable profile, and
        failing the whole screen for either would be a worse answer than
        rendering what did arrive.
      */
      const [providerRes, servicesRes, portfolioRes, citiesRes] = await Promise.all([
        bookingApi.getProvider(api, professionalId),
        bookingApi.listServices(api, professionalId),
        bookingApi.listPortfolio(api, professionalId).catch(() => null),
        bookingApi.listCities(api).catch(() => null),
      ]);
      setProvider(providerRes.data);
      setServices(servicesRes.data ?? []);
      setPortfolio(portfolioRes?.data ?? []);
      setCities(citiesRes?.data ?? []);
      /*
        The first service is pre-selected so the panel has a price and a
        list of times to show. That IS a choice made for the caller, so it
        is made VISIBLE: the chosen row carries a «انتخاب شد» chip and a
        2px border, and one tap changes it. `V33-DEC-020` forbids choosing
        silently, not choosing at all.
      */
      setSelectedServiceId((current) => current ?? servicesRes.data?.[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
    } finally {
      setLoading(false);
    }
  }, [api, professionalId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Availability is re-fetched whenever the chosen service changes: a slot
  // published for one service is not offerable for another, so showing a
  // stale list would offer times that always fail at confirm.
  useEffect(() => {
    let cancelled = false;
    bookingApi
      .listAvailability(api, professionalId, selectedServiceId)
      .then((res) => {
        if (cancelled) return;
        setSlots(res.data ?? []);
        setSelectedSlotId(null);
        setSelectedDayKey(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
      });
    return () => {
      cancelled = true;
    };
  }, [api, professionalId, selectedServiceId]);

  const days = useMemo(() => groupSlotsByDay(slots), [slots]);
  const selectedService = services.find((s) => s.id === selectedServiceId) ?? null;
  // The first day that actually has times, until the customer picks another.
  const activeDay = days.find((d) => d.dayKey === selectedDayKey) ?? days[0] ?? null;
  const selectedSlot = slots.find((s) => s.id === selectedSlotId) ?? null;
  const cityName = provider?.cityId ? (cities.find((c) => c.id === provider.cityId)?.name ?? null) : null;

  /** The gallery's pictures: real media first, placeholders for the rest. */
  const tiles = useMemo(() => {
    const withUrl = portfolio.filter((item) => item.media?.url);
    return Array.from({ length: GALLERY_TILES }, (_, i) => withUrl[i] ?? null);
  }, [portfolio]);

  async function toggleSaved(targetType: 'professional' | 'service', targetId: string, currentlySaved: boolean) {
    if (savingTarget) return;
    setSaveError(null);
    setSavingTarget(targetId);
    try {
      if (currentlySaved) await removeFromWishlist(api, targetType, targetId);
      else await saveToWishlist(api, targetType, targetId);
      if (targetType === 'professional') {
        setProvider((p) => (p ? { ...p, saved: !currentlySaved } : p));
      } else {
        setServices((list) => list.map((s) => (s.id === targetId ? { ...s, saved: !currentlySaved } : s)));
      }
    } catch (err) {
      // Left exactly as it was: a control must never claim a state the
      // server does not hold. The customer is told why, in the server's own
      // words when their list is full.
      setSaveError(saveFailureMessage(err));
    } finally {
      setSavingTarget(null);
    }
  }

  async function joinTheWaitlist() {
    if (status !== 'authenticated') {
      router.push('/auth');
      return;
    }
    setWaitlistState('joining');
    setError(null);
    try {
      await joinWaitlist(api, { professionalId, serviceId: selectedServiceId ?? undefined });
      setWaitlistState('joined');
    } catch (err) {
      // Already on the waitlist for this (professional, service) is a
      // normal, expected outcome -- shown as reassurance, not an error.
      if (err instanceof ApiRequestError && err.code === 'ALREADY_ON_WAITLIST') {
        setWaitlistState('already');
        return;
      }
      setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
      setWaitlistState('idle');
    }
  }

  async function confirm() {
    if (!selectedSlotId || !selectedServiceId) return;

    if (status !== 'authenticated') {
      router.push('/auth');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      // One key per attempt. crypto.randomUUID is available in every browser
      // this product targets; the fallback keeps a non-secure-context dev
      // environment working rather than silently sending no key at all.
      const idempotencyKey =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const res = await bookingApi.createBooking(
        api,
        { professionalId, slotId: selectedSlotId, serviceId: selectedServiceId },
        idempotencyKey,
      );

      const redirectUrl = res.data?.payment.redirectUrl;
      if (redirectUrl) {
        window.location.href = redirectUrl;
        return;
      }
      // A zero-total booking needs no gateway trip.
      router.push(`/checkout/result?status=succeeded&orderId=${res.data?.order.id ?? ''}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطایی رخ داد.');
      // The slot may have gone to somebody else while the customer was
      // deciding. Re-fetching gives them a live list rather than leaving a
      // stale, unbookable selection on screen.
      const refreshed = await bookingApi.listAvailability(api, professionalId, selectedServiceId).catch(() => null);
      if (refreshed) {
        setSlots(refreshed.data ?? []);
        setSelectedSlotId(null);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <LoadingState label="در حال بارگذاری…" />;
  if (!provider) return <ErrorState message={error ?? 'این متخصص یافت نشد.'} onRetry={() => void load()} />;

  const isVerified = provider.verificationStatus === 'verified';
  const savedProfessional = provider.saved;

  return (
    <section>
      <nav aria-label="مسیر" className={styles.breadcrumb}>
        <Link href="/">خانه</Link>
        <span aria-hidden="true">/</span>
        <Link href="/search">جست‌وجو</Link>
        <span aria-hidden="true">/</span>
        <span className={styles.breadcrumbCurrent}>{provider.displayName}</span>
      </nav>

      <div className={styles.gallery} data-testid="gallery">
        <div className={styles.galleryMain}>
          {tiles[0]?.media?.url ? (
            /* A media-pipeline URL, whose dimensions are the uploader's and
               not ours; `next/image` would need a configured remote pattern
               for a host that is deployment-dependent. */
            <img src={tiles[0].media.url} alt={tiles[0].caption ?? ''} className={styles.galleryImage} />
          ) : (
            <span className={styles.galleryLabel}>نمونه کار اصلی</span>
          )}
        </div>
        <div className={styles.gallerySide}>
          {[1, 2].map((index) => {
            const item = tiles[index];
            return (
              <div
                key={index}
                className={`${styles.galleryTile} ${index === 1 ? styles.galleryTileBronze : ''}`}
              >
                {item?.media?.url ? (
                  <img src={item.media.url} alt={item.caption ?? ''} className={styles.galleryImage} />
                ) : (
                  <span className={styles.galleryLabel}>نمونه کار</span>
                )}
                {/* Only offered when there are genuinely more than the tiles show. */}
                {index === 2 && portfolio.length > GALLERY_TILES ? (
                  <button type="button" className={`${styles.galleryMore} bc-tap`}>
                    دیدن همه {toPersianDigits(portfolio.length)} نمونه
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {saveError ? <Alert tone="error">{saveError}</Alert> : null}

      <div className={styles.columns}>
        <div className={styles.profile}>
          <div>
            <div className={styles.identity}>
              <h1 className={styles.name}>{provider.displayName}</h1>
              {isVerified ? (
                <span className={styles.verified}>
                  <span className={styles.verifiedDot} aria-hidden="true" />
                  هویت تأیید شده
                </span>
              ) : null}
              {savedProfessional === null ? (
                /* `null` is not "unsaved" — it means there is no caller to
                   answer for, so there is no state to render as pressed. */
                <Link
                  href="/auth"
                  className={`${styles.save} bc-tap`}
                  aria-label={`برای ذخیرهٔ ${provider.displayName} وارد شوید`}
                >
                  ذخیره در علاقه‌مندی‌ها
                </Link>
              ) : (
                <button
                  type="button"
                  className={`${styles.save} ${savedProfessional ? styles.saveOn : ''} bc-tap`}
                  aria-pressed={savedProfessional}
                  disabled={savingTarget === provider.id}
                  aria-label={
                    savedProfessional
                      ? `حذف ${provider.displayName} از علاقه‌مندی‌ها`
                      : `افزودن ${provider.displayName} به علاقه‌مندی‌ها`
                  }
                  onClick={() => void toggleSaved('professional', provider.id, savedProfessional)}
                >
                  {savedProfessional ? 'در علاقه‌مندی‌ها' : 'ذخیره در علاقه‌مندی‌ها'}
                </button>
              )}
            </div>
            <p className={styles.place}>
              {[cityName, provider.specialties.map((s) => s.name).join('، ')].filter(Boolean).join(' · ')}
            </p>
            {provider.bio ? <p className={styles.bio}>{provider.bio}</p> : null}
          </div>

          <div className={styles.stats}>
            <div className={styles.stat}>
              <div className={styles.statLabel}>عضو بیوکلیک از</div>
              <div className={styles.statValue}>{formatFullJalaliDate(new Date(provider.createdAt))}</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statLabel}>خدمات فعال</div>
              <div className={styles.statValue}>{toPersianDigits(services.length)} خدمت</div>
            </div>
          </div>

          <div>
            <h2 className={styles.sectionTitle}>خدمات و قیمت‌ها</h2>
            {services.length === 0 ? (
              <p className={styles.emptyPanel}>این متخصص هنوز خدمتی ثبت نکرده است.</p>
            ) : (
              <>
                <div className={styles.serviceList} data-testid="services">
                  {services.map((service) => {
                    const chosen = service.id === selectedServiceId;
                    const savedService = service.saved ?? null;
                    return (
                      <div
                        key={service.id}
                        className={`${styles.service} ${chosen ? styles.serviceChosen : ''}`}
                        data-service={service.id}
                        data-chosen={chosen ? 'true' : undefined}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedServiceId(service.id)}
                          aria-pressed={chosen}
                          className={styles.serviceSelectButton}
                        >
                          <span className={styles.serviceHead}>
                            <span className={styles.serviceName}>{service.name}</span>
                            {chosen ? <span className={styles.chosenChip}>انتخاب شد</span> : null}
                          </span>
                          <span className={`${styles.serviceMeta} ${styles.serviceMetaBlock}`}>
                            {toPersianDigits(service.durationMinutes)} دقیقه
                          </span>
                        </button>
                        <div className={styles.servicePrice}>
                          <div>
                            <div className={styles.priceValue}>{formatToman(service.priceToman)}</div>
                            <div className={styles.priceUnit}>تومان</div>
                          </div>
                          {savedService === null ? (
                            <Link
                              href="/auth"
                              className={`${styles.serviceSave} bc-tap`}
                              aria-label={`برای ذخیرهٔ ${service.name} وارد شوید`}
                            >
                              ذخیره
                            </Link>
                          ) : (
                            <button
                              type="button"
                              className={`${styles.serviceSave} ${savedService ? styles.serviceSaveOn : ''} bc-tap`}
                              aria-pressed={savedService}
                              disabled={savingTarget === service.id}
                              aria-label={
                                savedService ? `حذف ${service.name} از علاقه‌مندی‌ها` : `افزودن ${service.name} به علاقه‌مندی‌ها`
                              }
                              onClick={() => void toggleSaved('service', service.id, savedService)}
                            >
                              {savedService ? 'ذخیره‌شده' : 'ذخیره'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className={styles.note}>
                  ذخیرهٔ هر خدمت مستقل از ذخیرهٔ خودِ متخصص است و سطر جداگانه‌ای در فهرست علاقه‌مندی‌ها می‌سازد.
                </p>
              </>
            )}
          </div>

          <div className={styles.credibility}>
            <h2 className={styles.sectionTitle}>اعتبار این متخصص</h2>
            <div className={styles.credGrid}>
              {isVerified ? (
                <div className={styles.cred}>
                  <span className={styles.credDot} aria-hidden="true" />
                  <div>
                    <div className={styles.credTitle}>هویت بررسی شده</div>
                    <div className={styles.credText}>
                      مدارک هویتی و مجوز صنفی توسط تیم بیوکلیک تأیید شده است.
                    </div>
                  </div>
                </div>
              ) : null}
              <div className={styles.cred}>
                <span className={`${styles.credDot} ${styles.credDotPrimary}`} aria-hidden="true" />
                <div>
                  <div className={styles.credTitle}>پرداخت با پشتوانه</div>
                  <div className={styles.credText}>
                    مبلغ تا پس از انجام نوبت نزد پلتفرم می‌ماند و در صورت لغو بازگردانده می‌شود.
                  </div>
                </div>
              </div>
              {/*
                Kept as the design's dashed placeholder rather than dropped:
                the design holds this card's place in the layout on purpose,
                so the page does not rearrange when reviews arrive.
              */}
              <div className={`${styles.cred} ${styles.credPending}`} data-testid="reviews-placeholder">
                <span className={styles.credDot} aria-hidden="true" />
                <div>
                  <div className={styles.credTitle}>دیدگاه مشتریان</div>
                  <div className={styles.credText}>به‌زودی. جای این بخش در چیدمان از حالا نگه داشته شده است.</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <aside className={styles.panel} aria-label="رزرو نوبت">
          {selectedService ? (
            <div>
              <div className={styles.serviceMeta}>
                {selectedService.name} · {toPersianDigits(selectedService.durationMinutes)} دقیقه
              </div>
              <div className={styles.panelPrice}>
                <span className={styles.panelPriceValue}>{formatToman(selectedService.priceToman)}</span>
                <span className={styles.panelPriceUnit}>تومان</span>
              </div>
            </div>
          ) : (
            <p className={styles.emptyPanel}>برای دیدن زمان‌ها، یک خدمت انتخاب کنید.</p>
          )}

          <div className={styles.panelSection}>
            <div className={styles.panelSectionHead}>
              <div className={styles.panelSectionTitle}>زمان‌های آزاد</div>
            </div>

            {days.length === 0 ? (
              <div>
                <p className={`${styles.emptyPanel} ${styles.emptyPanelSpaced}`}>
                  در حال حاضر زمان آزادی برای رزرو وجود ندارد.
                </p>
                {waitlistState === 'joined' ? (
                  <Alert tone="success">
                    به لیست انتظار اضافه شدید. به محض آزاد شدن یک نوبت، به شما اطلاع می‌دهیم.
                  </Alert>
                ) : waitlistState === 'already' ? (
                  /* `info`, not `success`: nothing happened just now. */
                  <Alert tone="info">شما قبلاً در لیست انتظار این متخصص ثبت‌نام کرده‌اید.</Alert>
                ) : (
                  <Button variant="ghost" onClick={() => void joinTheWaitlist()} loading={waitlistState === 'joining'}>
                    عضویت در لیست انتظار
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div className={styles.dayStrip} data-testid="day-strip">
                  {days.slice(0, 4).map((day) => {
                    const chosen = activeDay?.dayKey === day.dayKey;
                    const parts = formatShortDate(day.date);
                    return (
                      <button
                        key={day.dayKey}
                        type="button"
                        className={`${styles.day} ${chosen ? styles.dayChosen : ''}`}
                        aria-pressed={chosen}
                        data-day={day.dayKey}
                        onClick={() => {
                          setSelectedDayKey(day.dayKey);
                          setSelectedSlotId(null);
                        }}
                      >
                        <span className={styles.dayWeekday}>{parts.weekday}</span>
                        <span className={styles.dayNumber}>{parts.day}</span>
                        {/* The count is a fact from the same response, not a promise. */}
                        <span className={styles.dayCount}>{toPersianDigits(day.slots.length)} زمان</span>
                      </button>
                    );
                  })}
                </div>

                <div className={styles.slotGrid} data-testid="slot-grid">
                  {(activeDay?.slots ?? []).map((slot) => {
                    const chosen = slot.id === selectedSlotId;
                    return (
                      <button
                        key={slot.id}
                        type="button"
                        className={`${styles.slot} ${chosen ? styles.slotChosen : ''}`}
                        aria-pressed={chosen}
                        data-slot={slot.id}
                        onClick={() => setSelectedSlotId(slot.id)}
                      >
                        {slotTimeLabel(slot.startAt)}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {selectedSlot ? (
            <div className={styles.summary} data-testid="booking-summary">
              <div className={styles.summaryRow}>
                <span className={styles.summaryLabel}>زمان انتخابی</span>
                <span className={styles.summaryValue}>
                  {formatFullJalaliDate(new Date(selectedSlot.startAt))}، {slotTimeLabel(selectedSlot.startAt)}
                </span>
              </div>
              <div className={styles.summaryRow}>
                <span className={styles.summaryLabel}>پایان تقریبی</span>
                {/* The server's own end instant, not a duration added here. */}
                <span className={styles.summaryValue}>{slotTimeLabel(selectedSlot.endAt)}</span>
              </div>
            </div>
          ) : null}

          {days.length > 0 ? (
            <>
              <button
                type="button"
                className={styles.confirm}
                disabled={!selectedSlotId || !selectedServiceId || submitting}
                onClick={() => void confirm()}
              >
                {submitting ? 'در حال ثبت…' : 'ادامه به پرداخت'}
              </button>
              <p className={styles.panelNote}>
                مبلغ نهایی را سرور محاسبه می‌کند. تا پرداخت نشود، زمان قطعی نیست.
              </p>
            </>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
