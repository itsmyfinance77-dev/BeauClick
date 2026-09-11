import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { OrderEntity } from '@beauclick/commerce';
import type { BookingConfirmationEntitlementHook, BookingConfirmationEntitlement } from '@beauclick/commerce';
import type { BusinessGovernanceInitializationPort } from '@beauclick/business';
import {
  BookingCreditAccountingService,
  BookingCreditEnforcementControlService,
  BookingCreditEnforcementGovernanceService,
  BookingCreditReturnCause,
} from '@beauclick/commercial-policy';
import type { SellerGovernanceInitializationPort } from '@beauclick/provider';

/**
 * The entitlement seam's real binding — V3.3 #58 (`#58a`), ADR-046 §3 and §7.
 *
 * Replaces #81's no-op. `services/commerce` declares the port and
 * `services/commercial-policy` owns the ledger; ADR-011 forbids either importing
 * the other, so the join happens here in `apps/api`, which is the one scope
 * permitted to see both.
 *
 * ## Why this adapter resolves the party rather than the ledger
 *
 * The charged party is a **commerce** fact — the order's immutable
 * `sellerPartyType`/`sellerPartyId`, written at order creation and therefore
 * fixed before either confirmation path runs. The commercial service must not
 * reach into `commerce.orders` to find it, and the port must not accept it from
 * a caller, so this adapter is exactly where the translation belongs.
 *
 * Live `business_staff` affiliation is never consulted. `V33-DEC-020`
 * established the rule for finance reads and `V33-DEC-025` Ruling 7 restates it
 * for credits: current affiliation must not decide historical money.
 *
 * ## The four-plane decision runs HERE, upstream of the ledger -- V3.3 #95
 *
 * ADR-050 §4.1: this adapter is the one place that already sees the order's
 * snapshotted party, the confirmation transaction and both domains, so it is
 * where the kill-switch and rollout planes are consulted -- BEFORE
 * `consumeForConfirmation`, which is byte-identical to #58a
 * (`V33-DEC-036` R13). The control row is read `FOR SHARE` on the caller's
 * manager, so an engagement (which takes it `FOR UPDATE`) and this
 * confirmation are linearized by PostgreSQL. It is read AFTER the order
 * lookup so that `no_order` stays byte-identical whatever the switch says,
 * and BEFORE the ledger's own per-party advisory lock -- the fixed order
 * ADR-050 §7.2 documents.
 *
 * With the rollout inactive the decision is exactly "refuse if the kill
 * switch is engaged, otherwise #58a as before", and governance is NOT read.
 *
 * ## Under an ACTIVE rollout -- V3.3 #141 (`#58b-2`), ADR-050 §4.3
 *
 * The order's snapshotted party is resolved through its governance row,
 * read UNDER the same `bcre` party lock the ledger takes a moment later
 * (re-entrant; ADR-050 §4.1 "after the party lock"), and:
 *
 *   * unresolved or malformed  -> refused, `business_policy_disabled`, and
 *                                 the ledger is NEVER called -- nothing can
 *                                 be consumed for a party nobody classified;
 *   * `legacy_exempt`          -> the #58a selective path, byte-identical;
 *   * `governed`               -> the ledger decides, and then the four-plane
 *                                 gate is asked with every plane genuinely
 *                                 evaluated: `consumed`/`already_consumed`
 *                                 permit; `not_configured` and
 *                                 `insufficient_credit` refuse as
 *                                 `entitlement_missing`. Zero never means
 *                                 unlimited (`V33-DEC-036` R2).
 *
 * The party is selected ONCE from the order and passed to both the
 * governance read and the ledger; live `business_staff` affiliation and the
 * owner are never consulted here.
 */
@Injectable()
export class BookingCreditEntitlementAdapter implements BookingConfirmationEntitlementHook {
  constructor(
    private readonly credits: BookingCreditAccountingService,
    private readonly enforcement: BookingCreditEnforcementControlService,
  ) {}

