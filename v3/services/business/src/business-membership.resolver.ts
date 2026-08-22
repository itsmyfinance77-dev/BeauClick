import { Injectable } from '@nestjs/common';
import { OwnerResolver } from '@beauclick/ownership';
import { StaffService, BusinessRole } from './staff.service';

/**
 * A business has THREE legitimate relationships (owner, manager, staff)
 * while `OwnershipGuard` compares a single resolved owner id against the
 * session -- the same shape `BookingPartyResolver` already solves for
 * booking's two parties. `resolve()` answers the guard's actual question
 * ("does this session have SOME legitimate claim on this business?"),
 * returning the session's own id when it does.
 */
@Injectable()
export class BusinessMembershipResolver implements OwnerResolver<{ id: string }> {
  constructor(private readonly staff: StaffService) {}

  async resolve(sessionUserId: string, params: { id: string }): Promise<string | null> {
    return (await this.staff.roleFor(params.id, sessionUserId)) ? sessionUserId : null;
  }

  async roleFor(businessId: string, userId: string): Promise<BusinessRole | null> {
    return this.staff.roleFor(businessId, userId);
  }
}

/** Owner-only routes: delete the business, invite/remove staff, change roles. */
@Injectable()
export class BusinessOwnerResolver implements OwnerResolver<{ id: string }> {
  constructor(private readonly membership: BusinessMembershipResolver) {}

  async resolve(sessionUserId: string, params: { id: string }): Promise<string | null> {
    return (await this.membership.roleFor(params.id, sessionUserId)) === 'owner' ? sessionUserId : null;
  }
}

/** Owner or manager: profile edits, aggregated read views. Staff (delivering-only members) resolve to null here. */
@Injectable()
export class BusinessManagerResolver implements OwnerResolver<{ id: string }> {
  constructor(private readonly membership: BusinessMembershipResolver) {}

  async resolve(sessionUserId: string, params: { id: string }): Promise<string | null> {
    const role = await this.membership.roleFor(params.id, sessionUserId);
    return role === 'owner' || role === 'manager' ? sessionUserId : null;
  }
}

/**
 * For the "my invites and memberships" surface (`/v1/me/business-staff/:staffId/...`):
 * the ONLY legitimate caller is the invited/staff user named on the row
 * itself. A business owner acting on a staff row goes through
 * `BusinessOwnerResolver` on the business-scoped route instead -- two
 * separate resolvers for two separate actors, never one resolver trying to
 * authorize both.
 */
@Injectable()
export class BusinessStaffSelfResolver implements OwnerResolver<{ staffId: string }> {
  constructor(private readonly staff: StaffService) {}

  async resolve(sessionUserId: string, params: { staffId: string }): Promise<string | null> {
    const row = await this.staff.findById(params.staffId);
    return row && row.userId === sessionUserId ? sessionUserId : null;
  }
}
