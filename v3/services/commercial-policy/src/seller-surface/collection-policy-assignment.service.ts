import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import {
  AssignableCollectionPolicyV1,
  CollectionPolicyAssignmentRefusalCause,
  CollectionPolicyAssignmentViewV1,
} from '@beauclick/commercial-policy-contract';

import {
  OWNED_SUBSCRIBER_PARTY_RESOLVER,
  OwnedSubscriberParty,
  OwnedSubscriberPartyResolver,
} from '../subscription/owned-subscriber-party.port';
import { WorkspaceReferenceService } from './workspace-reference';
import { CollectionPolicyAssignmentUnavailableException } from './collection-policy-assignment.exceptions';
import { SellerCollectionPolicyAssignmentEntity } from './collection-policy-assignment.entities';

const PG_UNIQUE_VIOLATION = '23505';
const PG_EXCLUSION_VIOLATION = '23P01';
const PG_RESTRICT_VIOLATION = '23001';
const PG_FOREIGN_KEY_VIOLATION = '23503';

const AUDIT_TARGET = 'commercial_collection_policy_assignment';

/** What the caller asked for, once ownership and the key shape are already known good. */
export interface AssignCollectionPolicyInput {
  readonly workspaceRef: string;
  readonly policyKey: string;
  readonly reason: string;
}

/**
 * The seller's own collection-policy surface — V3.3 Story #104 (`#41d-2a`).
 *
 * ## Why this is not a method on `BookingCollectionPolicyService`
 *
 * That service is the **privileged administrator writer**: every method takes
 * an `actorUserId` with `bc_manage_commercial_plans` behind it and publishes or
 * retires a version. This one is reached by a seller with a non-privileged
 * capability and can only ever choose among what that writer already published.
 * Merging them would put two authorization surfaces in one class and hand a
 * seller route an autocomplete away from `publishVersion`. ADR-048 R4 draws the
 * same line for #115's runtime resolver, and `SellerSubscriptionSurfaceModule`
 * already draws it for plans.
 *
 * ## Ownership is resolved live, inside the caller's transaction, every request
 *
 * The capability gates the mutation; **ownership decides which workspace**. A
 * caller holding `bc_manage_own_collection_policy` who owns no matching party
 * reaches nothing, because `ownedPartiesFor` returns them nothing — not because
 * a check refused them. `business_staff` is never followed: an affiliated
 * professional owns neither party, which is the structural half of the
 * guarantee `OwnedSubscriberPartyResolver`'s docblock records.
 *
 * ## One refusal, always
 *
 * Every failure — malformed, foreign or stale reference, no owned party, an
 * unavailable key, no active version, a concurrent retirement, a lost
 * compare-and-swap — raises the same
 * `CollectionPolicyAssignmentUnavailableException`. The workspace resolver's own
 * subscription-shaped refusal is caught and re-thrown as this one, because two
 * different bodies on the same surface would be the enumeration oracle both
 * refusals exist to prevent.
 */
@Injectable()
export class CollectionPolicyAssignmentService {
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
   * The policies this seller could choose right now.
   *
   * **One query regardless of how many policies exist.** The join is what makes
   * "assignable" a database question rather than a loop: a key is assignable
   * exactly when it has a version that is `published` and whose activation
   * window contains the statement's own `now()`. `ex_bcpv_no_effective_overlap`
   * guarantees at most one such version per key, so `DISTINCT` is a statement of
   * that invariant rather than a defence against duplicates.
   *
   * The projection is two columns. No version, terms, mode, amount, percentage,
   * base, window, lifecycle, actor or retirement internal leaves this method.
   */
  async assignablePolicies(): Promise<AssignableCollectionPolicyV1[]> {
    const rows: Array<{ policy_key: string; display_name: string }> = await this.dataSource.query(
      `SELECT DISTINCT p.policy_key, p.display_name
         FROM commercial.booking_collection_policies p
         JOIN commercial.booking_collection_policy_versions v
           ON v.policy_key = p.policy_key
          AND v.lifecycle_state = 'published'
          AND v.activation_starts_at <= now()
          AND (v.activation_ends_at IS NULL OR now() < v.activation_ends_at)
        ORDER BY p.policy_key`,
    );

    return rows.map((row) => ({ policyKey: row.policy_key, displayName: row.display_name }));
  }

