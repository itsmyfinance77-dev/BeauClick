import { Body, Controller, Get, Param, Post, Patch, Put } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { NotFoundOrNotYoursException, ResolveOwner } from '@beauclick/ownership';

import { BusinessService } from './business.service';
import { BusinessClassification, BusinessClassificationService } from './business-classification.service';
import { StaffService } from './staff.service';
import { BusinessEntity } from './entities/business.entity';
import { BusinessStaffEntity } from './entities/business-staff.entity';
import { CreateBusinessDto } from './dto/create-business.dto';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { InviteStaffDto } from './dto/staff.dto';
import { ReplaceBusinessClassificationDto } from './dto/business-classification.dto';
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

/**
 * The classification response shape.
 *
 * Neutral and complete: an unclassified business answers `vertical: null` and
 * an empty trait array rather than a `404`, because "not yet answered" is a
 * legal state (`V33-DEC-032` R3) and a missing resource is not what it means.
 * Traits are already sorted by the service, so the whole body is deterministic.
 */
function toClassificationShape(classification: BusinessClassification) {
  return { vertical: classification.vertical, traits: [...classification.traits] };
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
    private readonly classification: BusinessClassificationService,
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

  // -----------------------------------------------------------------------
  // Classification and operating traits -- V3.3 Story #107 (`#44a`).
  //
  // Two routes, on the two DIFFERENT authorization boundaries the story
  // ratified: any live member may READ what the business is, only the live
  // OWNER may change it. `@ResolveOwner` is declared on each HANDLER and never
  // on the class -- `OwnershipGuard` reflects handler metadata only, so a
  // class-level decorator would be silently ignored and every route on this
  // controller would lose its check while the decorator read as protection
  // (ADR-049 section 2.5).
  //
  // `GET /v1/me/business` and the existing business projection are deliberately
  // untouched: widening a shipped response to carry classification would change
  // a contract this story is not authorized to change.
  // -----------------------------------------------------------------------

  @ResolveOwner(BusinessMembershipResolver)
  @Get('businesses/:id/classification')
  async getClassification(@Param('id') id: string) {
    return toClassificationShape(await this.classification.read(id));
  }

  /**
   * Full replacement. Owner-only: an ACTIVE manager or staff member resolves to
   * `null` here and receives the same refusal a stranger does.
   *
   * The actor comes from the session and the business from the path -- neither
   * is ever a body field, and the DTO structurally cannot carry one.
   */
  @ResolveOwner(BusinessOwnerResolver)
  @Put('businesses/:id/classification')
  async replaceClassification(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReplaceBusinessClassificationDto,
  ) {
    return toClassificationShape(await this.classification.replace(id, user.userId, dto));
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
