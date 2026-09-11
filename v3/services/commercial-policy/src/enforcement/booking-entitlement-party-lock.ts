import { EntityManager } from 'typeorm';

import type { SubscriberPartyType } from '@beauclick/commercial-policy-contract';

import { BOOKING_ENTITLEMENT_LOCK_NAMESPACE } from '../subscription/booking-credit-accounting.service';

/**
 * THE per-party booking-entitlement lock, spelled once -- V3.3 #141
 * (`#58b-2`), ADR-050 §4.1 and §7.2 as implemented.
 *
 * `consumeForConfirmation` takes `pg_advisory_xact_lock(bcre, hashtext('<type>:<id>'))`
 * inside its own body (`booking-credit-accounting.service.ts:148`), and that
 * file is byte-identical to `#58a` by ruling (`V33-DEC-036` R13). Two other
 * callers must hold the SAME lock on the SAME key:
 *
 *   * the explicit transition/exemption commands (#95), which lock each party
 *     before writing its governance row;
 *   * the confirmation seam (#141), which locks the order's party before
 *     reading its governance row, so that "governance is read under the party
 *     lock" (ADR-050 §4.1) is true structurally and not by outcome-equivalence.
 *
 * PostgreSQL advisory locks are re-entrant within one session: the ledger's
 * later acquisition inside the same transaction is a no-op, and the lock is
 * released at commit or rollback with nothing to forget. No second namespace,
 * no second key format -- a drift in either would be two callers believing
 * they serialise on one lock while holding two.
 */
export async function lockBookingEntitlementParty(
  manager: EntityManager,
  party: { readonly partyType: SubscriberPartyType; readonly partyId: string },
): Promise<void> {
  await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
    BOOKING_ENTITLEMENT_LOCK_NAMESPACE,
    `${party.partyType}:${party.partyId}`,
  ]);
}
