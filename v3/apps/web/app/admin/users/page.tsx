'use client';

import { useCallback, useEffect, useState } from 'react';
import { normalizeDigits, toPersianDigits } from '@beauclick/persian-utils';
import { Alert, Button, ErrorState, Input, LoadingState } from '@/components/ui';
import { Badge, ConfirmDialog, EmptyState, PageHeader, Textarea } from '@/components/kit';
import { useAuth } from '@/lib/auth-context';
import {
  findUserByPhone,
  mutateUserRole,
  roleCatalogue,
  type AdminRole,
  type AdminUserSummary,
} from '@/lib/admin-api';
import styles from './users.module.css';

/** The server requires 4–500 characters of reason. */
const MIN_REASON = 4;

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
  const [catalogueError, setCatalogueError] = useState<string | null>(null);

  const [pending, setPending] = useState<{ role: AdminRole; operation: 'grant' | 'revoke' } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const loadCatalogue = useCallback(async () => {
    setCatalogueError(null);
    try {
      const res = await roleCatalogue(api);
      setRoles(res.data?.roles ?? []);
      setCatalogueLoaded(true);
    } catch (err) {
      setCatalogueError(err instanceof Error ? err.message : 'فهرست نقش‌ها بارگذاری نشد.');
    }
  }, [api]);

  useEffect(() => {
    void loadCatalogue();
  }, [loadCatalogue]);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    const normalized = normalizeDigits(phone.trim());
    if (!normalized) {
      setError('شماره موبایل کاربر را وارد کنید.');
      return;
    }
    setSearching(true);
    setSearched(false);
    // Cleared BEFORE the request: the card is one account's, and if this search
    // fails the operator must not be left looking at the PREVIOUS account under
    // a field that now holds a different number.
    setResult(null);
    try {
      // Digits folded before the request: an operator typing a Persian-keyboard
      // number would otherwise get "no such user" for an account that exists.
      // Same root cause as QA-01/02, one surface later.
      const res = await findUserByPhone(api, normalized);
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
  const reasonLength = reason.trim().length;

  /** The catalogue's name for a role — never the raw slug, which is a database key an operator cannot read. */
  function roleName(slug: string): string {
    return roles.find((r) => r.slug === slug)?.name ?? (catalogueLoaded ? 'نقش ناشناخته' : 'نقش');
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="کاربران و نقش‌ها"
        subtitle="اعطا و لغو نقش. هر تغییر با نام شما و دلیل آن به‌صورت دائمی ثبت می‌شود."
      />

      {error ? <Alert>{error}</Alert> : null}
      {success ? <Alert tone="success">{success}</Alert> : null}

      <section className={styles.panel} aria-label="جست‌وجوی کاربر">
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
      </section>

      {searched && !result ? (
        <EmptyState message="کاربری با این شماره یافت نشد. کاربر باید ابتدا از مسیر عادی وارد شده باشد." />
      ) : null}

      {result ? (
        <section className={styles.panel} aria-label="حساب یافت‌شده">
          <div className={styles.head}>
            <div className={styles.who}>
              <p className={styles.name}>{result.displayName ?? 'بدون نام'}</p>
              <p className={styles.phone}>{toPersianDigits(result.phone)}</p>
            </div>
            <div className={styles.badges}>
              {result.roles.length === 0 ? (
                <Badge tone="neutral">بدون نقش</Badge>
              ) : (
                result.roles.map((r) => (
                  <Badge key={r} tone={roles.find((x) => x.slug === r)?.isPrivileged ? 'warning' : 'neutral'}>
                    {roleName(r)}
                  </Badge>
                ))
              )}
            </div>
          </div>

          {isSelf ? (
            <p className={styles.self}>این حساب خود شماست. اعطای نقش مدیریتی به حساب خودتان مجاز نیست.</p>
          ) : null}

          <div className={styles.roles}>
            <h2 className={styles.sectionTitle}>تغییر نقش</h2>
            {catalogueError ? (
              <ErrorState message={catalogueError} onRetry={() => void loadCatalogue()} />
            ) : !catalogueLoaded ? (
              <LoadingState label="در حال بارگذاری فهرست نقش‌ها…" lines={3} />
            ) : (
              <ul className={styles.roleList}>
                {roles.map((role) => {
                  const held = result.roles.includes(role.slug);
                  return (
                    <li key={role.slug} className={styles.role}>
                      <div className={styles.roleText}>
                        <p className={styles.roleName}>
                          {role.name}
                          {role.isPrivileged ? (
                            <span className={styles.privileged}>
                              <Badge tone="warning">مدیریتی</Badge>
                            </span>
                          ) : null}
                        </p>
                        <p className={styles.roleDescription}>{role.description}</p>
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
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        title={pending?.operation === 'grant' ? 'اعطای نقش' : 'لغو نقش'}
        tone={pending?.operation === 'grant' ? 'primary' : 'danger'}
        confirmLabel={pending?.operation === 'grant' ? 'اعطا کن' : 'لغو کن'}
        busy={busy}
        confirmDisabled={reasonLength < MIN_REASON}
        onConfirm={() => void confirm()}
        onCancel={() => {
          setPending(null);
          setReason('');
        }}
        body={
          <>
            <p className={styles.dialogText}>
              {pending?.operation === 'grant'
                ? `نقش «${pending?.role.name}» به این کاربر اعطا می‌شود.`
                : `نقش «${pending?.role.name}» از این کاربر گرفته می‌شود.`}
            </p>
            {pending?.role.isPrivileged ? (
              <p className={styles.dialogNote}>
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
            {reasonLength > 0 && reasonLength < MIN_REASON ? (
              <p className={styles.reasonError}>دلیل باید حداقل ۴ نویسه باشد.</p>
            ) : null}
          </>
        }
      />
    </div>
  );
}
