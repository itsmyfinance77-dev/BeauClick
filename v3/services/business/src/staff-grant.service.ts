import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';

import { ScopedStaffRole } from './entities/staff-role-grant.entity';
import { returnedRows } from './sql-result';
import {
  AUDIT_TARGET_STAFF_ROLE_GRANT,
  STAFF_AUTHORITY_AUDIT_ACTIONS,
  STAFF_AUTHORITY_AUDIT_REASONS,
} from './staff-authority.audit';

/** What an owner sees back: the live scoped roles of one membership, and nothing else. */
export interface MembershipGrantView {
  readonly roles: readonly ScopedStaffRole[];
}

interface GrantableMembership {
  readonly id: string;
  readonly businessId: string;
}

/**
 * Owner-only grant and revoke of scoped staff authority -- V3.3 Story #109
 * (`#44c`), bound by `V33-DEC-033` and ADR-049 section 4.
 *
 * ## Only the live owner, re-checked inside the transaction
 *
 * The route is guarded by `@ResolveOwner(BusinessOwnerResolver)`, but that runs
 * outside this transaction. A business soft-deleted between the guard and here
 * must not be mutated, so ownership is re-read here with a row lock -- the same
 * shape `BusinessClassificationService.replace` and `BusinessLocationService`
 * already use. A manager, a staff member, the grantee themselves and a stranger
 * all fail the guard and, were they to reach this service, fail here too.
 *
 * ## The target must be a CONSENTED, professional-linked, active membership
 *
 * ADR-049 section 4.2: anchoring on `business_staff.id` is what keeps consent
 * structural. A membership that is `invited`, `inactive`, `declined` or `removed`
 * cannot be granted, and one whose `professional_id` is null cannot either --
 * because `practitioner_chat` is checked against that link, so a grant without it
 * could never authorize anything and would be an authority-shaped row that means
 * nothing.
 *
 * ## One refusal shape
 *
 * A missing, foreign or soft-deleted business; a missing, foreign, non-active or
 * professional-less membership; a role outside the vocabulary already refused by
 * the DTO -- every non-syntactic cause raises the platform's single
 * `NotFoundOrNotYoursException`. The owner learns nothing about which it was.
 */
