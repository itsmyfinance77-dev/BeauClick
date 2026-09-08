import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { ResolveOwner } from '@beauclick/ownership';

import { BusinessLocationService } from './business-location.service';
import { BusinessOwnerResolver } from './business-membership.resolver';
import { CreateLocationDto, EmptyLocationCommandDto, RenameLocationDto } from './dto/location.dto';

/**
 * Organisation locations -- V3.3 Story #108 (`#44b`), ADR-049 section 3.
 *
 * The smallest coherent route family under the existing business namespace:
 * a collection read, a create, a rename, and suspend / reactivate / close as
 * empty commands.
 *
 * ## Owner-only, and `@ResolveOwner` is on every HANDLER, never the class
 *
 * ADR-049 section 2.5. `OwnershipGuard` reflects handler metadata only, so a
 * class-level decorator would be silently ignored and every route here would
 * lose its check while reading as protected. `BusinessOwnerResolver` resolves
 * `:id` from live `businesses.owner_id`; an active manager, staff member,
 * stranger or foreign owner all get the same `NOT_FOUND_OR_NOT_YOURS` a
 * nonexistent business does. Scoped delegation of location edit is `#44c`'s.
 *
 * ## The opaque `locationRef` is the only handle to an item
 *
 * Item mutations take `:locationRef` -- never a raw location id, a business id in
 * the body, a `workspaceRef` or a state. The service resolves it by enumerating
 * the caller's live-owned locations and constant-time comparing; a malformed,
 * foreign or stale ref yields the one refusal, indistinguishable from every
 * other cause.
 */
@Controller('v1')
export class BusinessLocationController {
  constructor(private readonly locations: BusinessLocationService) {}

  @ResolveOwner(BusinessOwnerResolver)
  @Get('businesses/:id/locations')
  async list(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.locations.list(id, user.userId);
  }

  @ResolveOwner(BusinessOwnerResolver)
  @Post('businesses/:id/locations')
  async create(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateLocationDto) {
    return this.locations.create(id, user.userId, dto);
  }

  @ResolveOwner(BusinessOwnerResolver)
  @Patch('businesses/:id/locations/:locationRef')
  async rename(
    @Param('id') id: string,
    @Param('locationRef') locationRef: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RenameLocationDto,
  ) {
    return this.locations.rename(id, user.userId, locationRef, dto);
  }

  @ResolveOwner(BusinessOwnerResolver)
  @Post('businesses/:id/locations/:locationRef/suspend')
  async suspend(
    @Param('id') id: string,
    @Param('locationRef') locationRef: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() _command: EmptyLocationCommandDto,
  ) {
    return this.locations.suspend(id, user.userId, locationRef);
  }

  @ResolveOwner(BusinessOwnerResolver)
  @Post('businesses/:id/locations/:locationRef/reactivate')
  async reactivate(
    @Param('id') id: string,
    @Param('locationRef') locationRef: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() _command: EmptyLocationCommandDto,
  ) {
    return this.locations.reactivate(id, user.userId, locationRef);
  }

  @ResolveOwner(BusinessOwnerResolver)
  @Post('businesses/:id/locations/:locationRef/close')
  async close(
    @Param('id') id: string,
    @Param('locationRef') locationRef: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() _command: EmptyLocationCommandDto,
  ) {
    return this.locations.close(id, user.userId, locationRef);
  }
}
