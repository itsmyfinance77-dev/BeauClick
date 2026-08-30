import type { EntityManager } from 'typeorm';

import type { WishlistTargetType } from '@beauclick/wishlist-contract';

/**
 * The one seam this module has.
 *
 * `wishlist` may not import `provider` (ADR-011, enforced by lint), and it must
 * not accept a target it cannot resolve. So it declares what it needs and the
 * composition root binds it — the pattern `apps/api/src/composition/ai-ports.ts`
 * established for the AI catalogue.
 *
 * **`WishlistModule` deliberately provides no default implementation.** A module
 * that cannot boot without its port bound is a module whose boundary is real:
 * there is nothing to fall back on, and no way to ship a stub by accident.
 */

/** A target the caller named, before anything has decided whether it is real. */
export interface WishlistTargetRef {
  readonly targetType: WishlistTargetType;
  readonly targetId: string;
}

/**
 * Answers one question about one target: **may this be saved right now?**
 *
 * ## Why this exists at all
 *
 * Without it, `POST /items` accepts any well-formed UUID and a customer's list
 * fills with rows that can never render as anything but unavailable once Story
 * #9 lands. It is also the only place in Story #8 where the platform's single
 * `NotFoundOrNotYoursException` can arise, which is what makes issue #8's
 * indistinguishability criterion mean something.
 *
 * ## Scope boundary with Story #9, stated so it is not duplicated
 *
 * This port answers **one target, at add time**. Story #9 owns the **batch
 * projection** that computes the `available | unavailable` state of already-saved
 * items for a page of results. The two must keep sharing the predicate below; if
 * #9 introduces a broader port, this one is absorbed rather than reimplemented.
 *
 * ## The predicate, which is a decision and not an implementation detail
 *
 * A target is saveable unless:
 *
 *  * it is soft-deleted; or
 *  * its owning professional is soft-deleted; or
 *  * its owning professional's `verification_status` is `suspended` or `revoked`.
 *
 * A professional who is merely `unverified`, `pending`, or `rejected` **is
 * saveable** (`V32-DEC-021`). `SearchService.searchProviders` filters only
 * `is_deleted`, so ordinary discovery still returns those professionals, and a
 * stricter rule here would make a saved list contradict the page the customer
 * saved it from.
 *
 * This deliberately differs from `AiPublicCataloguePort.reverifyProfessionals`,
 * which requires `verified`. That is not an inconsistency: a recommendation is
 * the platform vouching for someone; a wishlist is the customer's own choice
 * about someone they already found.
 *
 * The second-order case is load-bearing: **a service row survives its
 * professional's suspension**, so an implementation that checks only
 * `services.deleted_at` would let a customer save a treatment offered by
 * somebody the platform has just stopped showing.
 */
export interface WishlistSaveableTargetPort {
  /**
   * True when the target currently exists and is currently showable.
   *
   * Reads the **authoritative** `provider` tables, never the search projection.
   * `PublicCatalogueAiAdapter`'s docblock records why and the reasoning
   * transfers unchanged: the projection is eventually consistent, so a
   * professional suspended thirty seconds ago is still in the index, and
   * validating against it would confirm exactly the record the platform has just
   * decided must not be shown.
   *
   * Takes the caller's `EntityManager` so the check runs inside the same
   * transaction as the insert it guards. This is not a style preference: a port
   * that opens its own connection inside a caller's transaction is the defect
   * V3.2-B recorded as bug #2, where N concurrent senders needed 2N connections
   * against a pool of 10 and the suite **stopped** rather than failing.
   *
   * Returns a boolean rather than a record, unlike the AI catalogue's
   * re-verification. The difference is deliberate: AI returns records because
   * the caller must use the catalogue's own display name instead of the one a
   * model claimed. This caller renders nothing about the target and stores
   * nothing about it, so a record would be data the module has no business
   * holding.
   */
  isSaveable(manager: EntityManager, target: WishlistTargetRef): Promise<boolean>;
}

export const WISHLIST_SAVEABLE_TARGET = Symbol('BEAUCLICK_WISHLIST_SAVEABLE_TARGET');
