import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import {
  AssignableOutcomePolicyV1,
  BookingOutcomeSelectionV1,
  OUTCOME_POLICY_ASSIGNMENT_REASON_MAX_LENGTH,
  OUTCOME_POLICY_ASSIGNMENT_REASON_MIN_LENGTH,
  OutcomePolicyAssignmentRefusalCause,
  OutcomePolicyAssignmentViewV1,
  sameOutcomeSelection,
  selectionOutsideAllowed,
  validateBookingOutcomeSelectionV1,
} from '@beauclick/commercial-policy-contract';

import {
  OWNED_SUBSCRIBER_PARTY_RESOLVER,
  OwnedSubscriberParty,
  OwnedSubscriberPartyResolver,
} from '../subscription/owned-subscriber-party.port';
import { WorkspaceReferenceService } from '../seller-surface/workspace-reference';
import { OutcomePolicyAssignmentUnavailableException } from './outcome-policy-assignment.exceptions';
import {
  CurrentOutcomeAssignmentRow,
  activeOutcomeVersions,
  allowedMembersOf,
  retentionColumnsOf,
  retentionOptionsFor,
  selectionOfRow,
} from './outcome-policy-rows';

const PG_UNIQUE_VIOLATION = '23505';
const PG_EXCLUSION_VIOLATION = '23P01';
const PG_RESTRICT_VIOLATION = '23001';
const PG_FOREIGN_KEY_VIOLATION = '23503';

const AUDIT_TARGET = 'commercial_outcome_policy_assignment';

export interface AssignOutcomePolicyInput {
  readonly workspaceRef: string;
  readonly policyKey: string;
  readonly selection: BookingOutcomeSelectionV1;
  readonly reason: string;
}

/**
 * The audit record of one selection: flat primitives, because an audit
 * snapshot is a flat map. The key and the four members, nothing else.
 */
function auditSnapshotOf(
  policyKey: string,
  selection: BookingOutcomeSelectionV1,
): Record<string, string | number | null> {
  const late = retentionColumnsOf(selection.lateCancellationRetention);
  const noShow = retentionColumnsOf(selection.noShowRetention);
  return {
    policyKey,
    cutoffHours: selection.cutoffHours,
    lateRetentionKind: late.kind,
    lateRetentionBasisPoints: late.basisPoints,
    lateRetentionAmountToman: late.amountToman,
    noShowGraceMinutes: selection.noShowGraceMinutes,
    noShowRetentionKind: noShow.kind,
    noShowRetentionBasisPoints: noShow.basisPoints,
    noShowRetentionAmountToman: noShow.amountToman,
  };
}

const CURRENT_ASSIGNMENT_COLUMNS = `id, policy_key, cutoff_hours,
       late_retention_kind, late_retention_basis_points, late_retention_amount_toman,
       grace_minutes,
       no_show_retention_kind, no_show_retention_basis_points, no_show_retention_amount_toman,
       assigned_at`;

/**
 * The seller's own booking-outcome selection — V3.3 Story #159 (`#42b`),
 * ADR-051 §3, `V33-DEC-039` R4–R6.
 *
 * #104's `CollectionPolicyAssignmentService`, extended by exactly one idea: a
 * seller chooses a KEY and four MEMBERS inside that key's active version, and
 * every member must be one the administrator published. Everything else —
 * live ownership through the opaque `workspaceRef`, one refusal, an unlocked
 * current read, compare-and-swap supersession with the partial unique index as
 * the arbiter, one audit row in the same transaction — is #104's, deliberately
 * and for #104's recorded reasons.
 *
 * ## The lock order (the #159 preflight's correction to ADR-051's table)
 *
 * Unlocked current read → active version `FOR SHARE` → CAS → insert → audit.
 * ADR-051 listed `FOR SHARE` on the current assignment here; that is the
 * deadlock #104's service documents (two share holders both upgrading for the
 * CAS), and ADR-048 R5 reserves `FOR SHARE` on the assignment for the ORDER
 * reader, which never upgrades.
 *
 * ## Membership is checked twice, and only one of them is the guarantee
 *
 * This service checks the selection against the active version for a readable
 * refusal; `tg_sopa_selection_within_active_version` checks it again on INSERT,
 * which is what makes an out-of-range selection unwritable by any caller.
 */
