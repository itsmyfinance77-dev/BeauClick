import { Injectable, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import {
  BOOKING_COLLECTION_POLICY_CONTRACT_VERSION,
  BookingCollectionDepositKind,
  BookingCollectionMode,
  BookingCollectionPercentageBase,
  BookingCollectionPolicySnapshotV1,
  BookingCollectionTermsV1,
  CollectionDepositRule,
  validateBookingCollectionPolicySnapshotV1,
} from '@beauclick/commercial-policy-contract';

import { COLLECTION_POLICY_ASSIGNMENT_ENTITIES } from './collection-policy-assignment.entities';
import { CollectionPolicyUnresolvableError } from './collection-policy-resolution.errors';

/**
 * Which policy governs an enrolled seller's booking, resolved inside the order
 * transaction — V3.3 Story #115 (`#41d-2b`), ADR-048 R1, R4 and R5.
 *
 * ## Why this is a THIRD service and not a method on either existing one
 *
 * `BookingCollectionPolicyService` is the privileged administrator writer:
 * every method takes an `actorUserId`, requires a reason, and writes an audit
 * row. `CollectionPolicyAssignmentService` is the seller's own writer: it
 * supersedes assignments and audits that too. This one writes nothing at all —
 * no row, no audit, no event — and has no actor parameter to write one with.
 *
 * Merging it into either would hand the order path a method one autocomplete
 * away from `publishVersion` or `assign`, on a code path that runs for every
 * booking on the platform. ADR-048 R4 draws the line and
 * `PriceResolutionService` already drew the same one for prices: the read-only
 * core is its own service, only as wide as the read, in a module both sides may
 * import.
 *
 * ## It never guesses
 *
 * No cache, no "latest", no environment-selected key, no default and no
 * fabricated policy. An enrolled party whose assigned key has no version
 * published and active at this instant is a REFUSAL, never a downgrade to the
 * legacy path — `V33-DEC-029` Ruling 8 forbids the post-lookup fallback by
 * name, because a fallback would silently price a booking under terms the
 * seller did not choose and nobody would ever see it happen.
 *
 * ## The order of the two locks is the contract (ADR-048 R5)
 *
 *   1. `FOR SHARE` on the party's CURRENT assignment row. A concurrent
 *      supersession is an `UPDATE` of that row, so it waits until this order's
 *      transaction ends. The order cannot snapshot a key that was superseded
 *      mid-transaction.
 *   2. `FOR SHARE` on the resolved VERSION row. Retirement is an `UPDATE` of
 *      `lifecycle_state`/`retired_at` on that row, so it waits too. Without it
 *      the version could be retired between resolution and the schedule insert.
 *
 * Both are share locks and neither is ever upgraded here, because this service
 * writes nothing. That is what makes them safe to hold: two concurrent orders
 * for the same seller share both locks and neither blocks the other.
 */
@Injectable()
export class CollectionPolicyResolutionService {
  /**
   * The policy governing this seller party right now, or `null` when the party
   * is unenrolled.
   *
   * `null` is returned only for a genuinely absent assignment. Every other
   * outcome — a key that no longer exists, no version active at this instant, a
   * snapshot that fails contract validation — throws
   * `CollectionPolicyUnresolvableError`, so a caller cannot mistake a broken
   * resolution for an unenrolled party. That distinction is the whole of
   * ADR-048 R2's fail-closed boundary.
   */
  async resolveForParty(
    manager: EntityManager,
    partyType: 'professional' | 'business',
    partyId: string,
  ): Promise<BookingCollectionPolicySnapshotV1 | null> {
    // (1) The current assignment, locked. Presence IS enrollment (ADR-048 R2),
    // so the absence of a row here is the unenrolled answer and nothing else.
    const assignments: Array<{ policy_key: string }> = await manager.query(
      `SELECT policy_key
         FROM commercial.seller_collection_policy_assignments
        WHERE seller_party_type = $1 AND seller_party_id = $2 AND superseded_at IS NULL
        FOR SHARE`,
      [partyType, partyId],
    );

    const assignment = assignments[0];
    if (!assignment) return null;

    // From here the party is ENROLLED and every failure is a refusal.
    //
    // (2) The version of that exact stable key which is published and active at
    // the DATABASE's own clock instant, locked. `now()` is evaluated by
    // PostgreSQL inside this transaction: an application `new Date()` would let
    // a host with a skewed clock select a version that is not yet active, or
    // miss one that is.
    //
    // `resolved_at` is returned from the same statement rather than taken
    // afterwards, so the instant recorded on the snapshot is exactly the
    // instant the window was evaluated against.
    const versions: Array<VersionRow> = await manager.query(
      `SELECT v.version,
              v.collection_mode,
              v.deposit_kind,
              v.deposit_amount_toman,
              v.deposit_basis_points,
              v.deposit_minimum_toman,
              v.deposit_maximum_toman,
              v.percentage_base,
              v.contract_version,
              now() AS resolved_at
         FROM commercial.booking_collection_policy_versions v
        WHERE v.policy_key = $1
          AND v.lifecycle_state = 'published'
          AND v.activation_starts_at <= now()
          AND (v.activation_ends_at IS NULL OR now() < v.activation_ends_at)
        FOR SHARE`,
      [assignment.policy_key],
    );

    if (versions.length === 0) {
      throw new CollectionPolicyUnresolvableError('no_active_version');
    }
    if (versions.length > 1) {
      // `ex_bcpv_no_effective_overlap` makes this unreachable. Refusing rather
      // than picking one keeps it unreachable: silently taking `[0]` would turn
      // a broken exclusion constraint into a booking priced by whichever row
      // the planner happened to return first.
      throw new CollectionPolicyUnresolvableError('ambiguous_version');
    }

    const snapshot: BookingCollectionPolicySnapshotV1 = {
      policyKey: assignment.policy_key,
      policyVersion: versions[0].version,
      resolvedAt: versions[0].resolved_at.toISOString(),
      terms: termsFrom(versions[0]),
    };

    // Validated before it can reach an order. A row that predates a contract
    // change, or a column combination the catalogue's CHECKs somehow admitted,
    // must not become an immutable schedule.
    const problems = validateBookingCollectionPolicySnapshotV1(snapshot);
    if (problems.length > 0) throw new CollectionPolicyUnresolvableError('invalid_snapshot');

    return snapshot;
  }
}

interface VersionRow {
  version: number;
  collection_mode: BookingCollectionMode;
  deposit_kind: BookingCollectionDepositKind;
  deposit_amount_toman: number | null;
  deposit_basis_points: number | null;
  deposit_minimum_toman: number | null;
  deposit_maximum_toman: number | null;
  percentage_base: BookingCollectionPercentageBase | null;
  contract_version: number;
  resolved_at: Date;
}

/**
 * The pure terms of an already-read version row. No I/O.
 *
 * The exact inverse of `BookingCollectionPolicyService.termsColumns`, and
 * deliberately total rather than defensive: an unrecognised `deposit_kind`
 * produces a rule the contract validator rejects, which becomes
 * `invalid_snapshot` above rather than a silently half-built deposit.
 */
function termsFrom(row: VersionRow): BookingCollectionTermsV1 {
  return {
    contractVersion: BOOKING_COLLECTION_POLICY_CONTRACT_VERSION,
    collectionMode: row.collection_mode,
    deposit: depositFrom(row),
  };
}

function depositFrom(row: VersionRow): CollectionDepositRule {
  if (row.deposit_kind === 'fixed') {
    return { kind: 'fixed', amountToman: Number(row.deposit_amount_toman) };
  }
  if (row.deposit_kind === 'percentage') {
    return {
      kind: 'percentage',
      basisPoints: Number(row.deposit_basis_points),
      percentageBase: row.percentage_base as BookingCollectionPercentageBase,
      minimumToman: Number(row.deposit_minimum_toman),
      maximumToman: row.deposit_maximum_toman === null ? null : Number(row.deposit_maximum_toman),
    };
  }
  return { kind: 'none' };
}

/**
 * One read-only provider, so the order path can resolve a policy without
 * importing either mutation surface.
 *
 * It registers `COLLECTION_POLICY_ASSIGNMENT_ENTITIES` only — never
 * `COMMERCIAL_ENTITIES` or `BOOKING_COLLECTION_POLICY_ENTITIES` — and reads the
 * catalogue through two narrow SQL projections instead, which is the same line
 * `CollectionPolicyAssignmentModule` draws and Story #83 ships a structural test
 * for.
 */
@Module({
  imports: [TypeOrmModule.forFeature(COLLECTION_POLICY_ASSIGNMENT_ENTITIES)],
  providers: [CollectionPolicyResolutionService],
  exports: [CollectionPolicyResolutionService],
})
export class CollectionPolicyResolutionModule {}
