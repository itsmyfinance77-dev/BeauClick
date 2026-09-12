import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { ResolveOwner } from '@beauclick/ownership';

import { ServiceResourceRequirementService } from './service-resource-requirement.service';
import { BusinessOwnerResolver } from './business-membership.resolver';
import { ReadServiceResourceRequirementQueryDto, SetServiceResourceRequirementDto } from './dto/service-resource-requirement.dto';

/**
 * The service resource-requirement route family -- V3.3 Story #131
 * (`#127b`), `V33-DEC-035`.
 *
 * The smallest coherent pair: a read and a set-or-clear, under the existing
 * owner-guarded business namespace.
 *
 * ## Owner-only, and `@ResolveOwner` is on every HANDLER, never the class
 *
 * `OwnershipGuard` reflects handler metadata only, so a class-level decorator
 * would be silently ignored and every route here would lose its check while
 * reading as protected -- the same discipline `LocationResourceController`
 * follows. `BusinessOwnerResolver` resolves `:id` from live
 * `businesses.owner_id`; a manager, an ordinary staff member, a stranger, a
 * foreign owner and a `practitioner_chat` grant holder all get the same
 * `NOT_FOUND_OR_NOT_YOURS` a nonexistent business does.
 *
 * **No scoped-staff role authorizes this surface.** No member of
 * `SCOPED_STAFF_ROLES` (`practitioner_chat`, or #111's read-only `finance_read`)
 * reaches it, and no capability or scoped-role guard appears on either handler
 * below.
 *
 * ## `:serviceId` is a raw uuid, deliberately -- not an opaque reference
 *
 * Every other owner-facing handle in this module (`locationRef`,
 * `resourceRef`) is an opaque, HMAC-derived reference because those surfaces
 * are reachable from a caller who does not already know the underlying id.
 * Here the caller must already know their own professional's `service_id` to
 * have configured it via `provider`'s own routes, and this route is
 * owner-guarded and never customer-facing (`V33-DEC-035` R8/R9) -- so a
 * fourth reference kind would add a mechanism with no caller who needs it.
 * The service is proved to belong to this business through
 * `SERVICE_OWNERSHIP_DIRECTORY` on every request, including a read, so a
 * caller cannot enumerate ids they do not already own and learn anything.
 *
 * ## `GET` is read-only; `PUT` accepts exactly one field
 *
 * `requiredKind: null` clears the requirement, and every unknown body or
 * query field is a `400` rather than a silently ignored extra, via the
 * global `ValidationPipe`'s `whitelist`/`forbidNonWhitelisted`.
 */
@Controller('v1')
export class ServiceResourceRequirementController {
  constructor(private readonly requirements: ServiceResourceRequirementService) {}

  @ResolveOwner(BusinessOwnerResolver)
  @Get('businesses/:id/services/:serviceId/resource-requirement')
  async read(
    @Param('id') id: string,
    @Param('serviceId') serviceId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() _query: ReadServiceResourceRequirementQueryDto,
  ) {
    return this.requirements.read(id, user.userId, serviceId);
  }

  @ResolveOwner(BusinessOwnerResolver)
  @Put('businesses/:id/services/:serviceId/resource-requirement')
  async set(
    @Param('id') id: string,
    @Param('serviceId') serviceId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SetServiceResourceRequirementDto,
  ) {
    return this.requirements.set(id, user.userId, serviceId, dto);
  }
}
