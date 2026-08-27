'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatToman, normalizeDigits, toPersianDigits } from '@beauclick/persian-utils';
import { Alert, Button, Card, ErrorState, Input, LoadingState } from '@/components/ui';
import { ConfirmDialog, EmptyState, PageHeader } from '@/components/kit';
import { ProGuard } from '@/components/pro-guard';
import { useAuth } from '@/lib/auth-context';
import {
  createService,
  deleteService,
  listMyServices,
  updateService,
  type MyProviderProfile,
  type ServiceOffering,
} from '@/lib/pro-api';

export default function ProServicesPage() {
  return <ProGuard>{(profile) => <Services profile={profile} />}</ProGuard>;
}

const EMPTY_FORM = { name: '', durationMinutes: '', priceToman: '' };

function Services({ profile }: { profile: MyProviderProfile }) {
  const { api } = useAuth();
  const [services, setServices] = useState<ServiceOffering[]>([]);
  const [loading, setLoading] = useState(true);
  // Distinguishes "the server said you have no services" from "the request
  // failed". Only the first justifies an empty state.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ServiceOffering | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listMyServices(api, profile.id);
      setServices(res.data ?? []);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فهرست خدمات بارگذاری نشد.');
    } finally {
      setLoading(false);
    }
  }, [api, profile.id]);

  useEffect(() => {
    void load();
  }, [load]);

  function startEdit(service: ServiceOffering) {
    setEditingId(service.id);
    setForm({
      name: service.name,
      durationMinutes: String(service.durationMinutes),
      priceToman: String(service.priceToman),
    });
    setFormError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      // Digits are normalized before Number(): a professional typing on a
      // Persian keyboard produces '۶۰', which Number() turns into NaN and the
      // DTO rejects with a message that would look like a server bug. Same
      // root cause as QA-01/02, one layer earlier.
      const payload = {
        name: form.name.trim(),
        durationMinutes: Number(digitsOnly(form.durationMinutes)),
        priceToman: Number(digitsOnly(form.priceToman)),
      };

      if (editingId) {
        const res = await updateService(api, profile.id, editingId, payload);
        if (res.data) {
          const updated = res.data;
          setServices((current) => current.map((s) => (s.id === updated.id ? updated : s)));
        }
      } else {
        const res = await createService(api, profile.id, payload);
        if (res.data) setServices((current) => [...current, res.data as ServiceOffering]);
      }
      cancelEdit();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'ذخیره خدمت انجام نشد.');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteService(api, profile.id, pendingDelete.id);
      setServices((current) => current.filter((s) => s.id !== pendingDelete.id));
      if (editingId === pendingDelete.id) cancelEdit();
      setPendingDelete(null);
    } catch (err) {
      // The dialog closes and the error surfaces on the page: leaving a modal
      // open over an error the user cannot act on inside it is a trap.
      setPendingDelete(null);
      setError(err instanceof Error ? err.message : 'حذف خدمت انجام نشد.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="خدمات"
        subtitle="خدماتی که ارائه می‌دهید، مدت و قیمت هرکدام. این‌ها همان چیزی است که مشتری هنگام رزرو انتخاب می‌کند."
      />

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      <Card>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px' }}>
          {editingId ? 'ویرایش خدمت' : 'افزودن خدمت'}
        </h2>
        <form onSubmit={submit} noValidate>
          {formError ? <Alert>{formError}</Alert> : null}
          <Input
            label="نام خدمت"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            maxLength={120}
          />
          <Input
            label="مدت (دقیقه)"
            value={form.durationMinutes}
            onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
            inputMode="numeric"
            required
            hint="حداقل ۵ دقیقه."
          />
          <Input
            label="قیمت (تومان)"
            value={form.priceToman}
            onChange={(e) => setForm({ ...form, priceToman: e.target.value })}
            inputMode="numeric"
            required
          />
          <Button type="submit" loading={saving}>
            {editingId ? 'ذخیره تغییرات' : 'افزودن خدمت'}
          </Button>
          {editingId ? (
            <div style={{ marginBlockStart: 10 }}>
              <Button type="button" variant="ghost" onClick={cancelEdit} disabled={saving}>
                انصراف از ویرایش
              </Button>
            </div>
          ) : null}
        </form>
      </Card>

      <div style={{ marginBlockStart: 20 }}>
        {loading && !loaded ? (
          <LoadingState label="در حال بارگذاری خدمات…" />
        ) : loaded && services.length === 0 ? (
          <EmptyState message="هنوز هیچ خدمتی ثبت نکرده‌اید. با فرم بالا اولین خدمت خود را اضافه کنید." />
        ) : (
          <div style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
            {services.map((service) => (
              <Card key={service.id}>
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
                    <p style={{ margin: 0, fontWeight: 700 }}>{service.name}</p>
                    <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>
                      {toPersianDigits(service.durationMinutes)} دقیقه — {formatToman(service.priceToman)}
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Button type="button" variant="ghost" inline onClick={() => startEdit(service)}>
                      ویرایش
                    </Button>
                    <Button type="button" variant="danger" inline onClick={() => setPendingDelete(service)}>
                      حذف
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="حذف خدمت"
        tone="danger"
        confirmLabel="حذف کن"
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
        body={
          <>
            <p style={{ margin: '0 0 8px' }}>
              «{pendingDelete?.name}» از فهرست خدمات شما حذف می‌شود و دیگر قابل رزرو نخواهد بود.
            </p>
            <p style={{ margin: 0 }}>رزروهای گذشته و صورت‌حساب‌های ثبت‌شده تغییری نمی‌کنند.</p>
          </>
        }
      />
    </>
  );
}

/**
 * Fold Persian/Arabic-Indic digits to ASCII, then strip anything that is not a
 * digit, so `Number()` sees what the user meant.
 *
 * `normalizeDigits` is the codebase's ONE implementation of the folding and is
 * reused rather than re-derived -- writing a second one here is precisely how
 * QA-01/02 happened, where a validator and a canonicalizer disagreed about
 * which numeral systems existed. This wrapper adds only the non-digit strip,
 * which is a field-specific concern (a price is digits; a name is not).
 */
function digitsOnly(value: string): string {
  return normalizeDigits(value).replace(/[^0-9]/g, '');
}
