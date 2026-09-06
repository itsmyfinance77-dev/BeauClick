import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { returningRows } from '@beauclick/events';
import { AdminAuditService } from '@beauclick/audit';

import {
  AUDIT_TARGET_SUBSCRIPTION,
  SUBSCRIPTION_AUDIT_ACTIONS,
  SUBSCRIPTION_AUDIT_REASONS,
  SYSTEM_ACTOR_LABEL,
} from './seller-subscription.audit';

import {
  BookingCreditConsumptionEntity,
  BookingCreditGrantEntity,
  BookingCreditReturnEntity,
  BookingCreditReturnCause,
  SubscriberPartyType,
} from './seller-subscription.entities';

/**
 * The advisory-lock namespace for booking-credit balance decisions.
 *
 * Named for the ENTITLEMENT seam rather than for credits-as-a-quantity, and
 * deliberately so: `#56a`'s boundary spec forbids binding a numeric literal to
 * a credit/allowance/quota name, because that shape is how a hard-coded
 * commercial value gets in. This is a lock key, not an allowance -- but the
 * guard is right to be blunt, so the name moves rather than the guard.
 *
 * `0x62_63_72_65` is ASCII `bcre`, distinct from every other namespace in the
 * codebase. Uniqueness matters and is asserted by a test: two domains sharing a
 * namespace would serialise unrelated work against each other, and — far worse —
 * two domains hashing different identifiers into one space could believe they
 * hold different locks while holding the same one.
 */
export const BOOKING_ENTITLEMENT_LOCK_NAMESPACE = 0x62_63_72_65 | 0;

/**
 * What the entitlement layer did — V3.3 #58 (`#58a`), ADR-046 §2.
 *
 * A closed union, and the two zero-balance members are the point of the whole
 * story: `not_configured` and `insufficient_credit` describe the SAME number and
 * opposite situations. Collapsing them is exactly how a rollout state becomes a
 * permanent free entitlement, so they are answers to two different questions —
 * "has this party ever been granted anything positive?" and "is anything left?".
 */
export type CreditConsumptionOutcome =
  /** A credit was spent. The caller may confirm. */
  | { outcome: 'consumed'; consumptionId: string; grantId: string }
  /** This booking was already charged. A replay. The caller may confirm. */
  | { outcome: 'already_consumed'; consumptionId: string }
  /**
   * This party has never held a positive grant, so entitlement is dormant for
   * it. The caller may confirm and nothing is written. NOT an unlimited
   * allowance: the moment a positive grant exists, enforcement is live.
   */
  | { outcome: 'not_configured' }
  /** This party was configured and has spent everything. The caller must refuse. */
  | { outcome: 'insufficient_credit' }
  /**
   * The booking has no single consistent order to charge against. Fails closed
   * rather than guessing a party.
   */
  | { outcome: 'ineligible'; reason: 'no_order' | 'no_subscription' };

export type CreditReturnOutcome =
  | { outcome: 'returned'; returnId: string }
  | { outcome: 'already_returned' }
  | { outcome: 'nothing_consumed' };

interface PartyRef {
  readonly partyType: SubscriberPartyType;
  readonly partyId: string;
}

/**
 * The booking-credit ledger — V3.3 #58 (`#58a`), ADR-046.
 *
 * Balance is **derived**, never stored:
 *
 *     balance = SUM(grants.quantity) - COUNT(consumptions with no return)
 *
 * There is no balance column, because a counter cannot be audited against its
 * own history and turns every concurrent confirmation into contention on one
 * row for a number that is a pure function of rows that already exist.
 *
 * ## Two races, two different mechanisms
 *
 * **The same booking twice** is stopped by `uq_bcc_booking_once`. A redelivered
 * callback or a double-clicked confirmation collides on it and writes nothing.
 *
 * **Two different bookings racing for the last credit** is stopped by a
 * transaction-scoped advisory lock on the charged party. A conditional
 * `INSERT ... SELECT` alone cannot do it: under `READ COMMITTED` both
 * transactions read a balance of one, neither sees the other's uncommitted row,
 * and both insert.
 *
 * Neither mechanism subsumes the other, so both are present.
 */
@Injectable()
export class BookingCreditAccountingService {
  /**
   * The PERSISTENT audit trail, not the operational logger.
   *
   * `AdminAuditService.recordSystem` writes inside the caller's own
   * transaction, so the audit row and the ledger row commit together or
   * neither does. An `AuditLogger` line would survive a rollback and record a
   * credit that was never spent, which is the failure this seam exists to
   * prevent. The actor is a server-generated label because nobody decided
   * anything here -- the credit moved because a booking was confirmed -- and
   * `ck_admin_audit_actor` keeps that structurally distinct from a human's
   * action (`V33-DEC-018`, restated for credits by `V33-DEC-025` Ruling 9).
   */
  constructor(private readonly audit: AdminAuditService) {}

