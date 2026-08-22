import { Body, Controller, Get, Param, Post, Patch } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { NotFoundOrNotYoursException, ResolveOwner } from '@beauclick/ownership';

import { BusinessService } from './business.service';
import { StaffService } from './staff.service';
import { BusinessEntity } from './entities/business.entity';
import { BusinessStaffEntity } from './entities/business-staff.entity';
import { CreateBusinessDto } from './dto/create-business.dto';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { InviteStaffDto } from './dto/staff.dto';
import {
  BusinessManagerResolver,
  BusinessMembershipResolver,
  BusinessOwnerResolver,
  BusinessStaffSelfResolver,
} from './business-membership.resolver';
import { StaffMembershipNotFoundException } from './business.errors';

function toBusinessShape(business: BusinessEntity) {
  return {
    id: business.id,
    ownerId: business.ownerId,
    displayName: business.displayName,
    bio: business.bio,
    cityId: business.cityId,
    verificationStatus: business.verificationStatus,
    createdAt: business.createdAt.toISOString(),
  };
}

function toStaffShape(row: BusinessStaffEntity) {
  return {
    id: row.id,
    businessId: row.businessId,
    userId: row.userId,
    professionalId: row.professionalId,
    role: row.role,
    status: row.status,
    invitedBy: row.invitedBy,
    respondedAt: row.respondedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

@Controller('v1')
export class BusinessController {
  constructor(
    private readonly businesses: BusinessService,
    private readonly staff: StaffService,
  ) {}

  @Post('businesses')
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateBusinessDto) {
    const business = await this.businesses.create(user.userId, dto);
    return toBusinessShape(business);
  }

  @Get('me/business')
  async myBusiness(@CurrentUser() user: AuthenticatedUser) {
    const business = await this.businesses.findByOwner(user.userId);
    return business ? toBusinessShape(business) : null;
  }

  @ResolveOwner(BusinessMembershipResolver)
  @Get('businesses/:id')
  async getOne(@Param('id') id: string) {
    const business = await this.businesses.findById(id);
    if (!business) throw new NotFoundOrNotYoursException();
    return toBusinessShape(business);
  }

  @ResolveOwner(BusinessManagerResolver)
  @Patch('businesses/:id')
  async update(@Param('id') id: string, @Body() dto: UpdateBusinessDto) {
    const business = await this.businesses.update(id, dto);
    return toBusinessShape(business);
  }

  @ResolveOwner(BusinessMembershipResolver)
  @Get('businesses/:id/staff')
  async listStaff(@Param('id') id: string) {
    return (await this.staff.listForBusiness(id)).map(toStaffShape);
  }

  @ResolveOwner(BusinessOwnerResolver)
  @Post('businesses/:id/staff')
  async invite(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: InviteStaffDto) {
    const row = await this.staff.invite(id, user.userId, dto);
    return toStaffShape(row);
  }

  /**
   * Owner removes a staff member. `staffId` is verified to belong to THIS
   * business before deactivation -- `:id`'s ownership is checked by the
   * guard, but a staff id from a DIFFERENT business is a second thing this
   * route must not trust the caller to have gotten right on their own.
   */
  @ResolveOwner(BusinessOwnerResolver)
  @Post('businesses/:id/staff/:staffId/remove')
  async remove(@Param('id') id: string, @Param('staffId') staffId: string) {
    const row = await this.staff.findById(staffId);
    if (!row || row.businessId !== id) throw new StaffMembershipNotFoundException();
    await this.staff.deactivate(staffId);
    return { removed: true };
  }

  // -----------------------------------------------------------------------
  // "My invites and memberships" -- the invited user's own view, authorized
  // by BusinessStaffSelfResolver (the row's userId), never by business
  // ownership.
  // -----------------------------------------------------------------------

  @Get('me/business-staff')
  async myMemberships(@CurrentUser() user: AuthenticatedUser) {
    return (await this.staff.listForUser(user.userId)).map(toStaffShape);
  }

  @ResolveOwner(BusinessStaffSelfResolver)
  @Post('me/business-staff/:staffId/accept')
  async accept(@Param('staffId') staffId: string, @CurrentUser() user: AuthenticatedUser) {
    const row = await this.staff.accept(staffId, user.userId);
    return toStaffShape(row);
  }

  @ResolveOwner(BusinessStaffSelfResolver)
  @Post('me/business-staff/:staffId/decline')
  async decline(@Param('staffId') staffId: string, @CurrentUser() user: AuthenticatedUser) {
    const ok = await this.staff.decline(staffId, user.userId);
    if (!ok) throw new StaffMembershipNotFoundException();
    return { declined: true };
  }

  @ResolveOwner(BusinessStaffSelfResolver)
  @Post('me/business-staff/:staffId/leave')
  async leave(@Param('staffId') staffId: string) {
    const ok = await this.staff.deactivate(staffId);
    if (!ok) throw new StaffMembershipNotFoundException();
    return { left: true };
  }
}
