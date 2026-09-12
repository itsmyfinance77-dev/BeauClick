import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { BusinessScopedRole, PractitionerScopedRole } from './entities/staff-role-grant.entity';
import { ScopedStaffAuthorityRequest, ScopedStaffAuthorizerPort } from './ports';

/**
 * The live scoped-authority verifier -- V3.3 Story #109 (`#44c`).
 *
 * ## Why the implementation lives in `business` while the token is bound at the root
 *
 * Every fact it reads -- the business, the membership, the grant -- is a
 * `business` table, so there is no cross-domain read to compose and no reason to
 * reimplement one elsewhere. What the composition root binds is the **token**, so
 * a consumer such as chat's seller-access adapter can ask the question without
 * importing a `business` ORM entity. Two implementations of "does this person
 * hold this authority" would be two answers to a question that must have exactly
 * one.
 *
 * ## Four conditions, one statement, every time -- on each of two axes
 *
 * ADR-049 section 4.3 and `V33-DEC-033` R2/R5. The join is deliberately a single
 * query rather than four reads: a caller cannot satisfy three conditions and
 * forget the fourth, and there is no intermediate result anybody could cache.
 * Nothing here is memoised, and nothing is ever written into a token claim -- so
 * a revoked grant, a deactivated membership, a soft-deleted business or a broken
 * practitioner link all deny on the **next** request rather than at token expiry.
 *
 * V3.3 #111 added the BUSINESS-SCOPED axis (`finance_read`), which shares the
 * first three conditions -- live business, `active` membership, unrevoked grant
 * of the named role, same business on both rows -- and deliberately omits the
 * fourth: a bookkeeper has no professional link and the authority does not
 * depend on one. The two predicates are two constants below rather than one
 * with a branch, so the practitioner one is byte-identical to what #109
 * shipped and neither can silently acquire the other's condition.
 *
 * `s.business_id = g.business_id` is asserted in the join even though
 * `fk_staff_role_grants_membership_same_business` already guarantees it. The
 * database is the arbiter; this is the second lock on the same door, and it costs
 * nothing.
 *
 * ## Every method takes the caller's `EntityManager`
 *
 * Chat re-evaluates seller access inside its send transaction. Holding a
 * repository here would take a second pool connection while that transaction
 * already holds one -- the exhaustion `chat.ports.ts` documents from its own
 * concurrency case. This class holds no repository and no DataSource at all,
 * which makes that failure unrepresentable rather than merely discouraged.
 */
@Injectable()
export class BusinessScopedStaffAuthorizer implements ScopedStaffAuthorizerPort {
  /**
   * The PRACTITIONER predicate, shared by the three practitioner reads so they
   * cannot drift apart. Byte-identical to #109.
   *
   * Live business, `active` membership, non-null practitioner link, unrevoked
   * grant, and the membership and grant naming the same business.
   */
  private readonly liveAuthoritySql = `
      FROM business.staff_role_grants g
      JOIN business.business_staff s
        ON s.id = g.membership_id AND s.business_id = g.business_id
      JOIN business.businesses b
        ON b.id = g.business_id
     WHERE g.revoked_at IS NULL
       AND g.role = $1
       AND s.status = 'active'
       AND s.professional_id IS NOT NULL
       AND b.deleted_at IS NULL
  `;

  async hasLiveScopedAuthority(manager: EntityManager, request: ScopedStaffAuthorityRequest): Promise<boolean> {
    const rows: unknown[] = await manager.query(
      `SELECT 1 ${this.liveAuthoritySql}
         AND g.business_id = $2
         AND s.user_id = $3
         AND s.professional_id = $4
       LIMIT 1`,
      [request.role, request.businessId, request.userId, request.professionalId],
    );
    return rows.length > 0;
  }

  async liveScopedAuthorities(
    manager: EntityManager,
    userId: string,
    role: PractitionerScopedRole,
  ): Promise<readonly { readonly businessId: string; readonly professionalId: string }[]> {
    const rows: Array<{ business_id: string; professional_id: string }> = await manager.query(
      `SELECT g.business_id, s.professional_id ${this.liveAuthoritySql}
         AND s.user_id = $2
       ORDER BY g.business_id`,
      [role, userId],
    );
    return rows.map((row) => ({ businessId: row.business_id, professionalId: row.professional_id }));
  }

  async usersWithLiveScopedAuthority(
    manager: EntityManager,
    role: PractitionerScopedRole,
    businessId: string,
    professionalId: string,
  ): Promise<readonly string[]> {
    const rows: Array<{ user_id: string }> = await manager.query(
      `SELECT DISTINCT s.user_id ${this.liveAuthoritySql}
         AND g.business_id = $2
         AND s.professional_id = $3`,
      [role, businessId, professionalId],
    );
    return rows.map((row) => row.user_id);
  }

  /**
   * The BUSINESS-SCOPED predicate -- V3.3 #111 (`#44e`), ADR-049 section 5.4.
   *
   * Live business, `active` membership, unrevoked grant of the named role, and
   * the membership and grant naming the same business. **No professional link**:
   * see the class note. `s.business_id = g.business_id` is asserted here too,
   * for the same second-lock reason as above.
   */
  private readonly liveBusinessScopedSql = `
      FROM business.staff_role_grants g
      JOIN business.business_staff s
        ON s.id = g.membership_id AND s.business_id = g.business_id
      JOIN business.businesses b
        ON b.id = g.business_id
     WHERE g.revoked_at IS NULL
       AND g.role = $1
       AND s.status = 'active'
       AND b.deleted_at IS NULL
  `;

  async liveBusinessScopedGrants(
    manager: EntityManager,
    userId: string,
    role: BusinessScopedRole,
  ): Promise<readonly { readonly businessId: string }[]> {
    const rows: Array<{ business_id: string }> = await manager.query(
      `SELECT DISTINCT g.business_id ${this.liveBusinessScopedSql}
         AND s.user_id = $2
       ORDER BY g.business_id`,
      [role, userId],
    );
    return rows.map((row) => ({ businessId: row.business_id }));
  }
}