  /**
   * Spend one credit for a booking that is about to be confirmed.
   *
   * Runs inside the caller's transaction and returns a closed outcome; it never
   * throws for an ordinary refusal, because "this seller has no credit" is a
   * decision the orchestrator has to route differently on each confirmation
   * path (ADR-046 §6).
   *
   * @param manager the caller's transaction. Every read and write uses it, so
   *   the advisory lock is held on the same connection as the work it protects.
   * @param party the charged party, resolved by the caller from the ORDER's
   *   immutable seller snapshot — never from live affiliation and never from a
   *   request.
   */
  async consumeForConfirmation(
    manager: EntityManager,
    bookingId: string,
    party: PartyRef,
  ): Promise<CreditConsumptionOutcome> {
    /*
     * Serialise this party's balance decisions before reading anything.
     *
     * Transaction-scoped, so it releases at commit or rollback with no cleanup
     * path to forget. Keyed by the party rather than globally: two bookings for
     * different sellers never contend, and two for the same seller genuinely
     * must.
     *
     * `hashtext` rather than the raw id: a lock key is not readable as an
     * identifier, and collisions are harmless here because a collision can only
     * serialise two parties that would each have been serialised anyway.
     */
    await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
      BOOKING_ENTITLEMENT_LOCK_NAMESPACE,
      `${party.partyType}:${party.partyId}`,
    ]);

    const existing = await manager.findOne(BookingCreditConsumptionEntity, { where: { bookingId } });
    if (existing) return { outcome: 'already_consumed', consumptionId: existing.id };

    const grants = await manager.find(BookingCreditGrantEntity, {
      where: { subscriberPartyType: party.partyType, subscriberPartyId: party.partyId },
      order: { grantedAt: 'ASC', id: 'ASC' },
    });

    /*
     * DORMANT versus EXHAUSTED, decided by two different questions.
     *
     * "Has this party ever been granted anything positive?" is asked first and
     * answered from the grants alone. A party whose only grant is the seeded
     * `D-7` zero row has never been configured, so entitlement is dormant for it
     * and the confirmation proceeds unmetered.
     *
     * That is a rollout state, not an unlimited allowance: `V33-DEC-009` forbids
     * an allowance existing as a code constant, default, fallback or seed, and
     * this grants nothing — it declines to meter a party the product has not yet
     * decided an entitlement for.
     */
    const positiveGrants = grants.filter((g) => g.quantity > 0);
    if (positiveGrants.length === 0) return { outcome: 'not_configured' };

    const granted = positiveGrants.reduce((sum, g) => sum + g.quantity, 0);
    const spent = await this.activeConsumptionCount(manager, party);
    if (spent >= granted) return { outcome: 'insufficient_credit' };

    /*
     * Oldest grant first, `granted_at ASC, id ASC` — deterministic and
     * tie-broken. Expiry is pinned NULL by `ck_booking_credit_grants_no_expiry`,
     * so there is no expiring entitlement to prefer and none is invented; a
     * future expiry decision may version this rule visibly (ADR-046 §4).
     */
    const perGrant = await this.activeConsumptionCountByGrant(manager, party);
    const chosen = positiveGrants.find((g) => (perGrant.get(g.id) ?? 0) < g.quantity);
    if (!chosen) {
      // Unreachable while the aggregate check above holds: if the totals say
      // something is left, some grant has room. Kept because "unreachable" is a
      // claim about the arithmetic above, and a refusal is a better failure than
      // charging an arbitrary grant if that claim ever stops holding.
      return { outcome: 'insufficient_credit' };
    }

    const consumptionId = uuidv7();
    await manager.insert(BookingCreditConsumptionEntity, {
      id: consumptionId,
      bookingId,
      grantId: chosen.id,
      subscriptionId: chosen.subscriptionId,
      periodIndex: chosen.periodIndex,
      subscriberPartyType: chosen.subscriberPartyType,
      subscriberPartyId: chosen.subscriberPartyId,
    });

    /*
     * Audited only HERE, where a row was genuinely inserted.
     *
     * `already_consumed`, `not_configured` and `insufficient_credit` return
     * above without touching this, because an audit trail that records
     * no-ops as if a credit moved cannot be used to answer the one question
     * it exists for.
     *
     * No booking id in the record: the consumption row already holds it, and
     * a booking identifies a counterparty. `consumptionId` reaches the same
     * fact through the ledger without putting a customer-linked identifier in
     * the seller's audit trail.
     */
    await this.audit.recordSystem(manager, {
      actorLabel: SYSTEM_ACTOR_LABEL,
      action: SUBSCRIPTION_AUDIT_ACTIONS.creditConsumed,
      targetType: AUDIT_TARGET_SUBSCRIPTION,
      targetId: chosen.subscriptionId,
      after: {
        consumptionId,
        grantId: chosen.id,
        periodIndex: chosen.periodIndex,
      },
      reason: SUBSCRIPTION_AUDIT_REASONS.creditConsumed,
    });

    return { outcome: 'consumed', consumptionId, grantId: chosen.id };
  }

  /**
   * Return the credit a qualifying cancellation undid.
   *
   * Runs inside the cancellation's own transaction, so a cancellation that rolls
   * back leaves no return and a failed return rolls back the cancellation.
   *
   * The party is **never** re-resolved: the return credits whoever the
   * consumption says was charged, which is what makes an affiliation change
   * after the fact harmless.
   */
  async returnForCancellation(
    manager: EntityManager,
    bookingId: string,
    cause: BookingCreditReturnCause,
  ): Promise<CreditReturnOutcome> {
    const consumption = await manager.findOne(BookingCreditConsumptionEntity, { where: { bookingId } });
    if (!consumption) return { outcome: 'nothing_consumed' };

    const already = await manager.findOne(BookingCreditReturnEntity, {
      where: { consumptionId: consumption.id },
    });
    if (already) return { outcome: 'already_returned' };

    const returnId = uuidv7();
    /*
     * `ON CONFLICT DO NOTHING` on the unique constraint, not merely the read
     * above: two concurrent cancellations both pass the read and only one may
     * insert. The read is the common-path shortcut; the constraint is the
     * guarantee.
     */
    const raw = await manager.query(
      `INSERT INTO commercial.booking_credit_returns (id, consumption_id, return_cause)
       VALUES ($1, $2, $3)
       ON CONFLICT (consumption_id) DO NOTHING
       RETURNING id`,
      [returnId, consumption.id, cause],
    );
    if (returningRows(raw).length !== 1) return { outcome: 'already_returned' };

    await this.audit.recordSystem(manager, {
      actorLabel: SYSTEM_ACTOR_LABEL,
      action: SUBSCRIPTION_AUDIT_ACTIONS.creditReturned,
      targetType: AUDIT_TARGET_SUBSCRIPTION,
      targetId: consumption.subscriptionId,
      after: {
        returnId,
        consumptionId: consumption.id,
        // The closed cause, never the canceller's own words.
        cause,
      },
      reason: SUBSCRIPTION_AUDIT_REASONS.creditReturned,
    });

    return { outcome: 'returned', returnId };
  }

  /** Grants minus unreturned consumptions. Derived on every read, never cached. */
  async balanceFor(manager: EntityManager, party: PartyRef): Promise<number> {
    const grants = await manager.find(BookingCreditGrantEntity, {
      where: { subscriberPartyType: party.partyType, subscriberPartyId: party.partyId },
    });
    const granted = grants.reduce((sum, g) => sum + g.quantity, 0);
    return Math.max(0, granted - (await this.activeConsumptionCount(manager, party)));
  }

  /** Consumptions for this party that have not been returned. */
  private async activeConsumptionCount(manager: EntityManager, party: PartyRef): Promise<number> {
    const [row] = await manager.query(
      `SELECT count(*)::int AS n
         FROM commercial.booking_credit_consumptions c
    LEFT JOIN commercial.booking_credit_returns r ON r.consumption_id = c.id
        WHERE c.subscriber_party_type = $1 AND c.subscriber_party_id = $2
          AND r.id IS NULL`,
      [party.partyType, party.partyId],
    );
    return Number(row?.n ?? 0);
  }

  /** The same count, split by grant, so allocation knows which grant has room. */
  private async activeConsumptionCountByGrant(
    manager: EntityManager,
    party: PartyRef,
  ): Promise<Map<string, number>> {
    const rows = await manager.query(
      `SELECT c.grant_id AS grant_id, count(*)::int AS n
         FROM commercial.booking_credit_consumptions c
    LEFT JOIN commercial.booking_credit_returns r ON r.consumption_id = c.id
        WHERE c.subscriber_party_type = $1 AND c.subscriber_party_id = $2
          AND r.id IS NULL
     GROUP BY c.grant_id`,
      [party.partyType, party.partyId],
    );
    return new Map(rows.map((r: { grant_id: string; n: number }) => [r.grant_id, Number(r.n)]));
  }
}
