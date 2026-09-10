import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AdminAuditService } from '@beauclick/audit';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import { WORKSPACE_REFERENCE_SECRET, deriveLocationReference, resolveLocationReference } from '@beauclick/workspace-reference';

import {
  AUDIT_TARGET_STAFF_LOCATION,
  STAFF_LOCATION_AUDIT_ACTIONS,
  STAFF_LOCATION_AUDIT_REASONS,
  StaffLocationAuditAction,
} from './staff-location.audit';
import { SetStaffLocationDto } from './dto/staff-location.dto';

/**
 * What an owner sees back: the membership's branch as an opaque reference, or
 * null. Exactly one field -- no raw location id, no name, no city, no lifecycle,
 * no membership id and no actor.
 */
export interface StaffLocationView {
  readonly locationRef: string | null;
}

interface OwnedMembershipRow {
  readonly id: string;
  readonly locationId: string | null;
}

/**
 * The owner's binding of a consented membership to a branch -- V3.3 Story #127
 * (`#127a`), bound by `V33-DEC-035` R2.
 *
 * ## Owner-only, re-checked inside the transaction
 *
 * The route is guarded by `@ResolveOwner(BusinessOwnerResolver)`, but that runs
 * outside this transaction, so live ownership is re-read here with a row lock --
 * the same shape `BusinessLocationService` and `StaffGrantService` already use. A
 * manager, an ordinary staff member, a `practitioner_chat` holder, the member
 * themselves and a stranger all fail the guard and, were they to reach this
 * service, fail here too.
 *
 * **The binding confers no authority.** It records WHERE a member works, never
 * WHAT they may do: no role is written, no capability minted, and
 * `SCOPED_STAFF_ROLES` is untouched.
 *
 * ## One refusal shape
 *
 * A missing, soft-deleted or foreign business; a missing or foreign membership; a
 * malformed, stale, foreign, suspended or closed `locationRef` -- every
 * non-syntactic cause raises the platform's single `NotFoundOrNotYoursException`.
 * The owner learns nothing about which it was.
 *
 * ## Idempotency is explicit, not accidental
 *
 * Assigning the branch a membership already has, and clearing one that is already
 * null, are unchanged successes that write **no row and no audit**. That is a
 * deliberate choice rather than a side effect of an UPDATE affecting zero rows:
 * an audit trail recording "assigned the branch they were already at" on every
 * retry would bury the real changes, and the conditional UPDATE below is what
 * makes the no-op observable rather than merely harmless.
 */
