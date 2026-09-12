import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { ResolveOwner } from '@beauclick/ownership';

import { LocationResourceService } from './location-resource.service';
import { BusinessOwnerResolver } from './business-membership.resolver';
import {
  CreateLocationResourceDto,
  EmptyLocationResourceCommandDto,
  ListLocationResourcesQueryDto,
  RenameLocationResourceDto,
} from './dto/location-resource.dto';

/**
 * The location resource catalogue -- V3.3 Story #110 (`#110a`), `V33-DEC-034`.
 *
 * The smallest coherent route family under the existing #108 location namespace:
 * a collection read, a create, a rename, and retire as an empty command.
 *
 * ## Owner-only, and `@ResolveOwner` is on every HANDLER, never the class
 *
 * ADR-049 section 2.5 and `V33-DEC-034` R3. `OwnershipGuard` reflects handler
 * metadata only, so a class-level decorator would be silently ignored and every
 * route here would lose its check while reading as protected.
 * `BusinessOwnerResolver` resolves `:id` from live `businesses.owner_id`; an
 * active manager, an ordinary staff member, a stranger, a foreign owner and a
 * `practitioner_chat` grant holder all get the same `NOT_FOUND_OR_NOT_YOURS` a
 * nonexistent business does.
 *
 * **No scoped-staff role authorizes this surface and none was added.**
 * No member of `SCOPED_STAFF_ROLES` (`practitioner_chat`, or #111's read-only
 * `finance_read`) reaches it, and no capability or scoped-role guard appears on
 * any handler below.
 *
 * ## The opaque references are the only handles
 *
 * The location comes from `:locationRef` and the resource from `:resourceRef` --
 * never a raw uuid, never a body field, never a query parameter. The service
 * resolves each by enumerating the caller's own rows and constant-time comparing;
 * a malformed, foreign or stale reference yields the one refusal,
 * indistinguishable from every other cause. **No raw resource or location uuid is
 * ever returned.**
 *
 * ## There is no restore route, deliberately
 *
 * `retired` is terminal (`V33-DEC-034` R2 and the owner's 2026-09-09
 * clarification). No restore or reactivate handler exists here, no service method
 * backs one, and `tg_location_resources_lifecycle` refuses the transition in
 * PostgreSQL. A future restore capability requires its own explicit decision.
 */
@Controller('v1')
export class LocationResourceController {
  constructor(private readonly resources: LocationResourceService) {}

  @ResolveOwner(BusinessOwnerResolver)
  @Get('businesses/:id/locations/:locationRef/resources')
  async list(
    @Param('id') id: string,
    @Param('locationRef') locationRef: string,
    @CurrentUser() user: AuthenticatedUser,
    /**
     * Bound so an unknown query parameter is a 400 rather than a silently
     * ignored filter. The DTO declares no property: there is no cursor, no
     * lifecycle selector and no filter to pass.
     */
    @Query() _query: ListLocationResourcesQueryDto,
  ) {
    return this.resources.list(id, user.userId, locationRef);
  }

  @ResolveOwner(BusinessOwnerResolver)
  @Post('businesses/:id/locations/:locationRef/resources')
  async create(
    @Param('id') id: string,
    @Param('locationRef') locationRef: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateLocationResourceDto,
  ) {
    return this.resources.create(id, user.userId, locationRef, dto);
  }

  @ResolveOwner(BusinessOwnerResolver)
  @Patch('businesses/:id/locations/:locationRef/resources/:resourceRef')
  async rename(
    @Param('id') id: string,
    @Param('locationRef') locationRef: string,
    @Param('resourceRef') resourceRef: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RenameLocationResourceDto,
  ) {
    return this.resources.rename(id, user.userId, locationRef, resourceRef, dto);
  }

  @ResolveOwner(BusinessOwnerResolver)
  @Post('businesses/:id/locations/:locationRef/resources/:resourceRef/retire')
  async retire(
    @Param('id') id: string,
    @Param('locationRef') locationRef: string,
    @Param('resourceRef') resourceRef: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() _command: EmptyLocationResourceCommandDto,
  ) {
    return this.resources.retire(id, user.userId, locationRef, resourceRef);
  }
}
