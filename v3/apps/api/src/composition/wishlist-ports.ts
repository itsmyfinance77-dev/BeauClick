import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { ProfessionalEntity, ServiceOfferingEntity } from '@beauclick/provider';
import { WishlistSaveableTargetPort, WishlistTargetRef } from '@beauclick/wishlist';

/**
 * Verification statuses that make a professional — and everything they offer —
 * unsaveable.
 *
 * `V32-DEC-021` names exactly these two. Written as a `Set` of literals rather
 * than as `NOT IN ('verified')` so that a future status added to the state
 * machine defaults to **saveable**, which is the direction that matches the
 * decision: `unverified`, `pending`, and `rejected` are all saveable today
 * because ordinary discovery still returns those professionals, and a new
 * intermediate status would almost certainly belong with them rather than with
 * suspension.
 *
 * The inverse formulation would silently make every future status unsaveable,
 * which is a product decision nobody would have made deliberately.
 */
const UNSAVEABLE_VERIFICATION_STATUSES: ReadonlySet<string> = new Set(['suspended', 'revoked']);

/**
 * The wishlist's one cross-domain read (ADR-033 §4).
 *
 * ## Why this lives here and not in `WishlistModule`
 *
 * ADR-011 forbids a domain from importing another and lint enforces it: an
 * `@beauclick/provider` import inside `services/wishlist` fails CI. `apps/api` is
 * `scope:app` and is the one place permitted to depend on every domain, so this
 * is where a cross-domain read is written down.
 *
 * `WishlistModule` declares `WISHLIST_SAVEABLE_TARGET` and provides nothing, so
 * a composition that forgets to bind it fails to boot rather than falling back
 * to something permissive. That matters more than usual here: a stub returning
 * `true` would pass every test written against the wishlist module alone, and
 * would silently accept targets the platform has decided not to show.
 *
 * ## Why it reads the authoritative tables and not the search projection
 *
 * `PublicCatalogueAiAdapter` records the reasoning and it transfers unchanged:
 * the search projection is eventually consistent, so a professional suspended
 * thirty seconds ago is still in the index until the event drains. Validating
 * against it would confirm exactly the record the platform has just decided must
 * not be shown. Discovery is fast and eventually consistent; the gate is slow and
 * strictly consistent, and that is the correct way round.
 *
 * ## Where this deliberately differs from the AI catalogue
 *
 * `reverifyProfessionals` requires `verificationStatus = 'verified'`, because an
 * assistant recommending somebody is the platform vouching for them. This port
 * requires only that the professional is not soft-deleted and not
 * `suspended`/`revoked`, because a wishlist is the customer's own choice about
 * somebody they already found — and `SearchService.searchProviders` filters only
 * `is_deleted`, so a stricter rule here would refuse a save for a professional
 * visible on the page the customer is saving from.
 *
 * The difference is a decision (`V32-DEC-021`), not an inconsistency, and it is
 * the reason this adapter exists rather than reusing the AI one.
 */
@Injectable()
export class WishlistSaveableTargetAdapter implements WishlistSaveableTargetPort {
  constructor(
    @InjectRepository(ProfessionalEntity) private readonly professionals: Repository<ProfessionalEntity>,
    @InjectRepository(ServiceOfferingEntity) private readonly services: Repository<ServiceOfferingEntity>,
  ) {}

  /**
   * Takes the caller's `EntityManager` and uses it.
   *
   * Not a style preference. A port that opens its own connection inside a
   * caller's transaction is the defect V3.2-B recorded as bug #2: N concurrent
   * senders needed 2N connections against a pool of 10, and past five the suite
   * **stopped** with no error and no timeout. The injected repositories are kept
   * for their entity metadata; every query below runs on the manager.
   */
  async isSaveable(manager: EntityManager, target: WishlistTargetRef): Promise<boolean> {
    if (target.targetType === 'professional') {
      return this.isProfessionalSaveable(manager, target.targetId);
    }
    return this.isServiceSaveable(manager, target.targetId);
  }

  private async isProfessionalSaveable(manager: EntityManager, professionalId: string): Promise<boolean> {
    const row = await manager.getRepository(this.professionals.target).findOne({
      where: { id: professionalId },
      select: { id: true, deletedAt: true, verificationStatus: true },
    });
    return this.showable(row);
  }

  /**
   * A service is saveable only if it is live AND its professional is showable.
   *
   * The second half is what makes this correct rather than merely present: **a
   * service row survives its professional's suspension**, so checking only
   * `services.deleted_at` would let a customer save a treatment offered by
   * somebody the platform has just stopped showing. `reverifyServices` makes the
   * same join for the same reason, and it is the single easiest thing to leave
   * out of an implementation of this port.
   */
  private async isServiceSaveable(manager: EntityManager, serviceId: string): Promise<boolean> {
    const service = await manager.getRepository(this.services.target).findOne({
      where: { id: serviceId },
      select: { id: true, professionalId: true, deletedAt: true },
    });
    if (!service || service.deletedAt !== null) return false;

    const owner = await manager.getRepository(this.professionals.target).findOne({
      where: { id: service.professionalId },
      select: { id: true, deletedAt: true, verificationStatus: true },
    });
    return this.showable(owner);
  }

  private showable(row: { deletedAt: Date | null; verificationStatus: string } | null): boolean {
    if (!row) return false;
    if (row.deletedAt !== null) return false;
    return !UNSAVEABLE_VERIFICATION_STATUSES.has(row.verificationStatus);
  }
}