@Injectable()
export class StaffGrantService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * The live scoped roles of one membership.
   *
   * **A read never writes.** No lock, no lazy row, no repair. It runs on the
   * plain manager and relies on the `@ResolveOwner` guard for the live-ownership
   * refusal, exactly as the classification and location reads do.
   */
  async list(businessId: string, ownerUserId: string, membershipId: string): Promise<MembershipGrantView> {
    const manager = this.dataSource.manager;
    const membership = await this.findGrantableMembership(manager, businessId, ownerUserId, membershipId);
    return { roles: await this.liveRoles(manager, membership) };
  }

  /**
   * Grants `role`, idempotently.
   *
   * `ON CONFLICT … DO NOTHING` against the partial live-uniqueness index is what
   * makes a replay and a genuine race the same thing: exactly one live row
   * survives, the loser writes nothing, and PostgreSQL's `23505` never escapes as
   * an untranslated error. A no-op writes **no** audit row -- an audit trail that
   * logged "granted the grant they already hold" on every retry would make the
   * real changes harder to find.
   */
  async grant(
    businessId: string,
    ownerUserId: string,
    membershipId: string,
    role: ScopedStaffRole,
  ): Promise<MembershipGrantView> {
    return this.dataSource.transaction(async (manager) => {
      const membership = await this.findGrantableMembership(manager, businessId, ownerUserId, membershipId, true);

      const id = uuidv7();
      // `RETURNING id` is load-bearing, not decoration: an INSERT hands back a
      // bare rows array with no count, so the only honest test of "did this
      // write?" is a row that came back. See `sql-result.ts`.
      const inserted = returnedRows(
        await manager.query(
          `INSERT INTO business.staff_role_grants (id, membership_id, business_id, role, granted_by_user_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (membership_id, role, business_id) WHERE revoked_at IS NULL DO NOTHING
           RETURNING id`,
          [id, membership.id, membership.businessId, role, ownerUserId],
        ),
      );

      if (inserted.length === 1) {
        await this.audit.record(manager, {
          actorUserId: ownerUserId,
          action: STAFF_AUTHORITY_AUDIT_ACTIONS.granted,
          targetType: AUDIT_TARGET_STAFF_ROLE_GRANT,
          targetId: id,
          before: null,
          after: { role, live: true },
          reason: STAFF_AUTHORITY_AUDIT_REASONS.grantedByOwner,
        });
      }

      return { roles: await this.liveRoles(manager, membership) };
    });
  }

  /**
   * Revokes `role`, one-way and idempotently.
   *
   * The conditional `UPDATE` is the compare-and-swap: only a row that is still
   * live is stamped, so two concurrent revokes produce one audit row and one
   * revocation instant. A grant that is already revoked -- and one that was never
   * held -- are both unchanged successes writing no row and no audit, which is
   * also what keeps the two indistinguishable to the caller.
   *
   * The row is never deleted; `tg_staff_role_grants_immutable` refuses that, and
   * the revoked row is the record that the authority existed and ended.
   */
  async revoke(
    businessId: string,
    ownerUserId: string,
    membershipId: string,
    role: ScopedStaffRole,
  ): Promise<MembershipGrantView> {
    return this.dataSource.transaction(async (manager) => {
      const membership = await this.findGrantableMembership(manager, businessId, ownerUserId, membershipId, true);

      const revoked = returnedRows<{ id: string }>(
        await manager.query(
          `UPDATE business.staff_role_grants
              SET revoked_at = now(), revoked_by_user_id = $1
            WHERE membership_id = $2 AND business_id = $3 AND role = $4 AND revoked_at IS NULL
            RETURNING id`,
          [ownerUserId, membership.id, membership.businessId, role],
        ),
      );

      if (revoked.length === 1) {
        await this.audit.record(manager, {
          actorUserId: ownerUserId,
          action: STAFF_AUTHORITY_AUDIT_ACTIONS.revoked,
          targetType: AUDIT_TARGET_STAFF_ROLE_GRANT,
          targetId: revoked[0].id,
          before: { role, live: true },
          after: { role, live: false },
          reason: STAFF_AUTHORITY_AUDIT_REASONS.revokedByOwner,
        });
      }

      return { roles: await this.liveRoles(manager, membership) };
    });
  }

  // -------------------------------------------------------------------------

  /**
   * The membership an owner may act on, or the one refusal.
   *
   * Live business owned by this session, `active` membership of THAT business,
   * and a non-null professional link -- all in one statement, so no caller can
   * satisfy two of the three. `lock` takes `FOR NO KEY UPDATE` on the business
   * row for the mutating paths (not `FOR UPDATE`, which would conflict with the
   * `FOR KEY SHARE` PostgreSQL takes on the parent when a child grant row is
   * inserted).
   */
  private async findGrantableMembership(
    manager: EntityManager,
    businessId: string,
    ownerUserId: string,
    membershipId: string,
    lock = false,
  ): Promise<GrantableMembership> {
    const rows: Array<{ id: string; business_id: string }> = await manager.query(
      `SELECT s.id, s.business_id
         FROM business.business_staff s
         JOIN business.businesses b ON b.id = s.business_id
        WHERE s.id = $1
          AND s.business_id = $2
          AND s.status = 'active'
          AND s.professional_id IS NOT NULL
          AND b.owner_id = $3
          AND b.deleted_at IS NULL${lock ? '\n        FOR NO KEY UPDATE OF b' : ''}`,
      [membershipId, businessId, ownerUserId],
    );
    if (rows.length === 0) throw new NotFoundOrNotYoursException();
    return { id: rows[0].id, businessId: rows[0].business_id };
  }

  /** The membership's live roles, deterministically ordered. No actor identity, no ids, no timestamps. */
  private async liveRoles(manager: EntityManager, membership: GrantableMembership): Promise<ScopedStaffRole[]> {
    const rows: Array<{ role: ScopedStaffRole }> = await manager.query(
      `SELECT role FROM business.staff_role_grants
        WHERE membership_id = $1 AND business_id = $2 AND revoked_at IS NULL
        ORDER BY role`,
      [membership.id, membership.businessId],
    );
    return rows.map((row) => row.role);
  }
}
