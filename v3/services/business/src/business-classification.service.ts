import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AdminAuditService } from '@beauclick/audit';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';

import {
  AUDIT_TARGET_BUSINESS_CLASSIFICATION,
  CLASSIFICATION_AUDIT_ACTIONS,
  CLASSIFICATION_AUDIT_REASONS,
} from './business-classification.audit';
import { BusinessTrait, BusinessTraitEntity } from './entities/business-trait.entity';
import { BusinessVertical, BusinessVerticalEntity } from './entities/business-vertical.entity';
import { ReplaceBusinessClassificationDto } from './dto/business-classification.dto';

/**
 * What a business IS, on two orthogonal axes.
 *
 * `vertical` is `null` exactly when the owner has not classified the business.
 * That is a legal, permanent-until-answered state (`V33-DEC-032` R3), never an
 * error and never a value this code invents.
 */
export interface BusinessClassification {
  readonly vertical: BusinessVertical | null;
  readonly traits: readonly BusinessTrait[];
}

/**
 * Business classification and operating traits -- V3.3 Story #107 (`#44a`).
 *
 * Bound by `V33-DEC-030` D1, `V33-DEC-032` R1-R7 and ADR-049 sections 1 and 7.
 *
 * ## Why this is its own service
 *
 * Classification has nothing to do with staff membership: it names no person,
 * grants nothing, and its authority comes from live ownership alone. Folding it
 * into `StaffService` -- the one place `business_staff.status` is written --
 * would put a fact about the organisation next to the consent machinery for
 * people, and the two have different reasons to change.
 *
 * ## This service authorizes NOTHING
 *
 * `V33-DEC-032` R7. Nothing here is consulted by a guard, a resolver, a
 * capability verifier, an entitlement decision, finance, booking, chat, search
 * or commercial policy, and `business-classification-boundary.spec.ts` asserts
 * that structurally rather than by review. `clinic` is a commercial label: it
 * carries no medical, diagnostic, treatment or health-record data and grants
 * nothing `salon` does not.
 */