@Injectable()
export class OutcomePolicyAssignmentService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
    private readonly references: WorkspaceReferenceService,
    @Inject(OWNED_SUBSCRIBER_PARTY_RESOLVER)
    private readonly parties: OwnedSubscriberPartyResolver,
  ) {}

  // =========================================================================
  // Reads
  // =========================================================================

  /**
   * Every key with a version active right now, with the members a seller may
   * choose. **Two statements regardless of how many keys exist**: the keys and
   * their active versions, then every option of those versions at once.
   *
   * The projection is the key, its display name and the four allowed member
   * lists. No version number, administrator window, cap, evidence reference,
   * lifecycle, actor or activation instant leaves this method.
   */
  async assignablePolicies(): Promise<AssignableOutcomePolicyV1[]> {
    const rows: Array<{
      policy_key: string;
      display_name: string;
      version_id: string;
      cutoff_hours_allowed: unknown;
      no_show_grace_minutes_allowed: unknown;
    }> = await this.dataSource.query(
      `SELECT p.policy_key, p.display_name, v.id AS version_id,
              v.cutoff_hours_allowed, v.no_show_grace_minutes_allowed
         FROM commercial.booking_outcome_policies p
         JOIN commercial.booking_outcome_policy_versions v
           ON v.policy_key = p.policy_key
          AND v.lifecycle_state = 'published'
          AND v.activation_starts_at <= now()
          AND (v.activation_ends_at IS NULL OR now() < v.activation_ends_at)
        ORDER BY p.policy_key`,
    );

    // Two active versions for one key is unreachable while the exclusion
    // constraint holds; if it ever happens the key is withheld rather than
    // offered with whichever row came first.
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.policy_key, (counts.get(row.policy_key) ?? 0) + 1);
    const unambiguous = rows.filter((row) => counts.get(row.policy_key) === 1);

    const options = await retentionOptionsFor(
      this.dataSource.manager,
      unambiguous.map((row) => row.version_id),
    );

    return unambiguous.map((row) => ({
      policyKey: row.policy_key,
      displayName: row.display_name,
      allowed: allowedMembersOf(row, options.get(row.version_id)),
    }));
  }

  /**
   * The current selection for one live-owned workspace, or `assignment: null`.
   *
   * `resolvable` answers whether the selection still fits the version active
   * right now. When it is false, governed checkouts for this seller fail closed
   * until they select again (ADR-051 §3) — which is exactly why the seller is
   * told.
   */
  async currentAssignment(userId: string, workspaceRef: string): Promise<OutcomePolicyAssignmentViewV1> {
    return this.dataSource.transaction(async (manager) => {
      const party = await this.requireOwnedWorkspace(manager, userId, workspaceRef);
      const current = await this.currentRow(manager, party);
      if (!current) return { assignment: null };
      return this.viewOf(manager, current);
    });
  }

  // =========================================================================
  // The one mutation
  // =========================================================================

  /**
   * Selects a key and four members, superseding whatever was current.
   *
   *  1. validate the selection's SHAPE (a kind carrying the wrong field is a
   *     refusal before any read);
   *  2. resolve ownership inside the transaction;
   *  3. read the current row WITHOUT a lock;
   *  4. same key and same members → a successful idempotent replay, decided
   *     before the key is required to still be assignable, so a late retry of
   *     a command that succeeded stays a retry;
   *  5. `FOR SHARE` the active version — the retirement boundary — and refuse
   *     any member it does not offer;
   *  6. compare-and-swap the predecessor, insert the successor;
   *  7. one audit row, in the same transaction.
   */
  async assign(userId: string, input: AssignOutcomePolicyInput): Promise<OutcomePolicyAssignmentViewV1> {
    const reason = this.requireReason(input.reason);
    if (validateBookingOutcomeSelectionV1(input.selection).length > 0) {
      throw new OutcomePolicyAssignmentUnavailableException();
    }

    return this.dataSource.transaction(async (manager) => {
      const party = await this.requireOwnedWorkspace(manager, userId, input.workspaceRef);
      const current = await this.currentRow(manager, party);

      if (
        current &&
        current.policy_key === input.policyKey &&
        sameOutcomeSelection(selectionOfRow(current), input.selection)
      ) {
        return this.viewOf(manager, current);
      }

      await this.requireSelectableAndLock(manager, input.policyKey, input.selection);

      const successorId = uuidv7();

      if (current) {
        const superseded = await this.translating(
          () =>
            manager.query(
              `UPDATE commercial.seller_outcome_policy_assignments
                  SET superseded_at = now(),
                      superseded_by_user_id = $1,
                      superseded_by_assignment_id = $2
                WHERE id = $3 AND superseded_at IS NULL`,
              [userId, successorId, current.id],
            ),
          'assignment_conflict',
        );
        // `[rows, affected]` for a raw UPDATE without RETURNING — see #104.
        const affected = Array.isArray(superseded) ? Number(superseded[1] ?? 0) : 0;
        if (affected !== 1) throw new OutcomePolicyAssignmentUnavailableException();
      }

      const late = retentionColumnsOf(input.selection.lateCancellationRetention);
      const noShow = retentionColumnsOf(input.selection.noShowRetention);
      await this.translating(
        () =>
          manager.query(
            `INSERT INTO commercial.seller_outcome_policy_assignments
               (id, seller_party_type, seller_party_id, policy_key,
                cutoff_hours, late_retention_kind, late_retention_basis_points, late_retention_amount_toman,
                grace_minutes, no_show_retention_kind, no_show_retention_basis_points, no_show_retention_amount_toman,
                assigned_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
              successorId,
              party.partyType,
              party.partyId,
              input.policyKey,
              input.selection.cutoffHours,
              late.kind,
              late.basisPoints,
              late.amountToman,
              input.selection.noShowGraceMinutes,
              noShow.kind,
              noShow.basisPoints,
              noShow.amountToman,
              userId,
            ],
          ),
        'assignment_conflict',
      );

      // The selection is the commitment, so it is what the audit records: the
      // key and four structured members. No reference, no party id, no body.
      await this.audit.record(manager, {
        actorUserId: userId,
        action: current ? 'commercial.outcome_policy_assignment_superseded' : 'commercial.outcome_policy_assigned',
        targetType: AUDIT_TARGET,
        targetId: successorId,
        reason,
        before: current ? auditSnapshotOf(current.policy_key, selectionOfRow(current)) : undefined,
        after: auditSnapshotOf(input.policyKey, input.selection),
      });

      const inserted = await this.currentRow(manager, party);
      if (!inserted || inserted.id !== successorId) throw new OutcomePolicyAssignmentUnavailableException();
      return this.viewOf(manager, inserted);
    });
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /** #104's ownership gate, unchanged: enumerate owned parties, match the reference, re-check eligibility. */
  private async requireOwnedWorkspace(
    manager: EntityManager,
    userId: string,
    workspaceRef: string,
  ): Promise<OwnedSubscriberParty> {
    const owned = await this.parties.ownedPartiesFor(manager, userId);
    if (owned.length === 0) throw new OutcomePolicyAssignmentUnavailableException();

    let party: OwnedSubscriberParty;
    try {
      party = this.references.resolve(userId, owned, workspaceRef);
    } catch {
      throw new OutcomePolicyAssignmentUnavailableException();
    }

    if (!(await this.parties.isEligible(manager, party))) {
      throw new OutcomePolicyAssignmentUnavailableException();
    }
    return party;
  }

  /** The current row, read WITHOUT a lock (see the class docblock). */
  private async currentRow(
    manager: EntityManager,
    party: OwnedSubscriberParty,
  ): Promise<CurrentOutcomeAssignmentRow | undefined> {
    const rows: CurrentOutcomeAssignmentRow[] = await manager.query(
      `SELECT ${CURRENT_ASSIGNMENT_COLUMNS}
         FROM commercial.seller_outcome_policy_assignments
        WHERE seller_party_type = $1 AND seller_party_id = $2 AND superseded_at IS NULL`,
      [party.partyType, party.partyId],
    );
    return rows[0];
  }

  /**
   * Locks the version that makes this selection possible, or refuses.
   *
   * `FOR SHARE` is the retirement-race boundary: a retirement waits for this
   * transaction, so a selection is never recorded against a version retired
   * mid-request. The membership check then refuses anything the version does
   * not offer; the insert trigger refuses it again.
   */
  private async requireSelectableAndLock(
    manager: EntityManager,
    policyKey: string,
    selection: BookingOutcomeSelectionV1,
  ): Promise<void> {
    const versions = await activeOutcomeVersions(manager, policyKey, true);
    if (versions.length !== 1) throw new OutcomePolicyAssignmentUnavailableException();

    const options = await retentionOptionsFor(manager, [versions[0].id]);
    const allowed = allowedMembersOf(versions[0], options.get(versions[0].id));
    if (selectionOutsideAllowed(selection, allowed).length > 0) {
      throw new OutcomePolicyAssignmentUnavailableException();
    }
  }

  private async viewOf(
    manager: EntityManager,
    row: CurrentOutcomeAssignmentRow,
  ): Promise<OutcomePolicyAssignmentViewV1> {
    const [policy]: Array<{ display_name: string }> = await manager.query(
      `SELECT display_name FROM commercial.booking_outcome_policies WHERE policy_key = $1`,
      [row.policy_key],
    );
    if (!policy) throw new OutcomePolicyAssignmentUnavailableException();

    const selection = selectionOfRow(row);
    const versions = await activeOutcomeVersions(manager, row.policy_key, false);
    let resolvable = false;
    if (versions.length === 1) {
      const options = await retentionOptionsFor(manager, [versions[0].id]);
      resolvable = selectionOutsideAllowed(selection, allowedMembersOf(versions[0], options.get(versions[0].id))).length === 0;
    }

    return {
      assignment: {
        policyKey: row.policy_key,
        displayName: policy.display_name,
        selection,
        assignedAt: row.assigned_at.toISOString(),
        resolvable,
      },
    };
  }

  private requireReason(reason: string): string {
    if (typeof reason !== 'string') throw new OutcomePolicyAssignmentUnavailableException();
    const trimmed = reason.trim();
    if (
      trimmed.length < OUTCOME_POLICY_ASSIGNMENT_REASON_MIN_LENGTH ||
      trimmed.length > OUTCOME_POLICY_ASSIGNMENT_REASON_MAX_LENGTH
    ) {
      throw new OutcomePolicyAssignmentUnavailableException();
    }
    return trimmed;
  }

  /**
   * #104's translation, unchanged: exactly the four SQLSTATEs this surface can
   * legitimately provoke become the one refusal; anything else is a defect and
   * is re-thrown. The cause never reaches a body.
   */
  private async translating<T>(
    operation: () => Promise<T>,
    _cause: OutcomePolicyAssignmentRefusalCause,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const code = this.pgCode(error);
      if (
        code === PG_UNIQUE_VIOLATION ||
        code === PG_EXCLUSION_VIOLATION ||
        code === PG_RESTRICT_VIOLATION ||
        code === PG_FOREIGN_KEY_VIOLATION
      ) {
        throw new OutcomePolicyAssignmentUnavailableException();
      }
      throw error;
    }
  }

  private pgCode(error: unknown): string | undefined {
    const candidate = error as { code?: unknown; driverError?: { code?: unknown } } | null;
    const direct = candidate?.code;
    if (typeof direct === 'string') return direct;
    const driver = candidate?.driverError?.code;
    return typeof driver === 'string' ? driver : undefined;
  }
}
