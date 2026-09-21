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
import { Alert, Button, ErrorState, Input, LoadingState } from '@/components/ui';
import {
  Badge,
  CheckChip,
  CheckChipGroup,
  ConfirmDialog,
  EmptyState,
  FormFullRow,
  FormGrid,
  PageHeader,
  SegmentedControl,
  Select,
} from '@/components/kit';
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
import { slotStatusLabel, slotStatusTone } from '@/lib/slot-status';
import styles from './availability.module.css';

export default function ProAvailabilityPage() {
  return <ProGuard>{(profile) => <Availability profile={profile} />}</ProGuard>;
}

/**
 * How far ahead the slot list looks. 60 is the default the screen has always
 * used; the other two exist because bulk generation can reach past it.
 */
const HORIZON_OPTIONS = [
  { value: 30, label: '۳۰ روز' },
  { value: 60, label: '۶۰ روز' },
  { value: 120, label: '۱۲۰ روز' },
] as const;

type HorizonDays = (typeof HORIZON_OPTIONS)[number]['value'];

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

  // How far ahead the list looks, in platform-local days.
  //
  // The window was a hard-coded 60 days with no control and nothing saying so,
  // which quietly broke the screen's own most-used feature: bulk generation
  // happily accepts a 90-day range, and the slots past day 60 were then
  // invisible here -- a professional could publish availability, see no trace
  // of it, and publish it again.
  const [horizon, setHorizon] = useState<HorizonDays>(60);

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
        listMySlots(api, {
          from: new Date().toISOString(),
          to: new Date(Date.now() + horizon * 86_400_000).toISOString(),
        }),
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
  }, [api, profile.id, horizon]);

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

      <div className={styles.forms}>
        <div className={styles.panel}>
          <h2 className={styles.formTitle}>ساخت گروهی</h2>
          <p className={styles.formLead}>
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

            <fieldset className={styles.fieldset}>
              <legend className={styles.legend}>روزهای هفته</legend>
              <CheckChipGroup>
                {PERSIAN_WEEK_ORDER.map((day) => (
                  <CheckChip
                    key={day.index}
                    label={day.label}
                    checked={bulkWeekdays.includes(day.index)}
                    onChange={() => toggleWeekday(day.index)}
                  />
                ))}
              </CheckChipGroup>
            </fieldset>

            <FormGrid>
              <Input label="از تاریخ" type="date" value={bulkFrom} onChange={(e) => setBulkFrom(e.target.value)} required />
              <Input label="تا تاریخ" type="date" value={bulkTo} onChange={(e) => setBulkTo(e.target.value)} required />
              <Input label="از ساعت" type="time" value={bulkStart} onChange={(e) => setBulkStart(e.target.value)} required />
              <Input label="تا ساعت" type="time" value={bulkEnd} onChange={(e) => setBulkEnd(e.target.value)} required />
              <FormFullRow>
                <Input
                  label="مدت هر نوبت (دقیقه)"
                  value={bulkMinutes}
                  onChange={(e) => setBulkMinutes(e.target.value)}
                  inputMode="numeric"
                  required
                />
              </FormFullRow>
              <FormFullRow>
                <Select
                  label="خدمت"
                  value={bulkService}
                  onChange={(e) => setBulkService(e.target.value)}
                  hint="اختیاری. اگر خالی بماند، برای همه خدمات قابل رزرو است."
                >
                  <option value="">همه خدمات</option>
                  {services.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name}
                    </option>
                  ))}
                </Select>
              </FormFullRow>
            </FormGrid>

            <div className={styles.actions}>
              <Button type="submit" inline loading={bulkBusy} disabled={bulkWeekdays.length === 0}>
                ساخت زمان‌های آزاد
              </Button>
            </div>
          </form>
        </div>

        <div className={styles.panel}>
          <h2 className={styles.formTitleSpaced}>افزودن یک زمان</h2>
          <form onSubmit={submitSingle} noValidate>
            {singleError ? <Alert>{singleError}</Alert> : null}
            <FormGrid>
              <FormFullRow>
                <Input label="تاریخ" type="date" value={singleDate} onChange={(e) => setSingleDate(e.target.value)} required />
              </FormFullRow>
              <Input label="از ساعت" type="time" value={singleStart} onChange={(e) => setSingleStart(e.target.value)} required />
              <Input label="تا ساعت" type="time" value={singleEnd} onChange={(e) => setSingleEnd(e.target.value)} required />
              <FormFullRow>
                <Select label="خدمت" value={singleService} onChange={(e) => setSingleService(e.target.value)}>
                  <option value="">همه خدمات</option>
                  {services.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name}
                    </option>
                  ))}
                </Select>
              </FormFullRow>
            </FormGrid>
            <div className={styles.actions}>
              <Button type="submit" inline loading={singleBusy}>
                افزودن
              </Button>
            </div>
          </form>
        </div>
      </div>

      <div className={styles.registered}>
        <div className={styles.listHead}>
          <h2 className={styles.listTitle}>زمان‌های ثبت‌شده</h2>
          <SegmentedControl
            label="بازه نمایش"
            value={horizon}
            options={HORIZON_OPTIONS}
            onChange={setHorizon}
            disabled={loading}
          />
        </div>
        {loading && !loaded ? (
          <LoadingState label="در حال بارگذاری زمان‌های آزاد…" lines={5} />
        ) : loaded && slots.length === 0 ? (
          // The message names the WINDOW, because "you have no slots" and "you
          // have no slots in the next 30 days" are different facts and only the
          // second one is what was actually asked.
          <EmptyState
            message={`در ${toPersianDigits(horizon)} روز آینده زمان آزادی ثبت نکرده‌اید. تا زمانی که زمان آزادی نداشته باشید، کسی نمی‌تواند شما را رزرو کند.`}
          />
        ) : (
          <ul className={styles.days}>
            {grouped.map(([day, daySlots]) => (
              <li key={day} className={styles.panel} data-day={day}>
                <p className={styles.dayTitle}>{formatZonedFullDate(new Date(daySlots[0].startAt))}</p>
                <ul className={styles.slots}>
                  {daySlots.map((slot) => {
                    const name = serviceName(slot.serviceId);
                    const releasable = slot.status === 'open';
                    return (
                      <li key={slot.id} className={styles.slot} data-slot={slot.id}>
                        <div className={styles.slotMain}>
                          <span className={styles.time}>
                            {formatZonedTime(new Date(slot.startAt))} تا {formatZonedTime(new Date(slot.endAt))}
                          </span>
                          <Badge tone={slotStatusTone(slot.status)}>{slotStatusLabel(slot.status)}</Badge>
                          {name ? <span className={styles.serviceName}>{name}</span> : null}
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
                          <span className={styles.why}>
                            {slot.status === 'booked'
                              ? 'برای آزاد کردن، رزرو را لغو کنید'
                              : 'مشتری در حال تکمیل رزرو است'}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
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
            <p className={styles.dialogText}>
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
