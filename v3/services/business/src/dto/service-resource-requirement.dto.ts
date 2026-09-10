import { IsIn, ValidateIf } from 'class-validator';

import { REQUIRED_RESOURCE_KINDS, RequiredResourceKind } from '../entities/service-resource-requirement.entity';

/**
 * The requirement command -- V3.3 Story #131 (`#127b`), `V33-DEC-035` R5/R6.
 *
 * ## What this DTO structurally cannot carry
 *
 * The global `ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted`,
 * so any property not declared here is **rejected with a 400** rather than
 * ignored. That is what keeps `businessId`, `serviceId`, `ownerId`, `userId`,
 * `actorId`, `reason` and every raw-uuid selector out of this route: the
 * business comes from the path and is ownership-guarded, the service from the
 * path (an owner-guarded route may address it by its own uuid -- there is no
 * customer-facing resource surface for it to enumerate), and the actor from
 * the session -- none is ever a body field.
 *
 * ## `null` is a real value, not a missing one
 *
 * Clearing a requirement is an explicit command, so `requiredKind: null` must
 * be accepted and must mean "no managed resource is required" -- while a
 * **missing** `requiredKind` is a malformed request. `@ValidateIf` is what
 * separates the two, exactly as `SetStaffLocationDto.locationRef` already
 * does for the analogous nullable-field command.
 */
export class SetServiceResourceRequirementDto {
  @ValidateIf((_object, value) => value !== null)
  @IsIn(REQUIRED_RESOURCE_KINDS)
  requiredKind!: RequiredResourceKind | null;
}

/**
 * The read route's query, bound so an unknown query parameter is a 400
 * rather than a silently ignored filter. Declaring no property is the point:
 * there is nothing to filter, since a service is addressed one at a time by
 * the path.
 */
export class ReadServiceResourceRequirementQueryDto {}
