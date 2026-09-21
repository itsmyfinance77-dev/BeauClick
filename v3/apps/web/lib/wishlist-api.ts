import type { WishlistPageView } from '@beauclick/wishlist-contract';
import { ApiRequestError, type ApiClient } from './api-client';

/**
 * The saved list and how a refused save is read.
 *
 * Saving and removing live in `phase3-api.ts` (`saveToWishlist`,
 * `removeFromWishlist`); this adds the list read, and the one classification the
 * entry points and the list share. Types come from `@beauclick/wishlist-contract`,
 * the one definition the server and this page hold in common.
 */

/** The caller's own saved items, newest first. `cursor` is opaque: pass back exactly what the last page returned. */
export function wishlistItems(api: ApiClient, cursor?: string | null) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return api.get<WishlistPageView>(`/v1/me/wishlist/items${query}`);
}

/**
 * Why a save was refused, as far as the customer may be told.
 *
 * `limit_reached` is a fact about the caller's OWN list (it is full) and the
 * only refusal they can act on, so the server names it. Everything else about a
 * target — deleted, suspended, revoked, never existed — collapses into
 * `target_unavailable` on the server on purpose, and the page must not try to
 * tell them apart. Anything that is neither is an ordinary failure.
 */
export type SaveFailure = 'limit_reached' | 'target_unavailable' | 'failed';

export function classifySaveFailure(error: unknown): SaveFailure {
  if (!(error instanceof ApiRequestError)) return 'failed';
  if (error.status === 409 && error.code === 'WISHLIST_LIMIT_REACHED') return 'limit_reached';
  if (error.status === 404) return 'target_unavailable';
  return 'failed';
}

/** What a refused save says. The cap's own sentence comes from the server, verbatim. */
export function saveFailureMessage(error: unknown): string {
  switch (classifySaveFailure(error)) {
    case 'limit_reached':
      return error instanceof Error && error.message
        ? error.message
        : 'فهرست علاقه‌مندی‌های شما پر است. برای افزودن مورد تازه، یکی از موردهای قبلی را حذف کنید.';
    case 'target_unavailable':
      return 'این مورد دیگر در دسترس نیست.';
    default:
      return 'ذخیره انجام نشد. دوباره تلاش کنید.';
  }
}