  /**
   * The current assignment for one live-owned workspace, or `null`.
   *
   * Side-effect free, and `assignment: null` is a **successful** answer: an
   * unenrolled workspace is a first-class state (ADR-048 R2), not an error and
   * not an invitation to auto-create anything.
   */
  async currentAssignment(userId: string, workspaceRef: string): Promise<CollectionPolicyAssignmentViewV1> {
    return this.dataSource.transaction(async (manager) => {
      const party = await this.requireOwnedWorkspace(manager, userId, workspaceRef);

      const rows: Array<{ policy_key: string; display_name: string; assigned_at: Date }> = await manager.query(
        `SELECT a.policy_key, p.display_name, a.assigned_at
           FROM commercial.seller_collection_policy_assignments a
           JOIN commercial.booking_collection_policies p ON p.policy_key = a.policy_key
          WHERE a.seller_party_type = $1 AND a.seller_party_id = $2 AND a.superseded_at IS NULL`,
        [party.partyType, party.partyId],
      );

      const current = rows[0];
      if (!current) return { assignment: null };

      return {
        assignment: {
          policyKey: current.policy_key,
          displayName: current.display_name,
          assignedAt: current.assigned_at.toISOString(),
        },
      };
    });
  }

  // =========================================================================
  // The one mutation
  // =========================================================================