@Injectable()
export class BusinessClassificationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * This business's current classification.
   *
   * **A read never writes.** No lazy default, no repair, no initialization: an
   * unclassified business answers `{ vertical: null, traits: [] }` and stays
   * unclassified. Liveness is not re-checked here because every caller reaches
   * this through `@ResolveOwner`, whose resolver already refuses a soft-deleted
   * business (`StaffService.roleFor`).
   */
  async read(businessId: string): Promise<BusinessClassification> {
    return this.readWith(this.dataSource.manager, businessId);
  }

  /**
   * Replaces the whole classification of one LIVE business, atomically.
   *
   * ## The lock is what makes the result a snapshot of ONE request
   *
   * Two owners' requests -- or one owner's two tabs -- would otherwise
   * interleave: request A could write its vertical while request B wrote its
   * traits, leaving a business that is neither what A sent nor what B sent. So
   * the transaction first takes a row lock on the business itself, and every
   * classification write for that business queues behind it. At commit the two
   * tables always agree with exactly one request.
   *
   * `FOR NO KEY UPDATE` rather than `FOR UPDATE`, deliberately: the stronger
   * mode conflicts with the `FOR KEY SHARE` lock PostgreSQL takes on a parent
   * row when a child row referencing it is inserted, so `FOR UPDATE` here would
   * block an unrelated concurrent staff invitation for the same business.
   * `FOR NO KEY UPDATE` still conflicts with itself, which is the only
   * serialization this needs.
   *
   * ## Idempotent replay writes nothing at all
   *
   * A byte-identical replay returns success, touches no row and writes NO audit
   * record. An audit trail that logged "replaced salon with salon" on every
   * retry would make the real changes harder to find, and the two tables carry
   * no timestamps to churn (see `BusinessVerticalEntity`), so "nothing changed"
   * is decided by comparing the values themselves.
   */
  async replace(
    businessId: string,
    actorUserId: string,
    dto: ReplaceBusinessClassificationDto,
  ): Promise<BusinessClassification> {
    const desired: BusinessClassification = {
      vertical: dto.vertical,
      traits: sortTraits(dto.traits),
    };

    return this.dataSource.transaction(async (manager) => {
      // The live-business predicate and the lock are one statement, so a
      // business soft-deleted between the guard and here cannot be classified.
      // The refusal is the platform's existing non-enumerating shape, so a
      // deleted, foreign and nonexistent business answer identically.
      const locked: unknown[] = await manager.query(
        `SELECT id FROM business.businesses WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE`,
        [businessId],
      );
      if (locked.length === 0) throw new NotFoundOrNotYoursException();

      const current = await this.readWith(manager, businessId);
      if (isSameClassification(current, desired)) return current;

      await manager.query(
        `INSERT INTO business.business_verticals (business_id, vertical)
         VALUES ($1, $2)
         ON CONFLICT (business_id) DO UPDATE SET vertical = EXCLUDED.vertical`,
        [businessId, desired.vertical],
      );

      // Replace the trait SET: drop the ones this request did not name, add the
      // ones it did. `ON CONFLICT DO NOTHING` keeps an unchanged trait's row
      // physically untouched instead of deleting and re-inserting it, so a
      // partial overlap churns only what actually differs.
      await manager.query(
        `DELETE FROM business.business_traits WHERE business_id = $1 AND NOT (trait = ANY($2::varchar[]))`,
        [businessId, [...desired.traits]],
      );
      for (const trait of desired.traits) {
        await manager.query(
          `INSERT INTO business.business_traits (business_id, trait) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [businessId, trait],
        );
      }

      // Same manager, same transaction: the classification and its record
      // commit together or not at all. A failure here rolls the classification
      // back with it, which is the guarantee rather than a hazard.
      await this.audit.record(manager, {
        actorUserId,
        action: CLASSIFICATION_AUDIT_ACTIONS.replaced,
        targetType: AUDIT_TARGET_BUSINESS_CLASSIFICATION,
        targetId: businessId,
        before: snapshot(current),
        after: snapshot(desired),
        reason: CLASSIFICATION_AUDIT_REASONS.replacedByOwner,
      });

      return desired;
    });
  }

  private async readWith(manager: EntityManager, businessId: string): Promise<BusinessClassification> {
    const vertical = await manager.findOne(BusinessVerticalEntity, { where: { businessId } });
    const traits = await manager.find(BusinessTraitEntity, { where: { businessId } });

    return {
      vertical: vertical?.vertical ?? null,
      traits: sortTraits(traits.map((row) => row.trait)),
    };
  }
}

/**
 * Deterministic order at the boundary.
 *
 * A set has no order, so the physical row order is not one a client may depend
 * on -- and PostgreSQL is free to change it. Sorting here means the response,
 * the audit snapshot and the replay comparison all agree, and a test can assert
 * a whole body.
 */
function sortTraits(traits: readonly BusinessTrait[]): readonly BusinessTrait[] {
  return [...traits].sort((left, right) => left.localeCompare(right));
}

function isSameClassification(left: BusinessClassification, right: BusinessClassification): boolean {
  return (
    left.vertical === right.vertical &&
    left.traits.length === right.traits.length &&
    left.traits.every((trait, index) => trait === right.traits[index])
  );
}

/**
 * The audit before/after snapshot.
 *
 * `AuditSnapshot` is a flat record of primitives, so the trait set is joined
 * into one deterministic string rather than nested. It names a COMMERCIAL
 * classification and no person: no identity, phone number, opaque reference or
 * amount is in it, which is why it is allowed here at all.
 */
function snapshot(classification: BusinessClassification): { vertical: string | null; traits: string } {
  return {
    vertical: classification.vertical,
    traits: classification.traits.join(','),
  };
}