  async onBookingConfirmation(
    manager: EntityManager,
    bookingId: string,
  ): Promise<BookingConfirmationEntitlement> {
    /*
     * Exactly one order, found by the booking it was created for. The unique
     * index on `(source_type, source_id)` makes "exactly one" a storage
     * guarantee rather than an assumption, and an absent order fails closed:
     * charging some other party would be worse than refusing.
     */
    const order = await manager.findOne(OrderEntity, {
      where: { sourceType: 'booking', sourceId: bookingId },
    });
    if (!order) return { outcome: 'ineligible', reason: 'no_order' };

    /*
     * V3.3 #95 (`#58b-1`). The pre-ledger planes. An engaged kill switch
     * refuses every new first confirmation on both checkout paths, for
     * governed, legacy-exempt and unresolved sellers alike (`V33-DEC-036`
     * R8) -- and it refuses BEFORE anything is consumed, so nothing has to be
     * given back. A released switch under an inactive rollout is the legacy
     * path, byte-for-byte.
     */
    const control = await this.enforcement.readForConfirmation(manager);
    const preLedger = this.enforcement.decideBeforeLedger(control);
    if (preLedger.kind === 'refuse') return { outcome: 'control_refused', reason: preLedger.reason };

    const party = { partyType: order.sellerPartyType, partyId: order.sellerPartyId };

    /*
     * V3.3 #141 (`#58b-2`). The business-policy plane, under the party lock,
     * BEFORE the ledger -- so an unresolved party is refused with nothing
     * consumed, and a governed party is known to be governed before its
     * balance is decided.
     */
    let governed = false;
    if (preLedger.kind === 'active') {
      const governance = await this.enforcement.readGovernanceForConfirmation(manager, party);
      const policy = this.enforcement.decideGovernance(control, governance);
      if (policy.kind === 'refuse') return { outcome: 'control_refused', reason: policy.reason };
      governed = policy.kind === 'governed';
    }

    const result = await this.credits.consumeForConfirmation(manager, bookingId, party);

    if (governed && result.outcome !== 'ineligible') {
      const verdict = this.enforcement.decideGovernedLedger(result.outcome);
      if (verdict.kind === 'refuse') return { outcome: 'control_refused', reason: verdict.reason };
    }

    switch (result.outcome) {
      case 'consumed':
      case 'already_consumed':
      case 'not_configured':
        return { outcome: 'permitted', detail: result.outcome };
      case 'insufficient_credit':
        return { outcome: 'insufficient_credit' };
      default:
        return { outcome: 'ineligible', reason: result.reason };
    }
  }
}

/**
 * The cancellation half — V3.3 #58 (`#58a`), ADR-046 §8.
 *
 * Bound to booking-service's own port so the return is written **inside the
 * cancellation's transaction**: a cancellation that rolls back leaves no return,
 * and a return that fails rolls back the cancellation. No event, no eventual
 * consumer, no window in which a credit is owed but unrecorded.
 *
 * ## The actor mapping is the policy boundary, and it is narrow on purpose
 *
 * Only two actors are both reachable and already authorised. `customer`
 * cancellation is deliberately absent: whether it returns the seller's credit is
 * retention policy under `V33-DEC-013` and #46, and answering it here would be
 * inventing commercial policy in an adapter. `admin` is absent because no
 * production route produces that actor, and `business` because the booking actor
 * vocabulary has no such value.
 */
@Injectable()
export class BookingCreditCancellationAdapter {
  constructor(private readonly credits: BookingCreditAccountingService) {}

  async onBookingCancellation(
    manager: EntityManager,
    bookingId: string,
    actorType: string,
    wasConfirmed: boolean,
  ): Promise<void> {
    // A booking that was never confirmed consumed nothing, so there is nothing
    // to give back. An expired pending hold reaches here and correctly does
    // nothing.
    if (!wasConfirmed) return;

    const cause = CAUSE_BY_ACTOR[actorType];
    if (!cause) return;

    await this.credits.returnForCancellation(manager, bookingId, cause);
  }
}

/** The closed mapping. Absent actors return nothing rather than defaulting. */
const CAUSE_BY_ACTOR: Record<string, BookingCreditReturnCause | undefined> = {
  professional: 'seller_cancelled',
  system: 'platform_cancelled',
};

/**
 * Governance initialisation at seller creation -- V3.3 #141 (`#58b-2`),
 * ADR-050 §3.4, `V33-DEC-036` R5.
 *
 * ONE adapter, bound under BOTH domain tokens (`SELLER_GOVERNANCE_INITIALIZATION`
 * and `BUSINESS_GOVERNANCE_INITIALIZATION`), the arrangement
 * `IdentityBackedOwnerRoleGrant` established: `provider` and `business` each
 * declare a port because neither may import `commercial-policy` (ADR-011),
 * and two implementations of "govern a party created under an active
 * rollout" would be two answers to a question that must have exactly one.
 *
 * The party TYPE comes from which method was called -- the caller is the only
 * thing that knows whether it created a professional or a business; it is
 * never inferred from the id. Ownership is the trigger (the creating
 * transaction IS the ownership fact being established); staff affiliation
 * never reaches either method because no staff path calls either port.
 *
 * Holds no repository and no DataSource: the caller's manager is passed
 * straight through, so "runs on another connection" is impossible rather
 * than discouraged.
 */
@Injectable()
export class EnforcementBackedGovernanceInitialization implements SellerGovernanceInitializationPort, BusinessGovernanceInitializationPort {
  constructor(private readonly governance: BookingCreditEnforcementGovernanceService) {}

  async initializeProfessionalGovernance(manager: EntityManager, professionalId: string): Promise<void> {
    await this.governance.initializeCreatedParty(manager, { partyType: 'professional', partyId: professionalId });
  }

  async initializeBusinessGovernance(manager: EntityManager, businessId: string): Promise<void> {
    await this.governance.initializeCreatedParty(manager, { partyType: 'business', partyId: businessId });
  }
}
