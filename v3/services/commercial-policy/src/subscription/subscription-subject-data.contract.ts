import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { BookingCreditGrantEntity, SellerSubscriptionEntity } from './seller-subscription.entities';
import { OwnedSubscriberParty } from './owned-subscriber-party.port';

/**
 * `commercial`'s subscription tables — ADR-027, ADR-042 §11, `V33-DEC-018`.
 *
 * A SECOND contract in this module rather than five more claims on
 * `CommercialSubjectDataContract`, because the two answer differently. The
 * catalogue's tables are retained to protect ADMINISTRATOR attribution; these
 * are retained to preserve what the platform owed a SELLER. Same disposition,
 * genuinely different reasons, and merging them would produce one reason that
 * fits neither.
 *
 * ## Both are `retained`, and neither is `no_subject_data`
 *
 * `V33-DEC-018` rules it, and the two tables are protected differently — which
 * is worth stating rather than blurring into one sentence.
 *
 * `seller_subscriptions` carries `created_by_user_id` and
 * `cancelled_by_user_id`, so ADR-027's `wrongly_declared_empty` check would
 * reject a dishonest `no_subject_data` claim on it automatically.
 *
 * `booking_credit_grants` carries no `_user_id` or `_by` column at all: a grant
 * is issued by the system, and there is no actor to record. The detector would
 * therefore NOT catch a dishonest claim on it, and its disposition rests on the
 * reason below and on the suite that asserts it. Adding a permanently-NULL
 * `granted_by_user_id` so the check fires was rejected — inventing a column to
 * satisfy a detector is the mirror image of the evasion ADR-027 forbids.
 *
 * ## Why erasure genuinely does nothing here
 *
 * The subject survives as an id, and that is not a loophole.
 *
 * `provider`'s own contract anonymizes a professional IN PLACE — tombstone
 * alias, `bio` nulled, `deleted_at` set — and the row and its id survive.
 * `business.businesses` is likewise `retained`, with its own note that
 * ownership succession after an owner's erasure is an open product decision. So
 * by the time this contract runs, the identifying attributes behind
 * `subscriber_party_id` have already been removed by the modules that own them,
 * and what remains is a party identifier pointing at an anonymized row.
 *
 * Deleting the subscription would therefore destroy the record of what the
 * platform was obliged to provide without removing anything personal that still
 * exists. And it would break #58: a consumption row survives its grant, and a
 * balance whose credit side was deleted is not a smaller balance, it is a wrong
 * one.
 *
 * ## What export returns, and what it must not
 *
 * The subject's own commercial facts, and only when they OWN the party.
 *
 * A staff member gets nothing, deliberately. They are not the subscriber, and
 * an export route is not an authorization boundary — returning their employer's
 * plan terms, seat counts and credit history because they happen to work there
 * would disclose another party's commercial position through a request about
 * themselves. This is the same asymmetry the ownership resolver enforces on the
 * write side, applied to reads.
 *
 * No administrator identity appears either: the export shows what the seller
 * holds, never who at the platform configured it.
 *
 * ## The counts are truthful
 *
 * Zero anonymized, zero deleted, both tables named as retained with their
 * reasons. Erasure really does nothing here and the report says so, rather than
 * reporting a stub that looks like work.
 */
