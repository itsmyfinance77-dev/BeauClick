import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

import { ProfessionalEntity, ServiceOfferingEntity } from '@beauclick/provider';
import {
  WishlistService,
  WishlistTargetPort,
  WishlistTargetRef,
  wishlistTargetKey,
} from '@beauclick/wishlist';
import type { WishlistSavedTargetsPort } from '@beauclick/provider';

/**
 * Verification statuses that make a professional — and everything they offer —
 * unavailable.
 *
 * `V32-DEC-021` names exactly these two. Written as a `Set` of literals rather
 * than as `NOT IN ('verified')` so that a future status added to the state
 * machine defaults to **available**, which is the direction that matches the
 * decision: `unverified`, `pending`, and `rejected` are all available today
 * because ordinary discovery still returns those professionals, and a new
 * intermediate status would almost certainly belong with them rather than with
 * suspension.
 *
 * The inverse formulation would silently make every future status unavailable,
 * which is a product decision nobody would have made deliberately.
 *
 * It is also why the query below selects `verification_status` and filters in
 * TypeScript instead of pushing `NOT IN (…)` into SQL: the direction of the
 * default is the decision, and it belongs somewhere a reader can see it.
 */
const UNAVAILABLE_VERIFICATION_STATUSES: ReadonlySet<string> = new Set(['suspended', 'revoked']);

/**
 * The wishlist's one cross-domain READ of the catalogue (ADR-033 §4, ADR-034).
 *
 * ## Why this lives here and not in `WishlistModule`
 *
 * ADR-011 forbids a domain from importing another and lint enforces it: an
 * `@beauclick/provider` import inside `services/wishlist` fails CI. `apps/api` is
 * `scope:app` and is the one place permitted to depend on every domain, so this
 * is where a cross-domain read is written down.
 *
 * `WishlistModule` declares `WISHLIST_TARGET_PORT` and provides nothing, so a
 * composition that forgets to bind it fails to boot rather than falling back to
 * something permissive. That matters more than usual here: a stub returning
 * every key would pass every test written against the wishlist module alone, and
 * would report targets the platform has decided not to show as `available`.
 *
 * ## Why it reads the authoritative tables and not the search projection
 *
 * `PublicCatalogueAiAdapter` records the reasoning and it transfers unchanged:
 * the search projection is eventually consistent, so a professional suspended
 * thirty seconds ago is still in the index until the event drains. Reading it
 * would confirm exactly the record the platform has just decided must not be
 * shown. Discovery is fast and eventually consistent; this gate is slow and
 * strictly consistent, and that is the correct way round.
 *
 * The property is observable rather than merely asserted: the real-PostgreSQL
 * suite suspends a professional **without reindexing**, leaves the stale search
 * document in place, and requires the saved item to read `unavailable` anyway.
 *
 * ## Where this deliberately differs from the AI catalogue
 *
 * `reverifyProfessionals` requires `verificationStatus = 'verified'`, because an
 * assistant recommending somebody is the platform vouching for them. This port
 * requires only that the professional is not soft-deleted and not
 * `suspended`/`revoked`, because a wishlist is the customer's own choice about
 * somebody they already found — and `SearchService.searchProviders` filters only
 * `is_deleted`, so a stricter rule here would call a professional visible on the
 * page the customer saved from `unavailable`.
 *
 * The difference is a decision (`V32-DEC-021`), not an inconsistency, and it is
 * the reason this adapter exists rather than reusing the AI one.
 */
@Injectable()
export class WishlistTargetAdapter implements WishlistTargetPort {
  constructor(
    @InjectRepository(ProfessionalEntity) private readonly professionals: Repository<ProfessionalEntity>,
    @InjectRepository(ServiceOfferingEntity) private readonly services: Repository<ServiceOfferingEntity>,
  ) {}

