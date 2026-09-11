import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { CreditPurchaseEntity } from './credit-purchase.entity';
import {
  BookingCreditConsumptionEntity,
  BookingCreditGrantEntity,
  SellerSubscriptionEntity,
} from './seller-subscription.entities';
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
    {
      table: 'commercial.booking_credit_consumptions',
      disposition: 'retained',
      reason:
        'The debit side of the seller balance (#58a). Immutable by trigger and one row per booking. It names a booking id and the charged party and carries no customer identity, so there is nothing personal to the counterparty to erase; deleting it would silently return a credit the seller genuinely spent.',
    },
    {
      table: 'commercial.credit_purchases',
      disposition: 'retained',
      reason:
        'The immutable record of a price a seller was offered for a custom booking-credit quantity, and of their request against it (#57). Retained as an obligation record: it names the charged party and the catalogue rows that priced it, carries no customer identity at all, and deleting it would destroy the only proof of what was quoted. Nothing here has been paid and no credit has been granted.',
    },
    {
      table: 'commercial.booking_credit_returns',
      disposition: 'retained',
      reason:
        'The reversal side of the seller balance (#58a). At most one per consumption, immutable, and carrying a closed server-authored cause rather than any cancellation prose. Deleting it would re-spend a credit that was already given back.',
    },
    /*
     * V3.3 #95 (`#58b-1`), ADR-050 §8.
     *
     * The singleton control row carries NO actor column -- who activated the
     * rollout or moved the kill switch lives in `admin.admin_audit_log`,
     * pointed at by two opaque audit ids -- so `no_subject_data` is honest.
     * Its columns contain no `_by` or `_user_id` suffix, which means the
     * coverage detector would NOT catch a dishonest claim on it; the
     * disposition is therefore pinned by an explicit test, exactly as
     * `booking_credit_grants`' is above.
     *
     * The per-party governance table names a seller party AND the
     * administrator who recorded its state (`recorded_by_user_id`), so it is
     * `retained`: an operational and legal obligation record. Deleting a row
     * would silently return a seller to legacy exemption, which is the one
     * thing `V33-DEC-036` R3 and R12 forbid. The `_user_id` suffix makes a
     * dishonest `no_subject_data` claim on it detectable -- at BOOT, by the
     * coverage assertion, before any request is served.
     */
    {
      table: 'commercial.booking_credit_enforcement_control',
      disposition: 'no_subject_data',
      reason:
        'The one-row platform control for booking-credit enforcement: rollout state, activation generation and kill-switch state, plus two opaque audit-row ids. No person is named; administrator identity for its mutations stays in admin.admin_audit_log (ADR-050 §8).',
    },
    {
      table: 'commercial.booking_credit_party_governance',
      disposition: 'retained',
      reason:
        'One explicit governance fact per seller party (governed or legacy_exempt) with the administrator who recorded it. An operational and legal obligation record: deleting it would silently return a seller to legacy exemption, and the party id it holds points at a row provider or business has already anonymized in place (ADR-050 §8).',
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

    /*
     * V3.3 #58a. The seller's own debit side, exported with the same care as
     * the credit side: what they spent and when, and NOT who they spent it on.
     * A booking id is a counterparty-linked identifier, so it is deliberately
     * absent from the export even though it is the row's own key.
     */
    const consumptions = await manager
      .getRepository(BookingCreditConsumptionEntity)
      .createQueryBuilder('c')
      .where(this.partyPredicate(parties, 'c'), this.partyParameters(parties))
      .orderBy('c.consumed_at', 'DESC')
      .getMany();

    /*
     * V3.3 #57 (`#40c-1`). The seller's own purchase requests.
     *
     * Reached through the SUBSCRIPTIONS already resolved above, so the export
     * inherits the same ownership predicate rather than restating it — a staff
     * member gets nothing here for exactly the reason they get nothing above.
     */
    const purchases =
      subscriptions.length === 0
        ? []
        : await manager
            .getRepository(CreditPurchaseEntity)
            .createQueryBuilder('p')
            .where('p.subscription_id IN (:...ids)', { ids: subscriptions.map((s) => s.id) })
            .orderBy('p.created_at', 'DESC')
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

    if (consumptions.length > 0) {
      sections.push({
        key: 'commercial.booking_credit_consumptions',
        description: 'اعتبارهای نوبت‌دهی مصرف‌شده توسط کسب‌وکار شما',
        rows: consumptions.map((c) => ({
          subscriberPartyType: c.subscriberPartyType,
          periodIndex: c.periodIndex,
          consumedAt: c.consumedAt.toISOString(),
        })),
      });
    }

    if (purchases.length > 0) {
      sections.push({
        key: 'commercial.credit_purchases',
        description: 'درخواست‌های خرید اعتبار نوبت‌دهی کسب‌وکار شما',
        rows: purchases.map((purchase) => ({
          quantity: purchase.quantity,
          unitPriceToman: purchase.unitPriceToman,
          totalToman: purchase.totalToman,
          currency: purchase.currencyCode,
          state: purchase.lifecycleState,
          effectiveAt: purchase.effectiveAt.toISOString(),
          createdAt: purchase.createdAt.toISOString(),
          // No `requestKey`: the caller's own protocol token, which echoing
          // adds nothing to. No `requestedByUserId`: which of a workspace's
          // owners pressed the button is an actor fact for the audit trail. No
          // `scheduleKey`, `priceScheduleVersionId` or `priceTierId`: catalogue
          // internals a seller is not shown, here for the same reason the quote
          // route omits them.
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
