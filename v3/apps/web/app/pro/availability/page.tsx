'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  formatZonedFullDate,
  formatZonedTime,
  normalizeDigits,
  PERSIAN_WEEK_ORDER,
  PLATFORM_TIMEZONE,
  toPersianDigits,
  zonedDateTimeToInstant,
  zonedIsoDate,
} from '@beauclick/persian-utils';
import { Alert, Button, Card, ErrorState, Input, LoadingState } from '@/components/ui';
import { Badge, ConfirmDialog, EmptyState, PageHeader, Select } from '@/components/pro-ui';
import { ProGuard } from '@/components/pro-guard';
import { useAuth } from '@/lib/auth-context';
import {
  bulkGenerateSlots,
  createSlot,
  deleteSlot,
  listMyServices,
  listMySlots,
  type MyProviderProfile,
  type MySlot,
  type ServiceOffering,
} from '@/lib/pro-api';

export default function ProAvailabilityPage() {
  return <ProGuard>{(profile) => <Availability profile={profile} />}</ProGuard>;
}

const STATUS_LABELS: Record<MySlot['status'], string> = {
  open: 'آزاد',
  held: 'در حال رزرو',
  booked: 'رزرو شده',
  blocked: 'مسدود',
};

const STATUS_TONE = {
  open: 'success',
  held: 'warning',
  booked: 'primary',
  blocked: 'neutral',
} as const;

/**
 * Availability management.
 *
 * THE TIMEZONE RULE, stated once and applied everywhere below: this screen
 * speaks the PLATFORM timezone (`Asia/Tehran`), never the browser's.
 * `AvailabilityService.bulkGenerate` materializes slots from a local wall
 * clock in that zone, so a professional who publishes "۰۹:۰۰" means 09:00 in
 * Tehran regardless of where their laptop's clock is set. Reading a slot back
 * with `date.getHours()` -- which is what `formatTime` in `persian-utils` does
 * -- would silently show a different hour on a machine in any other zone, and
 * the professional would publish or release the wrong slots believing the UI.
 *
 * So every read goes through `formatZonedTime`/`formatZonedFullDate` and every
 * write goes through `zonedDateTimeToInstant`, all of which name the zone. The
 * conversion mirrors booking-service's own `platform-time.ts` (IANA rules via
 * `Intl`, two-pass offset resolution), so a future DST reversal in Iran is
 * handled on both sides rather than in neither.
 */