@Injectable()
export class StaffLocationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
    /**
     * The SAME secret the workspace, location and resource references use
     * (`V33-DEC-020` -- no second secret). This story creates no new reference
     * kind: it reuses `deriveLocationReference` unchanged, so #108's golden
     * vectors stay byte-identical.
     */
    @Inject(WORKSPACE_REFERENCE_SECRET) private readonly referenceSecret: string,
  ) {}

  /**
   * The membership's branch, as a reference.
   *
   * **A read never writes.** It runs on the plain manager -- no transaction, no
   * row lock -- and relies on the `@ResolveOwner` guard every caller passes
   * through, exactly as the classification, location and resource reads do.
   */
  async read(businessId: string, ownerUserId: string, membershipId: string): Promise<StaffLocationView> {
    const manager = this.dataSource.manager;
    const membership = await this.findOwnedMembership(manager, businessId, ownerUserId, membershipId, false);
    return this.view(ownerUserId, businessId, membership.locationId);
  }

  /**
   * Assigns a branch, or clears it with `null`.
   *
   * The whole operation is one transaction: live ownership, the membership row
   * lock, the reference resolution, the target's lifecycle check, the UPDATE and
   * the audit row all commit together or not at all.
   *
   * The UPDATE is a **compare-and-swap on the observed value**, not a blind
   * write: two concurrent assignments therefore serialise on the membership's row
   * lock, and the loser's statement no longer matches, so the committed value is
   * always the complete result of exactly one transaction rather than whichever
   * statement happened to run last.
   */
  async set(
    businessId: string,
    ownerUserId: string,
    membershipId: string,
    dto: SetStaffLocationDto,
  ): Promise<StaffLocationView> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertLiveOwnedBusiness(manager, businessId, ownerUserId);
      const membership = await this.findOwnedMembership(manager, businessId, ownerUserId, membershipId, true);

      const target = dto.locationRef === null ? null : await this.resolveAssignableLocation(manager, businessId, ownerUserId, dto.locationRef);

      // Idempotent: the branch it already has (or already lacks) churns no row
      // and writes no audit.
      if (membership.locationId === target) {
        return this.view(ownerUserId, businessId, membership.locationId);
      }

      const result = await manager.query(
        `UPDATE business.business_staff
            SET location_id = $1, updated_at = now()
          WHERE id = $2 AND location_id IS NOT DISTINCT FROM $3`,
        [target, membership.id, membership.locationId],
      );
      if (rowCount(result) !== 1) throw new NotFoundOrNotYoursException();

      const assigning = target !== null;
      await this.recordAudit(
        manager,
        ownerUserId,
        membership.id,
        assigning ? STAFF_LOCATION_AUDIT_ACTIONS.assigned : STAFF_LOCATION_AUDIT_ACTIONS.cleared,
        assigning ? STAFF_LOCATION_AUDIT_REASONS.assignedByOwner : STAFF_LOCATION_AUDIT_REASONS.clearedByOwner,
        { before: { locationId: membership.locationId }, after: { locationId: target } },
      );

      return this.view(ownerUserId, businessId, target);
    });
  }

  // -------------------------------------------------------------------------

  /**
   * The live-owner predicate, re-checked inside the mutating transaction.
   *
   * `FOR NO KEY UPDATE` rather than `FOR UPDATE`, which would conflict with the
   * `FOR KEY SHARE` PostgreSQL takes on the parent when a child row referencing
   * it is written.
   */
  private async assertLiveOwnedBusiness(manager: EntityManager, businessId: string, ownerUserId: string): Promise<void> {
    const rows: unknown[] = await manager.query(
      `SELECT id FROM business.businesses WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR NO KEY UPDATE`,
      [businessId, ownerUserId],
    );
    if (rows.length === 0) throw new NotFoundOrNotYoursException();
  }

  /**
   * The membership an owner may act on, or the one refusal.
   *
   * Live owned business and a membership of THAT business, in one statement, so
   * no caller can satisfy one without the other. `lock` takes `FOR UPDATE` on the
   * membership row itself -- the row this operation mutates -- which is what
   * serialises a concurrent rebinding against a concurrent slot creation reading
   * the same row.
   *
   * Every membership status is addressable, deliberately. An owner assigning a
   * branch to a member who is currently `invited` is ordinary onboarding; what
   * decides whether a slot inherits the branch is the ACTIVE check in the
   * delivery-location resolver, not this one.
   */
  private async findOwnedMembership(
    manager: EntityManager,
    businessId: string,
    ownerUserId: string,
    membershipId: string,
    lock: boolean,
  ): Promise<OwnedMembershipRow> {
    const rows: Array<{ id: string; location_id: string | null }> = await manager.query(
      `SELECT s.id, s.location_id
         FROM business.business_staff s
         JOIN business.businesses b ON b.id = s.business_id
        WHERE s.id = $1
          AND s.business_id = $2
          AND b.owner_id = $3
          AND b.deleted_at IS NULL${lock ? '\n        FOR UPDATE OF s' : ''}`,
      [membershipId, businessId, ownerUserId],
    );
    if (rows.length === 0) throw new NotFoundOrNotYoursException();
    return { id: rows[0].id, locationId: rows[0].location_id };
  }

  /**
   * The live-owned, **active** location a reference names.
   *
   * Only an `active` branch may be newly assigned: binding staff to a suspended
   * or closed branch would publish availability somewhere the organisation has
   * said is not operating. A suspended or closed reference refuses with the same
   * shape as a stale or foreign one.
   *
   * Enumerate-and-compare, never a query BY the reference (ADR-049 §3.4), so a
   * `locationRef` authorises nothing on its own.
   */
  private async resolveAssignableLocation(
    manager: EntityManager,
    businessId: string,
    ownerUserId: string,
    locationRef: string,
  ): Promise<string> {
    const rows: Array<{ id: string }> = await manager.query(
      `SELECT l.id
         FROM business.locations l
         JOIN business.businesses b ON b.id = l.business_id
        WHERE l.business_id = $1 AND b.owner_id = $2 AND b.deleted_at IS NULL AND l.lifecycle = 'active'
        ORDER BY l.id`,
      [businessId, ownerUserId],
    );

    const match = resolveLocationReference(
      this.referenceSecret,
      ownerUserId,
      rows.map((row) => ({ businessId, locationId: row.id })),
      locationRef,
    );
    if (!match) throw new NotFoundOrNotYoursException();
    return match.locationId;
  }

  private view(ownerUserId: string, businessId: string, locationId: string | null): StaffLocationView {
    return {
      locationRef: locationId === null ? null : deriveLocationReference(this.referenceSecret, ownerUserId, businessId, locationId),
    };
  }

  private async recordAudit(
    manager: EntityManager,
    actorUserId: string,
    membershipId: string,
    action: StaffLocationAuditAction,
    reason: string,
    states: { before: { locationId: string | null }; after: { locationId: string | null } },
  ): Promise<void> {
    await this.audit.record(manager, {
      actorUserId,
      action,
      targetType: AUDIT_TARGET_STAFF_LOCATION,
      targetId: membershipId,
      before: states.before,
      after: states.after,
      reason,
    });
  }
}

/** TypeORM's raw query path returns `[rows, rowCount]` for INSERT/UPDATE/DELETE. */
function rowCount(result: unknown): number {
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}
