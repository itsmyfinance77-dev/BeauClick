import type { AuthenticatedUser } from './auth-context';

/**
 * Whether a session belongs to a seller: the ONE place this question is asked.
 *
 * `professional` is granted in the same transaction as the profile row and
 * `/v1/me` resolves it from `identity.user_roles` on every load, so it answers
 * "does this person own a professional profile?" without another read and is
 * known the moment the session is (see the docblock on `AppShell`'s use of it).
 * The header's «حالت متخصص» entry and `SellerFrame` must agree, which is why
 * neither spells the role out. A business owner or finance-only staff member
 * without a professional profile is deliberately NOT a seller here.
 */
export function isSellerSession(user: Pick<AuthenticatedUser, 'roles'> | null | undefined): boolean {
  return user?.roles?.includes('professional') ?? false;
}
