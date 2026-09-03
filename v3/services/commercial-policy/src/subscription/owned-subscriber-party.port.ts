import type { EntityManager } from 'typeorm';

import type { SubscriberPartyType } from '@beauclick/commercial-policy-contract';

export interface OwnedSubscriberParty {
  readonly partyType: SubscriberPartyType;
  readonly partyId: string;
}

/**
 * commercial-policy's outbound port for subscription ownership.
 *
 * ## Why this is NOT `FinancialPartyResolver`
 *
 * The financial resolver answers "whose earnings are these?" and answers it
 * with one party, following an ACTIVE STAFF AFFILIATION when it finds one
 * (ADR-023 §3): an affiliated professional's earnings belong to the business
 * they work for. That is correct there and wrong here.
 *
 * `V33-DEC-018` fixes subscription ownership to ownership alone, resolved once
 * and never re-resolved. Following affiliation would mean a professional
 * joining a salon silently re-points "my subscription" at the salon —
 * transferring a commercial commitment on the strength of an employment change.
 * `V33-DEC-010` had already ruled the same way for returns, in the same words:
 * the seller's current affiliation is never re-resolved.
 *
 * So this is a second, narrower port rather than a widening of that one, and
 * the two must not be merged: they are correct in different ways.
 *
 * ## It returns a SET, and that is load-bearing
 *
 * `provider.professionals.owner_id` and `business.businesses.owner_id` are
 * independent unique indexes, so one user may own a professional AND a
 * business. The financial resolver picks business-first because earnings need a
 * single answer. Subscriptions do not: `V33-DEC-018` gives each PARTY a
 * subscription, so a user owning two parties owns two, with no relationship
 * between them.
 *
 * The consequence worth stating: nothing in this domain ever holds "the user's
 * subscription", only "this party's subscription". A cross-party read is
 * therefore not defended against — it is unrepresentable.
 *
 * ## Staff get nothing
 *
 * An affiliated staff member owns neither party, so this returns an empty array
 * for their employer. The capability #69 adds is not what stops them mutating
 * the business's subscription; this is. A capability check that passed would
 * still find no owned party to act on.
 */
export interface OwnedSubscriberPartyResolver {
  /**
   * Every seller party this user OWNS, eligible for a subscription.
   *
   * Empty when they own none — never a fabricated party, and never a party they
   * merely work for.
   *
   * Takes the caller's `EntityManager` so a resolution inside an activation
   * transaction sees that transaction's own uncommitted rows and rolls back
   * with it (ADR-042 §9). A resolver that opened its own pool connection could
   * not, which is the failure this signature makes impossible rather than
   * discouraged.
   */
  ownedPartiesFor(manager: EntityManager, userId: string): Promise<OwnedSubscriberParty[]>;

  /** Whether a party still exists and is not soft-deleted. Erasure and deletion both make this false. */
  isEligible(manager: EntityManager, party: OwnedSubscriberParty): Promise<boolean>;
}

export const OWNED_SUBSCRIBER_PARTY_RESOLVER = Symbol('BEAUCLICK_OWNED_SUBSCRIBER_PARTY_RESOLVER');
