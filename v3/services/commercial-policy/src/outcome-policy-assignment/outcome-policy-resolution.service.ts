import { Injectable, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import {
  BOOKING_OUTCOME_CONTRACT_VERSION,
  BookingOutcomeDisclosedCopyV1,
  BookingOutcomeRetentionRule,
  BookingOutcomeSnapshotV1,
  BookingOutcomeUnavailableCause,
  CustomerPolicyCopyLocale,
  selectionOutsideAllowed,
  validateBookingOutcomeSnapshotV1,
} from '@beauclick/commercial-policy-contract';

import { OUTCOME_POLICY_ASSIGNMENT_ENTITIES } from './outcome-policy-assignment.entities';
import {
  ActiveOutcomeVersionRow,
  CurrentOutcomeAssignmentRow,
  activeOutcomeVersions,
  allowedMembersOf,
  retentionOptionsFor,
  retentionRuleFromColumns,
  selectionOfRow,
} from './outcome-policy-rows';

/**
 * What the resolver decided for one seller party (ADR-051 §3). Exactly three
 * outcomes, named by the ratified text:
 *
 *   * `legacy_unenrolled` — no current selection; today's path, no terms;
 *   * `resolved` — a validated snapshot of the version and the copy active at
 *     the database instant;
 *   * `unavailable` — enrolled, but nothing resolvable. NOT a fallback: order
 *     creation refuses the online-collection path on it (`V33-DEC-039` R13).
 *
 * The cause is a closed, identity-free vocabulary for a metric label. It never
 * reaches a response.
 */
export type BookingOutcomePolicyResolution =
  | { readonly outcome: 'legacy_unenrolled' }
  | { readonly outcome: 'resolved'; readonly snapshot: BookingOutcomeSnapshotV1 }
  | { readonly outcome: 'unavailable'; readonly cause: BookingOutcomeUnavailableCause };

/**
 * Which outcome terms govern an enrolled seller's booking, resolved inside the
 * order transaction — V3.3 Story #159 (`#42b`), ADR-051 §3.
 *
 * A third, read-only service for the reason #115's
 * `CollectionPolicyResolutionService` records: no actor, no reason, no audit
 * row and no write, so the order path cannot reach a mutation surface.
 *
 * ## The lock order is the contract (ADR-048 R5, applied by ADR-051)
 *
 *   1. `FOR SHARE` on the party's CURRENT selection — a supersession is an
 *      UPDATE of that row, so it waits for this order;
 *   2. `FOR SHARE` on the active outcome VERSION — a retirement waits;
 *   3. the version's options, frozen by `tg_bopro_freeze` once published;
 *   4. `FOR SHARE` on the one active COPY version — its retirement waits.
 *
 * Share locks only, never upgraded: two orders for one seller never block each
 * other, and a seller re-selecting (unlocked read → version `FOR SHARE` → CAS)
 * waits for in-flight orders rather than deadlocking with them.
 *
 * ## It never guesses
 *
 * No cache, no latest, no default copy, no first row. Zero or several active
 * copy versions platform-wide is `unavailable`: nothing associates a copy with
 * a policy, and every ratified text speaks of THE active copy (the #159
 * preflight, correction 3). Picking one would put words in front of a customer
 * that no rule chose.
 */
@Injectable()
export class BookingOutcomePolicyResolutionService {
  async resolveForParty(
    manager: EntityManager,
    partyType: 'professional' | 'business',
    partyId: string,
  ): Promise<BookingOutcomePolicyResolution> {
    // (1) Presence IS enrollment; absence is the legacy answer and nothing else.
    const assignments: CurrentOutcomeAssignmentRow[] = await manager.query(
      `SELECT id, policy_key, cutoff_hours,
              late_retention_kind, late_retention_basis_points, late_retention_amount_toman,
              grace_minutes,
              no_show_retention_kind, no_show_retention_basis_points, no_show_retention_amount_toman,
              assigned_at
         FROM commercial.seller_outcome_policy_assignments
        WHERE seller_party_type = $1 AND seller_party_id = $2 AND superseded_at IS NULL
        FOR SHARE`,
      [partyType, partyId],
    );
    const assignment = assignments[0];
    if (!assignment) return { outcome: 'legacy_unenrolled' };

    // (2) The key's version active at the database's own clock, locked.
    const versions = await activeOutcomeVersions(manager, assignment.policy_key, true);
    if (versions.length === 0) return { outcome: 'unavailable', cause: 'no_active_version' };
    if (versions.length > 1) return { outcome: 'unavailable', cause: 'ambiguous_version' };
    const version = versions[0];

    // (3) The selection must still be inside it. A forward re-ranging that
    // dropped a member makes new governed bookings fail closed until the
    // seller selects again; existing snapshots are untouched.
    const selection = selectionOfRow(assignment);
    const options = await retentionOptionsFor(manager, [version.id]);
    if (selectionOutsideAllowed(selection, allowedMembersOf(version, options.get(version.id))).length > 0) {
      return { outcome: 'unavailable', cause: 'member_not_allowed' };
    }

    // (4) Exactly one published copy version active platform-wide, locked.
    const copies: Array<{ copy_key: string; version: number }> = await manager.query(
      `SELECT copy_key, version
         FROM commercial.customer_policy_copy_versions
        WHERE lifecycle_state = 'published'
          AND activation_starts_at <= now()
          AND (activation_ends_at IS NULL OR now() < activation_ends_at)
        FOR SHARE`,
    );
    if (copies.length === 0) return { outcome: 'unavailable', cause: 'no_active_copy' };
    if (copies.length > 1) return { outcome: 'unavailable', cause: 'ambiguous_copy' };

    const snapshot: BookingOutcomeSnapshotV1 = {
      policyKey: assignment.policy_key,
      policyVersion: Number(version.version),
      copyKey: copies[0].copy_key,
      copyVersion: Number(copies[0].version),
      resolvedAt: version.resolved_at.toISOString(),
      legalEvidenceId: version.legal_evidence_id,
      terms: {
        contractVersion: BOOKING_OUTCOME_CONTRACT_VERSION,
        ...selection,
        rescheduleFreeCountBeforeCutoff: Number(version.reschedule_free_count_before_cutoff),
        disputeWindowHours: Number(version.dispute_window_hours),
        bodilyHarmWindowHours: nullableNumber(version.bodily_harm_window_hours),
        appealWindowHours: Number(version.appeal_window_hours),
        caseFileRetentionDays: nullableNumber(version.case_file_retention_days),
        legalCap: legalCapOf(version),
      },
    };

    // Validated before it can become an immutable terms row.
    if (validateBookingOutcomeSnapshotV1(snapshot).length > 0) {
      return { outcome: 'unavailable', cause: 'invalid_snapshot' };
    }
    return { outcome: 'resolved', snapshot };
  }

  /**
   * The text of one EXACT published copy version, for the disclosure read.
   *
   * By key and version, never "the active one": the disclosure must show the
   * text of the version the resolution just named, and a published body is
   * immutable, so this read cannot disagree with it. `null` when the version is
   * not published (or no longer exists as such), which the caller refuses.
   */
  async disclosedCopy(
    manager: EntityManager,
    copyKey: string,
    copyVersion: number,
  ): Promise<BookingOutcomeDisclosedCopyV1 | null> {
    const rows: Array<{ locale: CustomerPolicyCopyLocale; body: string; body_sha256: string; published_at: Date }> =
      await manager.query(
        `SELECT locale, body, body_sha256, published_at
           FROM commercial.customer_policy_copy_versions
          WHERE copy_key = $1 AND version = $2 AND lifecycle_state = 'published'`,
        [copyKey, copyVersion],
      );
    const row = rows[0];
    if (!row) return null;
    return {
      locale: row.locale,
      body: row.body,
      bodySha256: row.body_sha256,
      publishedAt: row.published_at.toISOString(),
    };
  }
}

function nullableNumber(value: number | null): number | null {
  return value === null ? null : Number(value);
}

function legalCapOf(version: ActiveOutcomeVersionRow): BookingOutcomeRetentionRule | null {
  if (version.legal_cap_kind === null) return null;
  return retentionRuleFromColumns(version.legal_cap_kind, version.legal_cap_basis_points, version.legal_cap_amount_toman);
}

/**
 * The read-only provider the order path binds through the composition root.
 * Registers the selection entity only — never `#42a`'s entities, never a
 * catalogue array — and reads `#42a` through the narrow projections above.
 */
@Module({
  imports: [TypeOrmModule.forFeature(OUTCOME_POLICY_ASSIGNMENT_ENTITIES)],
  providers: [BookingOutcomePolicyResolutionService],
  exports: [BookingOutcomePolicyResolutionService],
})
export class BookingOutcomePolicyResolutionModule {}
