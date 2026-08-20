'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatFullJalaliDate, formatToman, toPersianDigits } from '@beauclick/persian-utils';

import { useAuth } from '@/lib/auth-context';
import { Alert, Button, Card, LoadingState } from '@/components/ui';
import {
  bookingApi,
  groupSlotsByDay,
  slotTimeLabel,
  type AvailableSlot,
  type ProviderSummary,
  type ServiceOffering,
} from '@/lib/booking-api';

/**
 * The booking screen: choose a service, choose a time, confirm.
 *
 * Two things about it are load-bearing rather than cosmetic.
 *
 * **No price is ever sent.** The customer sees the catalogue price, but the
 * confirm request carries only ids. The server prices the order from its own
 * catalogue through the pricing engine, so what is charged cannot be
 * influenced by anything the browser holds.
 *
 * **One idempotency key per checkout attempt.** Generated when the customer
 * commits, and reused for every retry of THAT attempt (including the API
 * client's post-refresh retry). A double-tapped confirm button therefore
 * converges on one booking rather than claiming a second slot -- which is
 * exactly the failure a mobile customer on a flaky connection would
 * otherwise cause.
 */
export default function ProviderBookingPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { api, status } = useAuth();

  const professionalId = params.id;
  const [provider, setProvider] = useState<ProviderSummary | null>(null);
  const [services, setServices] = useState<ServiceOffering[]>([]);
  const [slots, setSlots] = useState<AvailableSlot[]>([]);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [providerRes, servicesRes] = await Promise.all([
        bookingApi.getProvider(api, professionalId),
        bookingApi.listServices(api, professionalId),
      ]);
      setProvider(providerRes.data);
      setServices(servicesRes.data ?? []);
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
  if (!provider) return <Alert tone="error">{error ?? 'این متخصص یافت نشد.'}</Alert>;

  return (
    <section style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
      <Card>
        <h1 style={{ fontSize: 24, marginBlockEnd: 4 }}>{provider.displayName}</h1>
        {provider.bio ? <p style={{ color: 'var(--bc-color-ink-soft)', margin: 0 }}>{provider.bio}</p> : null}
      </Card>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card>
        <h2 style={{ fontSize: 18, marginBlockEnd: 12 }}>انتخاب خدمت</h2>
        {services.length === 0 ? (
          <p style={{ color: 'var(--bc-color-ink-soft)' }}>این متخصص هنوز خدمتی ثبت نکرده است.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {services.map((service) => {
              const selected = service.id === selectedServiceId;
              return (
                <li key={service.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedServiceId(service.id)}
                    aria-pressed={selected}
                    style={{
                      font: 'inherit',
                      width: '100%',
                      minHeight: 44,
                      textAlign: 'start',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 12,
                      padding: '12px 14px',
                      borderRadius: 'var(--bc-radius-row)',
                      border: `1px solid ${selected ? 'var(--bc-color-primary)' : 'var(--bc-color-line)'}`,
                      background: selected ? 'var(--bc-color-primary-soft)' : 'transparent',
                      color: 'var(--bc-color-ink)',
                      cursor: 'pointer',
                    }}
                  >
                    <span>
                      {service.name}
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                        {toPersianDigits(service.durationMinutes)} دقیقه
                      </span>
                    </span>
                    <strong style={{ whiteSpace: 'nowrap' }}>{formatToman(service.priceToman)} تومان</strong>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <h2 style={{ fontSize: 18, marginBlockEnd: 12 }}>انتخاب زمان</h2>
        {days.length === 0 ? (
          <p style={{ color: 'var(--bc-color-ink-soft)' }}>در حال حاضر زمان آزادی برای رزرو وجود ندارد.</p>
        ) : (
          <div style={{ display: 'grid', gap: 20 }}>
            {days.map((day) => (
              <div key={day.dayKey}>
                <h3 style={{ fontSize: 14, fontWeight: 700, marginBlockEnd: 8, color: 'var(--bc-color-ink-soft)' }}>
                  {formatFullJalaliDate(day.date)}
                </h3>
                <ul
                  style={{
                    listStyle: 'none',
                    padding: 0,
                    margin: 0,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 'var(--bc-spacing-chip-gap)',
                  }}
                >
                  {day.slots.map((slot) => {
                    const selected = slot.id === selectedSlotId;
                    return (
                      <li key={slot.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedSlotId(slot.id)}
                          aria-pressed={selected}
                          style={{
                            font: 'inherit',
                            minHeight: 44,
                            minWidth: 76,
                            padding: '10px 14px',
                            borderRadius: 'var(--bc-radius-pill)',
                            border: `1px solid ${selected ? 'var(--bc-color-primary)' : 'var(--bc-color-line)'}`,
                            background: selected ? 'var(--bc-color-primary)' : 'transparent',
                            color: selected ? 'var(--bc-color-surface)' : 'var(--bc-color-ink)',
                            cursor: 'pointer',
                            // Times read left-to-right even in an RTL
                            // document, so "09:30" does not visually reverse.
                            direction: 'ltr',
                          }}
                        >
                          {toPersianDigits(slotTimeLabel(slot.startAt))}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <h2 style={{ fontSize: 18, marginBlockEnd: 12 }}>تأیید و پرداخت</h2>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', fontSize: 14, margin: 0 }}>
          <dt style={{ color: 'var(--bc-color-ink-faint)' }}>خدمت</dt>
          <dd style={{ margin: 0 }}>{selectedService?.name ?? '—'}</dd>
          <dt style={{ color: 'var(--bc-color-ink-faint)' }}>مبلغ</dt>
          <dd style={{ margin: 0 }}>
            {selectedService ? `${formatToman(selectedService.priceToman)} تومان` : '—'}
          </dd>
        </dl>
        <p style={{ fontSize: 12, color: 'var(--bc-color-ink-faint)', marginBlockStart: 12 }}>
          مبلغ نهایی توسط سرور محاسبه می‌شود و در صفحه‌ی رسید نمایش داده خواهد شد.
        </p>
        <div style={{ marginBlockStart: 16 }}>
          <Button onClick={() => void confirm()} loading={submitting} disabled={!selectedSlotId || !selectedServiceId}>
            {status === 'authenticated' ? 'رزرو و پرداخت' : 'ورود و ادامه'}
          </Button>
        </div>
      </Card>
    </section>
  );
}