@Injectable()
export class SubscriptionSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'commercial-subscription';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    {
      table: 'commercial.seller_subscriptions',
      disposition: 'retained',
      reason:
        'Carries created_by_user_id and cancelled_by_user_id, and is the immutable record of the terms the platform was obliged to provide a seller. The party id it holds points at a row provider or business has already anonymized in place, so erasing this would destroy the obligation record without removing anything personal that still exists.',
    },
    {
      table: 'commercial.booking_credit_grants',
      disposition: 'retained',
      reason:
        'Operational evidence of the entitlements a subscription conferred, and the credit side of the balance #58 derives. A consumption row outlives its grant, so deleting the grant would not produce a smaller balance -- it would produce a wrong one.',
    },
  ];

  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const parties = await this.ownedPartiesFor(manager, userId);
    if (parties.length === 0) return [];

    const subscriptions = await manager
      .getRepository(SellerSubscriptionEntity)
      .createQueryBuilder('s')
      .where(this.partyPredicate(parties), this.partyParameters(parties))
      .orderBy('s.effective_at', 'DESC')
      .getMany();

    const grants = await manager
      .getRepository(BookingCreditGrantEntity)
      .createQueryBuilder('g')
      .where(this.partyPredicate(parties, 'g'), this.partyParameters(parties))
      .orderBy('g.granted_at', 'DESC')
      .getMany();

    const sections: SubjectExportSection[] = [];

    if (subscriptions.length > 0) {
      sections.push({
        key: 'commercial.subscriptions',
        description: 'اشتراک‌های کسب‌وکار شما و شرایط هر کدام',
        rows: subscriptions.map((s) => ({
          subscriberPartyType: s.subscriberPartyType,
          planKey: s.snapshotPlanKey,
          planVersion: s.snapshotVersion,
          state: s.lifecycleState,
          billingTermDays: s.snapshotBillingTermDays,
          includedBookingCredits: s.snapshotIncludedBookingCredits,
          staffSeats: s.snapshotStaffSeats,
          includedLocations: s.snapshotIncludedLocations,
          capabilityKeys: s.snapshotCapabilityKeys.join(','),
          currency: s.snapshotCurrencyCode,
          unitPriceToman: s.snapshotUnitPriceToman,
          effectiveAt: s.effectiveAt.toISOString(),
          // No `createdByUserId`: who at the platform configured this is an
          // administrative fact for the audit log, not part of a seller's
          // personal export.
        })),
      });
    }

    if (grants.length > 0) {
      sections.push({
        key: 'commercial.booking_credit_grants',
        description: 'اعتبارهای نوبت‌دهی اعطاشده به کسب‌وکار شما',
        rows: grants.map((g) => ({
          subscriberPartyType: g.subscriberPartyType,
          source: g.source,
          quantity: g.quantity,
          periodIndex: g.periodIndex,
          grantedAt: g.grantedAt.toISOString(),
          expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
        })),
      });
    }

    return sections;
  }

  async eraseSubjectData(): Promise<SubjectErasureOutcome> {
    return {
      moduleKey: this.moduleKey,
      anonymized: 0,
      deleted: 0,
      retained: this.tables.map((claim) => ({
        table: claim.table,
        reason: 'immutable entitlement record; the party behind it is anonymized by the module that owns it',
      })),
    };
  }

  /**
   * Ownership only, and resolved with SQL rather than through the port.
   *
   * A contract may not inject a port from its own module's composition root —
   * privacy orchestrates every module inside one transaction and must not
   * depend on each one's wiring. The predicate is the same as the resolver's,
   * and the coverage suite asserts both agree.
   */
  private async ownedPartiesFor(manager: EntityManager, userId: string): Promise<OwnedSubscriberParty[]> {
    const rows: Array<{ party_type: 'professional' | 'business'; party_id: string }> = await manager.query(
      `SELECT 'professional'::text AS party_type, p.id AS party_id
         FROM provider.professionals p WHERE p.owner_id = $1
        UNION ALL
       SELECT 'business'::text, b.id
         FROM business.businesses b WHERE b.owner_id = $1`,
      [userId],
    );
    return rows.map((row) => ({ partyType: row.party_type, partyId: row.party_id }));
  }

  private partyPredicate(parties: OwnedSubscriberParty[], alias = 's'): string {
    return parties
      .map(
        (_party, index) =>
          `(${alias}.subscriber_party_type = :type${index} AND ${alias}.subscriber_party_id = :id${index})`,
      )
      .join(' OR ');
  }

  private partyParameters(parties: OwnedSubscriberParty[]): Record<string, string> {
    return Object.fromEntries(
      parties.flatMap((party, index) => [
        [`type${index}`, party.partyType],
        [`id${index}`, party.partyId],
      ]),
    );
  }
}
