import type { EntityManager } from 'typeorm';

export { wishlistTargetKey } from '@beauclick/wishlist-contract';
export type { WishlistTargetRef } from '@beauclick/wishlist-contract';
import type { WishlistTargetRef } from '@beauclick/wishlist-contract';

/**
 * The one seam this module has.
 *
 * `wishlist` may not import `provider` (ADR-011, enforced by lint), and it must
 * neither accept a target it cannot resolve nor claim a target is showable when
 * the platform has decided otherwise. So it declares what it needs and the
 * composition root binds it — the pattern `apps/api/src/composition/ai-ports.ts`
 * established for the AI catalogue.
 *
 * **`WishlistModule` deliberately provides no default implementation.** A module
 * that cannot boot without its port bound is a module whose boundary is real:
 * there is nothing to fall back on, and no way to ship a stub by accident.
 */

/**
 * `WishlistTargetRef` and `wishlistTargetKey` are re-exported from
 * `@beauclick/wishlist-contract` above rather than redeclared here.
 *
 * They belong to the contract because four modules now build the same key —
 * `wishlist` when it answers, `search` and `provider` when they read the answer,
 * and the page when it looks a result up. Two independent key formats that must
 * agree is the kind of duplication that silently stops agreeing.
 */

/**
 * Answers one question about a **batch** of targets: **which of these are
 * currently showable?**
 *
 * ## Why this shape, and why it replaced Story #8's single-target port
 *
 * Story #8 declared `WishlistSaveableTargetPort.isSaveable(manager, target)` —
 * one target, at add time — and ADR-033 §4 wrote down what should happen when
 * Story #9 arrived: *"if #9 introduces a broader port, this one is absorbed
 * rather than reimplemented."* This is that absorption. There is now ONE port,
 * ONE predicate, and ONE adapter; `save` calls it with a single-element batch,
 * and `list` calls it with a page.
 *
 * The alternative — keeping `isSaveable` and adding a second batch method — would
 * be two implementations of the same product decision, free to drift. The
 * predicate below is `V32-DEC-021`, and a decision with two implementations is a
 * decision with two answers.
 *
 * ## Why it is a batch and not a loop
 *
 * A page of 50 saved items resolved one at a time is 50 (or 100, for services)
 * round trips per list request. That is the N+1 pattern issue #9 forbids by
 * name. This port takes the whole page and the adapter answers it in a bounded
 * number of queries that does not grow with the page.
 *
 * ## The predicate, which is a decision and not an implementation detail
 *
 * A target is **available** unless:
 *
 *  * it is soft-deleted; or
 *  * its owning professional is soft-deleted; or
 *  * its owning professional's `verification_status` is `suspended` or `revoked`.
 *
 * A professional who is merely `unverified`, `pending`, or `rejected` **is
 * available** (`V32-DEC-021`). `SearchService.searchProviders` filters only
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
 * `services.deleted_at` would call a treatment offered by somebody the platform
 * has just stopped showing `available`.
 *
 * ## What the answer may NOT carry
 *
 * A set of keys, not a map of reasons. The port cannot report *why* a target is
 * absent from the set, because nothing above it may render a cause
 * (`WISHLIST_TARGET_STATES`). Returning `{ deleted: true }` would put the
 * distinction one careless `JSON.stringify` away from a browser.
 */
export interface WishlistTargetPort {
  /**
   * The subset of `targets` that currently exist and are currently showable,
   * as a set of `wishlistTargetKey` values.
   *
   * Reads the **authoritative** `provider` tables, never the search projection.
   * `PublicCatalogueAiAdapter`'s docblock records why and the reasoning
   * transfers unchanged: the projection is eventually consistent, so a
   * professional suspended thirty seconds ago is still in the index, and reading
   * it would confirm exactly the record the platform has just decided must not
   * be shown. Discovery is fast and eventually consistent; this is slow and
   * strictly consistent, and that is the correct way round.
   *
   * Takes the caller's `EntityManager` so an add-time check runs inside the same
   * transaction as the insert it guards. This is not a style preference: a port
   * that opens its own connection inside a caller's transaction is the defect
   * V3.2-B recorded as bug #2, where N concurrent senders needed 2N connections
   * against a pool of 10 and the suite **stopped** rather than failing.
   *
   * Returns keys rather than records, unlike the AI catalogue's
   * re-verification. The difference is deliberate: AI returns records because
   * the caller must use the catalogue's own display name instead of the one a
   * model claimed. This caller renders nothing about the target and stores
   * nothing about it, so a record would be data the module has no business
   * holding (ADR-033 §7).
   */
  availableTargets(manager: EntityManager, targets: readonly WishlistTargetRef[]): Promise<ReadonlySet<string>>;
}

export const WISHLIST_TARGET_PORT = Symbol('BEAUCLICK_WISHLIST_TARGET_PORT');
