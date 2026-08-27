'use client';

import { useCallback, useEffect, useState } from 'react';
import { normalizeDigits, toPersianDigits } from '@beauclick/persian-utils';
import { Alert, Button, Card, Input, LoadingState } from '@/components/ui';
import { Badge, ConfirmDialog, EmptyState, PageHeader, Textarea } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import {
  findUserByPhone,
  mutateUserRole,
  roleCatalogue,
  type AdminRole,
  type AdminUserSummary,
} from '@/lib/admin-api';

/**
 * Role administration.
 *
 * The escalation rules are enforced entirely server-side (`RoleService`), and
 * this screen deliberately does not re-implement them: a frontend that decided
 * for itself which roles are grantable would be a second authorization system
 * that can disagree with the first. What it does instead is EXPLAIN a refusal
 * when one comes back, because "دسترسی ندارید" with no reason is where an
 * operator gets stuck.
 */
export default function AdminUsersPage() {
  const { api, user: me } = useAuth();

  const [phone, setPhone] = useState('');
  const [result, setResult] = useState<AdminUserSummary | null>(null);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [catalogueLoaded, setCatalogueLoaded] = useState(false);

  const [pending, setPending] = useState<{ role: AdminRole; operation: 'grant' | 'revoke' } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const loadCatalogue = useCallback(async () => {
    try {
      const res = await roleCatalogue(api);
      setRoles(res.data?.roles ?? []);
      setCatalogueLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فهرست نقش‌ها بارگذاری نشد.');
    }
  }, [api]);

  useEffect(() => {
    void loadCatalogue();
  }, [loadCatalogue]);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setSearching(true);
    setError(null);
    setSuccess(null);
    setSearched(false);
    try {
      // Digits folded before the request: an operator typing a Persian-keyboard
      // number would otherwise get "no such user" for an account that exists.
      // Same root cause as QA-01/02, one surface later.
      const res = await findUserByPhone(api, normalizeDigits(phone.trim()));
      setResult(res.data?.[0] ?? null);
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'جست‌وجوی کاربر انجام نشد.');
    } finally {
      setSearching(false);
    }
  }

  async function confirm() {
    if (!pending || !result) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await mutateUserRole(api, result.id, {
        roleSlug: pending.role.slug,
        operation: pending.operation,
        reason: reason.trim(),
      });
      setResult({ ...result, roles: res.data?.roles ?? result.roles });
      setSuccess(
        pending.operation === 'grant'
          ? `نقش «${pending.role.name}» اعطا شد.`
          : `نقش «${pending.role.name}» لغو شد.`,
      );
      setPending(null);
      setReason('');
    } catch (err) {
      setPending(null);
      setError(err instanceof Error ? err.message : 'تغییر نقش انجام نشد.');
    } finally {
      setBusy(false);
    }
  }

  const isSelf = result?.id === me?.id;

  return (
    <>
      <PageHeader
        title="کاربران و نقش‌ها"
        subtitle="اعطا و لغو نقش. هر تغییر با نام شما و دلیل آن به‌صورت دائمی ثبت می‌شود."
      />

      {error ? <Alert>{error}</Alert> : null}
      {success ? <Alert tone="success">{success}</Alert> : null}

      <Card>
        <form onSubmit={search} noValidate>
          <Input
            label="شماره موبایل کاربر"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="numeric"
            required
            // Exact match is the server's own rule, and worth stating: an
            // operator who expects a directory should learn here that there
            // isn't one, rather than concluding the account does not exist.
            hint="جست‌وجو فقط با شماره کامل و دقیق انجام می‌شود."
          />
          <Button type="submit" loading={searching}>
            جست‌وجو
          </Button>
        </form>
      </Card>

      <div style={{ marginBlockStart: 20 }}>
        {searched && !result ? (
          <EmptyState message="کاربری با این شماره یافت نشد. کاربر باید ابتدا از مسیر عادی وارد شده باشد." />
        ) : null}

        {result ? (
          <Card>
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
                <p style={{ margin: 0, fontWeight: 700 }}>{result.displayName ?? 'بدون نام'}</p>
                <p
                  style={{
                    margin: '4px 0 0',
                    fontSize: 13,
                    color: 'var(--bc-color-ink-soft)',
                    direction: 'ltr',
                    textAlign: 'start',
                  }}
                >
                  {toPersianDigits(result.phone)}
                </p>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {result.roles.length === 0 ? (
                  <Badge tone="neutral">بدون نقش</Badge>
                ) : (
                  result.roles.map((r) => (
                    <Badge key={r} tone={roles.find((x) => x.slug === r)?.isPrivileged ? 'warning' : 'neutral'}>
                      {roles.find((x) => x.slug === r)?.name ?? r}
                    </Badge>
                  ))
                )}
              </div>
            </div>

            {isSelf ? (
              <p style={{ margin: '16px 0 0', fontSize: 13, color: 'var(--bc-color-ink-faint)' }}>
                این حساب خود شماست. اعطای نقش مدیریتی به حساب خودتان مجاز نیست.
              </p>
            ) : null}

            <div style={{ marginBlockStart: 20 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>تغییر نقش</h2>
              {!catalogueLoaded ? (
                <LoadingState label="در حال بارگذاری فهرست نقش‌ها…" />
              ) : (
                <div style={{ display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
                  {roles.map((role) => {
                    const held = result.roles.includes(role.slug);
                    return (
                      <div
                        key={role.slug}
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 'var(--bc-spacing-chip-gap)',
                          borderBlockEnd: '1px solid var(--bc-color-line)',
                          paddingBlockEnd: 12,
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>
                            {role.name}
                            {role.isPrivileged ? (
                              <span style={{ marginInlineStart: 8 }}>
                                <Badge tone="warning">مدیریتی</Badge>
                              </span>
                            ) : null}
                          </p>
                          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--bc-color-ink-soft)' }}>
                            {role.description}
                          </p>
                        </div>
                        <Button
                          type="button"
                          inline
                          variant={held ? 'danger' : 'ghost'}
                          disabled={isSelf && role.isPrivileged}
                          onClick={() => setPending({ role, operation: held ? 'revoke' : 'grant' })}
                        >
                          {held ? 'لغو' : 'اعطا'}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>
        ) : null}
      </div>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.operation === 'grant' ? 'اعطای نقش' : 'لغو نقش'}
        tone={pending?.operation === 'grant' ? 'primary' : 'danger'}
        confirmLabel={pending?.operation === 'grant' ? 'اعطا کن' : 'لغو کن'}
        busy={busy}
        onConfirm={() => void confirm()}
        onCancel={() => {
          setPending(null);
          setReason('');
        }}
        body={
          <>
            <p style={{ margin: '0 0 12px' }}>
              {pending?.operation === 'grant'
                ? `نقش «${pending?.role.name}» به این کاربر اعطا می‌شود.`
                : `نقش «${pending?.role.name}» از این کاربر گرفته می‌شود.`}
            </p>
            {pending?.role.isPrivileged ? (
              <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--bc-color-ink-soft)' }}>
                {pending.operation === 'grant'
                  ? 'این یک نقش مدیریتی است. کاربر پس از ورود مجدد به دسترسی‌های آن خواهد رسید.'
                  : 'دسترسی‌های مدیریتی بلافاصله لغو می‌شود، حتی اگر کاربر هنوز نشست باز داشته باشد.'}
              </p>
            ) : null}
            <Textarea
              label="دلیل"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              hint="این متن به‌صورت دائمی در گزارش عملیات ثبت می‌شود."
            />
            {reason.trim().length > 0 && reason.trim().length < 4 ? (
              <p style={{ fontSize: 12, color: 'var(--bc-color-error)', margin: 0 }}>
                دلیل باید حداقل ۴ نویسه باشد.
              </p>
            ) : null}
          </>
        }
      />
    </>
  );
}
