import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { BusinessStaffRole, BusinessStaffStatus } from './entities/business-staff.entity';
import { ScopedStaffRole } from './entities/staff-role-grant.entity';
import { STAFF_DISPLAY_IDENTITY, StaffDisplayIdentityPort } from './ports';
import { StaffGrantService } from './staff-grant.service';
import { StaffService } from './staff.service';

/**
 * Where a management row's `displayLabel` came from -- V3.3 #154,
 * `V33-DEC-038` R3-R4. Two values, closed: a linked professional's public
 * name, or the masked verified phone when no professional profile is live.
 */
export const STAFF_LABEL_SOURCES = ['professional', 'phone'] as const;
export type StaffLabelSource = (typeof STAFF_LABEL_SOURCES)[number];

/**
 * One row of the owner-only staff-management read -- `V33-DEC-038` R5.
 *
 * Exactly these seven keys, and the test pins them. `id` is the existing
 * membership id -- the selector the grant, revoke, location and remove routes
 * already take -- so no second opaque reference is minted. What is
 * deliberately NOT here: `userId`, `professionalId`, `invitedBy`, the full
 * phone, an email, the identity display name, a grant id, an actor or a
 * timestamp (`V33-DEC-038` R12).
 */
export interface StaffManagementItem {
  readonly id: string;
  readonly role: BusinessStaffRole;
  readonly status: BusinessStaffStatus;
  readonly displayLabel: string;
  readonly labelSource: StaffLabelSource;
  /** Exactly the final four digits of the member's verified phone. */
  readonly identificationHint: string;
  readonly roles: readonly ScopedStaffRole[];
}

/**
 * The owner-only staff-management read -- V3.3 #154, `V33-DEC-038`.
 *
 * ## Why a second read exists next to `GET …/staff`
 *
 * The roster is readable by every active member (`BusinessMembershipResolver`)
 * and projects raw identity ids and no human-readable identification. A
 * financial-access grant must never be made from a placeholder, an array
 * position or a raw id (R1), and the minimal identification that makes a
 * consented member nameable -- the final four digits of the phone the owner
 * supplied at invitation -- is owner-only (R5). So the roster stays
 * byte-for-byte what it was, and this read answers the owner alone through
 * `@ResolveOwner(BusinessOwnerResolver)` on its handler.
 *
 * ## Labels are resolved live, in bulk, and never stored
 *
 * Nothing here is persisted: no column, snapshot, audit row or lazy repair
 * (R11). Every request runs exactly four statements whatever the roster size
 * -- the memberships, the identity/professional description through the
 * composition-root port (itself two statements), and the live grants -- so
 * the cost never grows with the number of members (R6).
 *
 * ## A row nobody can be named on is not shown
 *
 * A listed membership always has a live identity row, because erasure marks
 * the membership `removed` in the same transaction that soft-deletes the user
 * (`BusinessSubjectDataContract`). If that invariant were ever broken between
 * two statements, the row is omitted rather than rendered anonymous or
 * described with a cause -- the same "not live, not shown" rule every other
 * read here follows. A linked professional whose profile is soft-deleted
 * falls back to the phone label, which the owner is always entitled to.
 */
@Injectable()
export class StaffManagementService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly staff: StaffService,
    private readonly grants: StaffGrantService,
    @Inject(STAFF_DISPLAY_IDENTITY) private readonly identity: StaffDisplayIdentityPort,
  ) {}

  /**
   * Every membership the roster lists (`invited` and `active`), in the
   * roster's order, each with its safe label, hint and live scoped roles.
   *
   * A read never writes. The caller's ownership is the route guard's
   * business; this method trusts nothing it is handed except the business id
   * the guard already resolved.
   */
  async listForOwner(businessId: string): Promise<StaffManagementItem[]> {
    const manager = this.dataSource.manager;
    const memberships = await this.staff.listForBusiness(businessId);

    const [described, liveRoles] = await Promise.all([
      this.identity.describeMembers(
        manager,
        memberships.map((membership) => ({ userId: membership.userId, professionalId: membership.professionalId })),
      ),
      this.grants.liveRolesForMemberships(
        manager,
        businessId,
        memberships.map((membership) => membership.id),
      ),
    ]);

    const items: StaffManagementItem[] = [];
    for (const membership of memberships) {
      const identity = described.get(membership.userId);
      if (!identity) continue;

      const professionalName = membership.professionalId ? identity.professionalDisplayName : null;
      items.push({
        id: membership.id,
        role: membership.role,
        status: membership.status,
        displayLabel: professionalName ?? identity.phoneHint,
        labelSource: professionalName ? 'professional' : 'phone',
        identificationHint: identity.phoneHint,
        roles: [...(liveRoles.get(membership.id) ?? [])],
      });
    }
    return items;
  }
}
