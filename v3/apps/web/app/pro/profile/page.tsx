'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, ErrorState, Input, LoadingState } from '@/components/ui';
import { PageHeader, Select, Textarea } from '@/components/pro-ui';
import { VerificationBadge } from '@/components/pro-shell';
import { useAuth } from '@/lib/auth-context';
import { useProProfile } from '@/lib/pro-context';
import {
  createProvider,
  listCities,
  listSpecialties,
  updateProvider,
  type ReferenceItem,
} from '@/lib/pro-api';
import { myVerification, submitVerification, type MyVerificationRequest } from '@/lib/admin-api';

/**
 * Create or edit the professional profile.
 *
 * This is the one screen in the group that must render when NO profile exists,
 * so it does not use `ProGuard` — it handles the four states itself, and the
 * distinction it must get right is the same one QA-06 got wrong on the journey
 * editor: **a failed load must never render an editable form pre-filled with
 * blanks**, because submitting it would send those blanks over data that still
 * exists. On this screen the consequence would be an overwritten display name
 * and a wiped bio and specialty list.
 */
export default function ProProfilePage() {
  const { api } = useAuth();
  const { state, profile, error: profileError, reload, setProfile } = useProProfile();

  const [cities, setCities] = useState<ReferenceItem[]>([]);
  const [specialties, setSpecialties] = useState<ReferenceItem[]>([]);
  // Reference data has its OWN loaded flag. An empty city list after a failed
  // reference fetch would render a picker with no options, which reads as
  // "there are no cities" -- the same false assertion, one layer down.
  const [refLoaded, setRefLoaded] = useState(false);
  const [refError, setRefError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [cityId, setCityId] = useState('');
  const [specialtyIds, setSpecialtyIds] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Verification is its own request lifecycle, separate from the profile's
  // fields. `null` after a successful load means "you have never submitted",
  // which is an answer; a failed load leaves it null too, so `verificationRead`
  // is what distinguishes them.
  const [verification, setVerification] = useState<MyVerificationRequest | null>(null);
  const [verificationRead, setVerificationRead] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [verificationError, setVerificationError] = useState<string | null>(null);

  const loadReference = useCallback(async () => {
    setRefError(null);
    try {
      const [cityRes, specialtyRes] = await Promise.all([listCities(api), listSpecialties(api)]);
      setCities(cityRes.data ?? []);
      setSpecialties(specialtyRes.data ?? []);
      setRefLoaded(true);
    } catch (err) {
      setRefError(err instanceof Error ? err.message : 'فهرست شهرها و تخصص‌ها بارگذاری نشد.');
    }
  }, [api]);

  useEffect(() => {
    void loadReference();
  }, [loadReference]);

  const loadVerification = useCallback(async () => {
    setVerificationError(null);
    try {
      const res = await myVerification(api);
      setVerification(res.data ?? null);
      setVerificationRead(true);
    } catch (err) {
      setVerificationError(err instanceof Error ? err.message : 'وضعیت درخواست احراز هویت خوانده نشد.');
    }
  }, [api]);

  useEffect(() => {
    if (state !== 'ready') return;
    void loadVerification();
  }, [state, loadVerification]);

  async function requestVerification() {
    setSubmitting(true);
    setVerificationError(null);
    try {
      const res = await submitVerification(api);
      setVerification(res.data ?? null);
      // The profile's own verificationStatus moved to `pending` server-side, so
      // the badge in the shell is now stale. Re-read rather than patch locally.
      await reload();
    } catch (err) {
      setVerificationError(err instanceof Error ? err.message : 'ارسال درخواست احراز هویت انجام نشد.');
    } finally {
      setSubmitting(false);
    }
  }

  // Seed the form from the profile ONLY once it has genuinely arrived. The
  // dependency is `state`, not `profile`, precisely so a null profile from a
  // FAILED load can never reach this effect.
  useEffect(() => {
    if (state !== 'ready' || !profile) return;
    setDisplayName(profile.displayName);
    setBio(profile.bio ?? '');
    setCityId(profile.cityId ?? '');
    setSpecialtyIds(profile.specialties.map((s) => s.id));
  }, [state, profile]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const payload = {
        displayName: displayName.trim(),
        bio: bio.trim(),
        // '' is not a UUID and the DTO would reject it. Omitting the key means
        // "no change" on PATCH and "no city" on POST, which is what an empty
        // picker actually means.
        ...(cityId ? { cityId } : {}),
        specialtyIds,
      };

      const res =
        state === 'ready' && profile
          ? await updateProvider(api, profile.id, payload)
          : await createProvider(api, payload);

      if (res.data) setProfile(res.data);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'ذخیره پروفایل انجام نشد.');
    } finally {
      setSaving(false);
    }
  }

  function toggleSpecialty(id: string) {
    setSpecialtyIds((current) =>
      current.includes(id) ? current.filter((s) => s !== id) : [...current, id],
    );
  }

  if (state === 'loading') return <LoadingState label="در حال بارگذاری پروفایل متخصص…" />;

  // FAILED load: no form, no "create" invitation, nothing that could be
  // submitted over data we cannot see. Only the truth and a retry.
  if (state === 'error') {
    return (
      <>
        <PageHeader title="پروفایل متخصص" />
        <ErrorState message={profileError ?? 'پروفایل متخصص بارگذاری نشد.'} onRetry={() => void reload()} />
      </>
    );
  }

  const isCreate = state === 'none';

  return (
    <>
      <PageHeader
        title={isCreate ? 'ساخت پروفایل متخصص' : 'پروفایل متخصص'}
        subtitle={
          isCreate
            ? 'برای ارائه خدمات و دریافت رزرو، ابتدا پروفایل خود را کامل کنید.'
            : 'این اطلاعات در نتایج جست‌وجو و صفحه عمومی شما نمایش داده می‌شود.'
        }
        action={profile ? <VerificationBadge status={profile.verificationStatus} /> : undefined}
      />

      {refError ? <ErrorState message={refError} onRetry={() => void loadReference()} /> : null}

      <Card>
        <form onSubmit={submit} noValidate>
          {saveError ? <Alert>{saveError}</Alert> : null}
          {saved ? <Alert tone="success">پروفایل ذخیره شد.</Alert> : null}

          <Input
            label="نام نمایشی"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            minLength={2}
            maxLength={120}
            hint="نامی که مشتری‌ها در جست‌وجو می‌بینند."
          />

          <Textarea
            label="درباره من"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={2000}
            hint="اختیاری. تخصص، سابقه و سبک کاری خود را کوتاه توضیح دهید."
          />

          <Select
            label="شهر"
            value={cityId}
            onChange={(e) => setCityId(e.target.value)}
            disabled={!refLoaded}
            hint={refLoaded ? undefined : 'در حال بارگذاری فهرست شهرها…'}
          >
            <option value="">انتخاب نشده</option>
            {cities.map((city) => (
              <option key={city.id} value={city.id}>
                {city.name}
              </option>
            ))}
          </Select>

          <fieldset style={{ border: 0, padding: 0, margin: '0 0 16px' }}>
            <legend style={{ fontWeight: 600, fontSize: 14, padding: 0, marginBlockEnd: 8 }}>تخصص‌ها</legend>
            {!refLoaded ? (
              <p style={{ fontSize: 13, color: 'var(--bc-color-ink-faint)', margin: 0 }}>
                در حال بارگذاری فهرست تخصص‌ها…
              </p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--bc-spacing-chip-gap)' }}>
                {specialties.map((specialty) => (
                  <label
                    key={specialty.id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      minHeight: 44,
                      padding: '0 12px',
                      borderRadius: 999,
                      border: `1px solid ${
                        specialtyIds.includes(specialty.id) ? 'var(--bc-color-primary)' : 'var(--bc-color-line)'
                      }`,
                      fontSize: 14,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={specialtyIds.includes(specialty.id)}
                      onChange={() => toggleSpecialty(specialty.id)}
                    />
                    {specialty.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <Button type="submit" loading={saving}>
            {isCreate ? 'ساخت پروفایل' : 'ذخیره تغییرات'}
          </Button>
        </form>
      </Card>

      {profile ? (
        <div style={{ marginBlockStart: 20 }}>
          <Card>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>احراز هویت</h2>
            <p style={{ fontSize: 13, color: 'var(--bc-color-ink-soft)', margin: '0 0 16px' }}>
              پروفایل‌های تأییدشده نشان «تأیید شده» می‌گیرند و در نتایج جست‌وجو بالاتر دیده می‌شوند.
            </p>

            {verificationError ? <ErrorState message={verificationError} onRetry={() => void loadVerification()} /> : null}

            {profile.verificationStatus === 'verified' ? (
              <p style={{ margin: 0, fontSize: 14 }}>پروفایل شما تأیید شده است.</p>
            ) : profile.verificationStatus === 'pending' ? (
              <p style={{ margin: 0, fontSize: 14 }}>
                درخواست شما در صف بررسی است. نتیجه از طریق همین صفحه اعلام می‌شود.
              </p>
            ) : profile.verificationStatus === 'suspended' || profile.verificationStatus === 'revoked' ? (
              <p style={{ margin: 0, fontSize: 14 }}>
                وضعیت پروفایل شما اجازه ارسال درخواست را نمی‌دهد. لطفاً با پشتیبانی تماس بگیرید.
              </p>
            ) : (
              <>
                {verificationRead && verification?.status === 'rejected' && verification.decisionReason ? (
                  <Alert>درخواست قبلی رد شد: «{verification.decisionReason}»</Alert>
                ) : null}
                <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>
                  در این نسخه بارگذاری مدرک ممکن نیست؛ بررسی بر اساس اطلاعات پروفایل شما انجام می‌شود.
                </p>
                <Button type="button" loading={submitting} onClick={() => void requestVerification()}>
                  ارسال درخواست احراز هویت
                </Button>
              </>
            )}
          </Card>
        </div>
      ) : null}

      {profile ? (
        <p style={{ fontSize: 12, color: 'var(--bc-color-ink-faint)', marginBlockStart: 16 }}>
          وضعیت تأیید توسط تیم بررسی پلتفرم تعیین می‌شود و از این صفحه قابل تغییر نیست.
        </p>
      ) : null}
    </>
  );
}