function Availability({ profile }: { profile: MyProviderProfile }) {
  const { api } = useAuth();

  const [slots, setSlots] = useState<MySlot[]>([]);
  const [services, setServices] = useState<ServiceOffering[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const today = useMemo(() => zonedIsoDate(new Date()), []);
  const inThirtyDays = useMemo(() => zonedIsoDate(new Date(Date.now() + 30 * 86_400_000)), []);

  // --- single slot form
  const [singleDate, setSingleDate] = useState(today);
  const [singleStart, setSingleStart] = useState('09:00');
  const [singleEnd, setSingleEnd] = useState('10:00');
  const [singleService, setSingleService] = useState('');
  const [singleBusy, setSingleBusy] = useState(false);
  const [singleError, setSingleError] = useState<string | null>(null);

  // --- bulk form
  const [bulkWeekdays, setBulkWeekdays] = useState<number[]>([]);
  const [bulkFrom, setBulkFrom] = useState(today);
  const [bulkTo, setBulkTo] = useState(inThirtyDays);
  const [bulkStart, setBulkStart] = useState('09:00');
  const [bulkEnd, setBulkEnd] = useState('17:00');
  const [bulkMinutes, setBulkMinutes] = useState('60');
  const [bulkService, setBulkService] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<{ created: number; skipped: number } | null>(null);

  const [pendingDelete, setPendingDelete] = useState<MySlot | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Services are needed for the "which service is this slot for" pickers.
      // A failure to load them is NOT a failure to load availability, so they
      // are tolerated independently rather than failing the whole screen.
      const [slotRes, serviceRes] = await Promise.all([
        listMySlots(api, { from: new Date().toISOString(), to: new Date(Date.now() + 60 * 86_400_000).toISOString() }),
        listMyServices(api, profile.id).catch(() => ({ data: [] as ServiceOffering[] })),
      ]);
      setSlots(slotRes.data ?? []);
      setServices(serviceRes.data ?? []);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'زمان‌های آزاد بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api, profile.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitSingle(event: React.FormEvent) {
    event.preventDefault();
    setSingleBusy(true);
    setSingleError(null);
    try {
      // Wall clock IN TEHRAN -> a real instant. Never `new Date('...')` on a
      // concatenated local string, which would be interpreted in the browser's
      // own zone.
      const startAt = zonedDateTimeToInstant(singleDate, singleStart, PLATFORM_TIMEZONE);
      const endAt = zonedDateTimeToInstant(singleDate, singleEnd, PLATFORM_TIMEZONE);
      await createSlot(api, {
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        ...(singleService ? { serviceId: singleService } : {}),
      });
      await load();
    } catch (err) {
      setSingleError(err instanceof Error ? err.message : 'ثبت زمان آزاد انجام نشد.');
    } finally {
      setSingleBusy(false);
    }
  }

  async function submitBulk(event: React.FormEvent) {
    event.preventDefault();
    setBulkBusy(true);
    setBulkError(null);
    setBulkResult(null);
    try {
      const res = await bulkGenerateSlots(api, {
        // These indices are the server's own 0=Sunday convention, carried
        // through the Saturday-first DISPLAY order rather than re-derived
        // from it -- reordering for a Persian week must not renumber the days.
        weekdays: bulkWeekdays,
        timeStart: bulkStart,
        timeEnd: bulkEnd,
        slotMinutes: Number(normalizeDigits(bulkMinutes).replace(/[^0-9]/g, '')),
        dateFrom: bulkFrom,
        dateTo: bulkTo,
        ...(bulkService ? { serviceId: bulkService } : {}),
      });
      setBulkResult(res.data ?? null);
      await load();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'ساخت گروهی زمان‌های آزاد انجام نشد.');
    } finally {
      setBulkBusy(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteSlot(api, pendingDelete.id);
      setSlots((current) => current.filter((s) => s.id !== pendingDelete.id));
      setPendingDelete(null);
    } catch (err) {
      setPendingDelete(null);
      setError(err instanceof Error ? err.message : 'حذف زمان آزاد انجام نشد.');
    } finally {
      setDeleting(false);
    }
  }

  function toggleWeekday(index: number) {
    setBulkWeekdays((current) =>
      current.includes(index) ? current.filter((d) => d !== index) : [...current, index],
    );
  }

  // Group by the platform-local day, not by the browser's -- otherwise a late
  // evening Tehran slot lands under the wrong date header for a viewer west
  // of Iran.
  const grouped = useMemo(() => {
    const map = new Map<string, MySlot[]>();
    for (const slot of slots) {
      const key = zonedIsoDate(new Date(slot.startAt));
      const list = map.get(key) ?? [];
      list.push(slot);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [slots]);

  const serviceName = useCallback(
    (id: string | null) => (id ? services.find((s) => s.id === id)?.name ?? null : null),
    [services],
  );

  return (
    <>
      <PageHeader
        title="زمان‌های آزاد"
        subtitle="ساعت‌هایی که مشتری می‌تواند رزرو کند. همه ساعت‌ها به وقت ایران است."
      />

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      <Card>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>ساخت گروهی</h2>
        <p style={{ fontSize: 13, color: 'var(--bc-color-ink-soft)', margin: '0 0 16px' }}>
          یک الگوی هفتگی را روی یک بازه تاریخی اعمال می‌کند. اجرای دوباره همان الگو، زمان‌های تکراری نمی‌سازد.
        </p>
        <form onSubmit={submitBulk} noValidate>
          {bulkError ? <Alert>{bulkError}</Alert> : null}
          {bulkResult ? (
            <Alert tone="success">
              {toPersianDigits(bulkResult.created)} زمان آزاد ساخته شد
              {bulkResult.skipped > 0 ? ` و ${toPersianDigits(bulkResult.skipped)} مورد تکراری نادیده گرفته شد` : ''}.
            </Alert>
          ) : null}

          <fieldset style={{ border: 0, padding: 0, margin: '0 0 16px' }}>
            <legend style={{ fontWeight: 600, fontSize: 14, padding: 0, marginBlockEnd: 8 }}>روزهای هفته</legend>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--bc-spacing-chip-gap)' }}>
              {PERSIAN_WEEK_ORDER.map((day) => (
                <label
                  key={day.index}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    minHeight: 44,
                    padding: '0 12px',
                    borderRadius: 999,
                    border: `1px solid ${
                      bulkWeekdays.includes(day.index) ? 'var(--bc-color-primary)' : 'var(--bc-color-line)'
                    }`,
                    fontSize: 14,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={bulkWeekdays.includes(day.index)}
                    onChange={() => toggleWeekday(day.index)}
                  />
                  {day.label}
                </label>
              ))}
            </div>
          </fieldset>

          <Input label="از تاریخ" type="date" value={bulkFrom} onChange={(e) => setBulkFrom(e.target.value)} required />
          <Input label="تا تاریخ" type="date" value={bulkTo} onChange={(e) => setBulkTo(e.target.value)} required />
          <Input label="از ساعت" type="time" value={bulkStart} onChange={(e) => setBulkStart(e.target.value)} required />
          <Input label="تا ساعت" type="time" value={bulkEnd} onChange={(e) => setBulkEnd(e.target.value)} required />
          <Input
            label="مدت هر نوبت (دقیقه)"
            value={bulkMinutes}
            onChange={(e) => setBulkMinutes(e.target.value)}
            inputMode="numeric"
            required
          />
          <Select label="خدمت" value={bulkService} onChange={(e) => setBulkService(e.target.value)} hint="اختیاری. اگر خالی بماند، برای همه خدمات قابل رزرو است.">
            <option value="">همه خدمات</option>
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </Select>

          <Button type="submit" loading={bulkBusy} disabled={bulkWeekdays.length === 0}>
            ساخت زمان‌های آزاد
          </Button>
        </form>
      </Card>

      <div style={{ marginBlockStart: 20 }}>
        <Card>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px' }}>افزودن یک زمان</h2>
          <form onSubmit={submitSingle} noValidate>
            {singleError ? <Alert>{singleError}</Alert> : null}
            <Input label="تاریخ" type="date" value={singleDate} onChange={(e) => setSingleDate(e.target.value)} required />
            <Input label="از ساعت" type="time" value={singleStart} onChange={(e) => setSingleStart(e.target.value)} required />
            <Input label="تا ساعت" type="time" value={singleEnd} onChange={(e) => setSingleEnd(e.target.value)} required />
            <Select label="خدمت" value={singleService} onChange={(e) => setSingleService(e.target.value)}>
              <option value="">همه خدمات</option>
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </Select>
            <Button type="submit" loading={singleBusy}>
              افزودن
            </Button>
          </form>
        </Card>
      </div>

      <div style={{ marginBlockStart: 20 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>زمان‌های ثبت‌شده</h2>
        {loading && !loaded ? (
          <LoadingState label="در حال بارگذاری زمان‌های آزاد…" />
        ) : loaded && slots.length === 0 ? (
          <EmptyState message="هنوز هیچ زمان آزادی ثبت نکرده‌اید. تا زمانی که زمان آزادی نداشته باشید، کسی نمی‌تواند شما را رزرو کند." />
        ) : (
          <div style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
            {grouped.map(([day, daySlots]) => (
              <Card key={day}>
                <p style={{ margin: '0 0 12px', fontWeight: 700, fontSize: 14 }}>
                  {formatZonedFullDate(new Date(daySlots[0].startAt))}
                </p>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                  {daySlots.map((slot) => {
                    const name = serviceName(slot.serviceId);
                    const releasable = slot.status === 'open';
                    return (
                      <li
                        key={slot.id}
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 'var(--bc-spacing-chip-gap)',
                          borderBlockEnd: '1px solid var(--bc-color-line)',
                          paddingBlockEnd: 8,
                        }}
                      >
                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <span style={{ fontSize: 14, fontWeight: 600 }}>
                            {formatZonedTime(new Date(slot.startAt))} تا {formatZonedTime(new Date(slot.endAt))}
                          </span>
                          <Badge tone={STATUS_TONE[slot.status]}>{STATUS_LABELS[slot.status]}</Badge>
                          {name ? (
                            <span style={{ fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>{name}</span>
                          ) : null}
                        </div>
                        {releasable ? (
                          <Button type="button" variant="danger" inline onClick={() => setPendingDelete(slot)}>
                            حذف
                          </Button>
                        ) : (
                          // Not a disabled button: a control that exists but
                          // never works is worse than an explanation. The
                          // server enforces this too -- deleteSlot only
                          // matches status='open' -- so this is guidance, not
                          // the guarantee.
                          <span style={{ fontSize: 12, color: 'var(--bc-color-ink-faint)' }}>
                            {slot.status === 'booked'
                              ? 'برای آزاد کردن، رزرو را لغو کنید'
                              : 'مشتری در حال تکمیل رزرو است'}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="حذف زمان آزاد"
        tone="danger"
        confirmLabel="حذف کن"
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
        body={
          pendingDelete ? (
            <p style={{ margin: 0 }}>
              زمان {formatZonedTime(new Date(pendingDelete.startAt))} تا{' '}
              {formatZonedTime(new Date(pendingDelete.endAt))} در{' '}
              {formatZonedFullDate(new Date(pendingDelete.startAt))} حذف می‌شود.
            </p>
          ) : null
        }
      />
    </>
  );
}
