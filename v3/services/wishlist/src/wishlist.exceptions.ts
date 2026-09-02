import { HttpStatus } from '@nestjs/common';

import { DomainException } from '@beauclick/http';
import { WISHLIST_MAX_SAVED_ITEMS } from '@beauclick/wishlist-contract';
import type { WishlistRefusalReason } from '@beauclick/wishlist-contract';

/**
 * This module produces exactly two refusals, and only ONE of them is its own.
 *
 * **`target_unavailable` is not thrown from here.** It is the platform's shared
 * `NotFoundOrNotYoursException` — one type, one code, one Persian message, used
 * identically for a target that does not exist, one that is soft-deleted, and
 * one whose professional is suspended or revoked. Giving the wishlist a bespoke
 * exception for that case would create a second refusal shape a caller could
 * compare against the shared one, which is the enumeration channel
 * `V3_SECURITY_MODEL.md` §3 closes. The reason string exists in the browser-safe
 * vocabulary so a page can NAME the state it is rendering; it never travels on
 * the wire as a distinguishing code.
 *
 * **`limit_reached` is thrown from here**, and the asymmetry is deliberate
 * rather than an oversight. A cap refusal discloses exactly one fact and it is a
 * fact about the caller's **own** list: that it is full. It names no third
 * party, confirms nothing about whether any professional exists, and is the only
 * refusal the caller can act on — they can remove something. Collapsing it into
 * the generic not-found would leave a customer at 500 items staring at
 * «این مورد یافت نشد» for a professional plainly visible on the page in front of
 * them.
 */
export class WishlistLimitReachedException extends DomainException {
  constructor() {
    const reason: WishlistRefusalReason = 'limit_reached';
    super(
      'WISHLIST_LIMIT_REACHED',
      `فهرست علاقه‌مندی‌های شما پر است. حداکثر ${WISHLIST_MAX_SAVED_ITEMS} مورد می‌توانید ذخیره کنید. برای افزودن مورد تازه، یکی از موردهای قبلی را حذف کنید.`,
      HttpStatus.CONFLICT,
      { reason },
    );
  }
}