  /**
   * **At most two queries, whatever the batch size**, and never more:
   *
   *  1. the named services, live ones only, for their owning professional ids;
   *  2. every professional the answer depends on — the ones named directly PLUS
   *     the owners discovered in (1) — in ONE `IN`, because a second lookup per
   *     service is the N+1 pattern this port exists to avoid.
   *
   * Query (1) is skipped entirely when the batch names no services, and (2) when
   * nothing survives to check. A page of fifty saved items therefore costs two
   * queries, exactly as a page of one does.
   *
   * Takes the caller's `EntityManager` and uses it. Not a style preference: a
   * port that opens its own connection inside a caller's transaction is the
   * defect V3.2-B recorded as bug #2, where N concurrent senders needed 2N
   * connections against a pool of 10 and past five the suite **stopped** with no
   * error and no timeout. The injected repositories are kept for their entity
   * metadata; every query below runs on the manager.
   */
  async availableTargets(
    manager: EntityManager,
    targets: readonly WishlistTargetRef[],
  ): Promise<ReadonlySet<string>> {
    if (targets.length === 0) return new Set();

    const professionalIds = new Set<string>();
    const serviceIds = new Set<string>();
    for (const target of targets) {
      if (target.targetType === 'professional') professionalIds.add(target.targetId);
      else serviceIds.add(target.targetId);
    }

    // (1) The named services. A service is a candidate only if the row exists
    // and is live; whether it is SHOWABLE additionally depends on its owner,
    // which is the second-order case below.
    const liveServices =
      serviceIds.size === 0
        ? []
        : await manager.getRepository(this.services.target).find({
            where: { id: In([...serviceIds]) },
            select: { id: true, professionalId: true, deletedAt: true },
          });
    const candidateServices = liveServices.filter((service) => service.deletedAt === null);

    // (2) Every professional the answer depends on, in one lookup. A service's
    // owner joins the same `IN` as a directly-named professional, so a page
    // mixing both types still costs one query here.
    const ownersToCheck = new Set<string>(professionalIds);
    for (const service of candidateServices) ownersToCheck.add(service.professionalId);

    const showableProfessionals = await this.showableProfessionals(manager, ownersToCheck);

    const available = new Set<string>();
    for (const id of professionalIds) {
      if (showableProfessionals.has(id)) available.add(wishlistTargetKey({ targetType: 'professional', targetId: id }));
    }
    for (const service of candidateServices) {
      // **A service row survives its professional's suspension.** Checking only
      // `services.deleted_at` would report a treatment offered by somebody the
      // platform has just stopped showing as `available`, and it is the single
      // easiest thing to leave out of an implementation of this port.
      // `reverifyServices` makes the same join for the same reason.
      if (!showableProfessionals.has(service.professionalId)) continue;
      available.add(wishlistTargetKey({ targetType: 'service', targetId: service.id }));
    }
    return available;
  }

  private async showableProfessionals(manager: EntityManager, ids: ReadonlySet<string>): Promise<ReadonlySet<string>> {
    if (ids.size === 0) return new Set();

    const rows = await manager.getRepository(this.professionals.target).find({
      where: { id: In([...ids]) },
      select: { id: true, deletedAt: true, verificationStatus: true },
    });

    const showable = new Set<string>();
    for (const row of rows) {
      if (row.deletedAt !== null) continue;
      if (UNAVAILABLE_VERIFICATION_STATUSES.has(row.verificationStatus)) continue;
      showable.add(row.id);
    }
    // A missing row simply never enters the set. "Does not exist", "soft-deleted",
    // "suspended", and "revoked" are therefore the SAME outcome by construction
    // — there is no branch that could later be tempted to distinguish them.
    return showable;
  }
}

/**
 * The other direction: **has THIS customer saved these targets?** (ADR-034)
 *
 * ## Why it is a port at all, and why the arrow points this way
 *
 * `search` and `provider` render the pages a customer discovers from, and issue
 * #9 requires those pages to carry the caller's own saved state. Neither may
 * import `wishlist` (ADR-011), and `wishlist` must not grow a copy of the
 * catalogue (ADR-033 §7) — so the consumers declare a narrow port and this
 * adapter answers it from the one table that holds the truth.
 *
 * `WishlistTargetAdapter` above answers the mirror-image question and reads
 * `provider`; this one reads `wishlist`. Two ports, opposite directions, no
 * cycle: each domain still knows nothing about the other, and both bindings
 * live in the only module permitted to know about both.
 *
 * ## One adapter, bound under two tokens
 *
 * `search` and `provider` each declare their own `WISHLIST_SAVED_TARGETS`
 * symbol, because neither may import the other's. Both resolve to this ONE
 * instance, exactly as `PROFESSIONAL_DIRECTORY` and `PROFESSIONAL_OWNER_LOOKUP`
 * already share `ProviderBackedProfessionalDirectory` — a second implementation
 * answering the same question a second way is how two surfaces start disagreeing
 * about whether something is saved.
 *
 * ## What it cannot do
 *
 * It takes the subject as its first argument and passes it straight through to
 * `WishlistService.savedTargets`, whose `WHERE` clause carries `user_id`. There
 * is no method here that answers a question about anybody else, no count, and no
 * aggregate — so no consumer can construct one from what this port returns.
 */
@Injectable()
export class WishlistSavedTargetsAdapter implements WishlistSavedTargetsPort {
  constructor(private readonly wishlist: WishlistService) {}

  async savedTargets(userId: string, targets: readonly WishlistTargetRef[]): Promise<ReadonlySet<string>> {
    return this.wishlist.savedTargets(userId, targets);
  }
}