  /**
   * Assigns a policy to a workspace, superseding whatever was current.
   *
   * The order of operations is the contract, and each step exists because of a
   * specific race:
   *
   *  1. resolve ownership **inside** the transaction, so a party sold or
   *     deleted mid-request stops resolving;
   *  2. read and `FOR SHARE`-lock the current assignment (ADR-048 R5), so a
   *     concurrent supersession waits rather than interleaving;
   *  3. **if the same key is already current, return it as a successful
   *     idempotent replay** — no new row, no audit row. This is checked BEFORE
   *     the key is required to still be assignable, so retrying a command that
   *     already succeeded stays a retry even if the policy has since been
   *     retired. Rewriting history because a replay arrived late would be the
   *     opposite of idempotent;
   *  4. `FOR SHARE`-lock the selected published version, which is the
   *     retirement-race boundary — a retirement is an `UPDATE` of that row and
   *     therefore waits;
   *  5. first assignment inserts one current row; supersession pre-generates
   *     the successor id, compare-and-swaps the old row, then inserts the
   *     successor using the deferred self-reference;
   *  6. exactly one audit row, in the same transaction.
   */
  async assign(userId: string, input: AssignCollectionPolicyInput): Promise<CollectionPolicyAssignmentViewV1> {
    const reason = this.requireReason(input.reason);

    return this.dataSource.transaction(async (manager) => {
      const party = await this.requireOwnedWorkspace(manager, userId, input.workspaceRef);

      // (2) The current row, locked. `FOR SHARE` and not `FOR UPDATE`: this
      // request may supersede it, but a concurrent reader must not be blocked
      // from seeing it, and the compare-and-swap below is what actually decides
      // the write.
      const currentRows: Array<{ id: string; policy_key: string; assigned_at: Date }> = await manager.query(
        `SELECT id, policy_key, assigned_at
           FROM commercial.seller_collection_policy_assignments
          WHERE seller_party_type = $1 AND seller_party_id = $2 AND superseded_at IS NULL
          FOR SHARE`,
        [party.partyType, party.partyId],
      );
      const current = currentRows[0];

      // (3) Idempotent replay, decided before assignability is re-required.
      if (current && current.policy_key === input.policyKey) {
        return this.viewOf(manager, current.policy_key, current.assigned_at);
      }

      // (4) The selected version, locked. This is the retirement boundary.
      await this.requireAssignableAndLock(manager, input.policyKey);

      const successorId = uuidv7();

      if (current) {
        // (5) Supersession: compare-and-swap, then insert the successor. The
        // predecessor names an id that does not exist yet; the deferred
        // self-FK is checked at COMMIT, by which point both rows exist.
        const superseded = await this.translating(
          () =>
            manager.query(
              `UPDATE commercial.seller_collection_policy_assignments
                  SET superseded_at = now(),
                      superseded_by_user_id = $1,
                      superseded_by_assignment_id = $2
                WHERE id = $3 AND superseded_at IS NULL`,
              [userId, successorId, current.id],
            ),
          'assignment_conflict',
        );

        // TypeORM returns `[rows, affected]` for a raw UPDATE; `rows` is empty
        // without RETURNING, so the affected count is the second element.
        // Reading `result.length` here would always be 2 and would silently
        // accept a lost race.
        const affected = Array.isArray(superseded) ? Number(superseded[1] ?? 0) : 0;
        if (affected !== 1) throw new CollectionPolicyAssignmentUnavailableException();
      }

      await this.translating(
        () =>
          manager.query(
            `INSERT INTO commercial.seller_collection_policy_assignments
               (id, seller_party_type, seller_party_id, policy_key, assigned_by_user_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [successorId, party.partyType, party.partyId, input.policyKey, userId],
          ),
        'assignment_conflict',
      );

      // (6) One audit row per real mutation, in this transaction. No policy
      // terms and no money — the key is an identifier, not a value.
      await this.audit.record(manager, {
        actorUserId: userId,
        action: current
          ? 'commercial.collection_policy_assignment_superseded'
          : 'commercial.collection_policy_assigned',
        targetType: AUDIT_TARGET,
        targetId: successorId,
        reason,
        before: current ? { policyKey: current.policy_key } : undefined,
        after: { policyKey: input.policyKey },
      });

      const [inserted]: Array<{ assigned_at: Date }> = await manager.query(
        `SELECT assigned_at FROM commercial.seller_collection_policy_assignments WHERE id = $1`,
        [successorId],
      );
      return this.viewOf(manager, input.policyKey, inserted.assigned_at);
    });
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * The live-ownership gate, and the single place the workspace reference is
   * turned into a party.
   *
   * Nothing is looked up FROM the reference: the caller's currently-owned
   * parties are enumerated first, candidate references are recomputed
   * server-side, and the supplied value is matched in constant time. A dual
   * owner therefore holds two isolated workspaces, and `parties[0]` is never
   * chosen for anybody.
   *
   * The resolver's own `SubscriptionSellerNotEligibleException` is converted
   * here so this surface presents exactly one refusal.
   */
  private async requireOwnedWorkspace(
    manager: EntityManager,
    userId: string,
    workspaceRef: string,
  ): Promise<OwnedSubscriberParty> {
    const owned = await this.parties.ownedPartiesFor(manager, userId);
    if (owned.length === 0) throw new CollectionPolicyAssignmentUnavailableException();

    let party: OwnedSubscriberParty;
    try {
      party = this.references.resolve(userId, owned, workspaceRef);
    } catch {
      throw new CollectionPolicyAssignmentUnavailableException();
    }

    if (!(await this.parties.isEligible(manager, party))) {
      throw new CollectionPolicyAssignmentUnavailableException();
    }
    return party;
  }

  /**
   * Locks the version that makes this key assignable, or refuses.
   *
   * `FOR SHARE` on the version row is the retirement-race boundary ADR-048 R5
   * names: retirement is an `UPDATE` of `lifecycle_state`/`retired_at` on that
   * row, so it waits until this transaction ends. A read-then-write existence
   * check would let a retirement land between the check and the insert.
   */
  private async requireAssignableAndLock(manager: EntityManager, policyKey: string): Promise<void> {
    const rows: Array<{ id: string }> = await manager.query(
      `SELECT v.id
         FROM commercial.booking_collection_policy_versions v
        WHERE v.policy_key = $1
          AND v.lifecycle_state = 'published'
          AND v.activation_starts_at <= now()
          AND (v.activation_ends_at IS NULL OR now() < v.activation_ends_at)
        FOR SHARE`,
      [policyKey],
    );

    if (rows.length === 0) throw new CollectionPolicyAssignmentUnavailableException();
  }

  private async viewOf(
    manager: EntityManager,
    policyKey: string,
    assignedAt: Date,
  ): Promise<CollectionPolicyAssignmentViewV1> {
    const [policy]: Array<{ display_name: string }> = await manager.query(
      `SELECT display_name FROM commercial.booking_collection_policies WHERE policy_key = $1`,
      [policyKey],
    );
    if (!policy) throw new CollectionPolicyAssignmentUnavailableException();

    return {
      assignment: { policyKey, displayName: policy.display_name, assignedAt: assignedAt.toISOString() },
    };
  }

  private requireReason(reason: string): string {
    if (typeof reason !== 'string') throw new CollectionPolicyAssignmentUnavailableException();
    const trimmed = reason.trim();
    if (trimmed.length < 3 || trimmed.length > 500) {
      throw new CollectionPolicyAssignmentUnavailableException();
    }
    return trimmed;
  }

  /**
   * Turns a database refusal into the one public one.
   *
   * Only the four SQLSTATEs this surface can legitimately provoke are
   * translated; anything else is re-thrown unchanged, because a `not_null` or
   * `check_violation` from a shape the service should have validated is a
   * defect, and dressing it as an expected conflict is how such a defect stays
   * invisible. The `cause` is for metrics and audit and never reaches a body.
   */
  private async translating<T>(
    operation: () => Promise<T>,
    _cause: CollectionPolicyAssignmentRefusalCause,
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
        throw new CollectionPolicyAssignmentUnavailableException();
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
