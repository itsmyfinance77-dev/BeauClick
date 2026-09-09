import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { LOCATION_RESOURCE_KINDS, LocationResourceKind } from '../entities/location-resource.entity';

/**
 * The resource-catalogue commands -- V3.3 Story #110 (`#110a`), `V33-DEC-034`
 * R2/R5/R6.
 *
 * ## What these DTOs structurally cannot carry
 *
 * The global `ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted`,
 * so any property not declared here is **rejected with a 400** rather than
 * ignored. That is what keeps `businessId`, `locationId`, `resourceId`,
 * `ownerId`, `userId`, `actorId`, `lifecycle`, `reason`, `state`, `workspaceRef`
 * and every raw-uuid selector out of every resource route: the business comes
 * from the path and is ownership-guarded, the location from the opaque
 * `locationRef` in the path, the resource from the opaque `resourceRef` in the
 * path, and the actor from the session -- none is ever a body field.
 *
 * `lifecycle` in particular is deliberately absent from every command. It is
 * moved by the dedicated `retire` route and by nothing else, so a caller cannot
 * set it directly and cannot invent a value the CHECK constraint would then have
 * to catch.
 *
 * The name is trimmed before validation, so a value that is only whitespace fails
 * `@IsNotEmpty` here rather than reaching the `ck_location_resources_name_shape`
 * database constraint as a 500. The constraint remains the backstop for any write
 * that goes around the DTO.
 */
export class CreateLocationResourceDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  /**
   * The closed vocabulary, refused at the edge as well as by the CHECK.
   *
   * `owner`, `chair`, `bed`, `service`, `resource` and every unknown value fail
   * here with a 400 -- the ordinary syntactic class -- while the database
   * constraint remains the backstop for a write that never passes through this
   * pipe.
   */
  @IsIn(LOCATION_RESOURCE_KINDS)
  kind!: LocationResourceKind;
}

/**
 * Rename accepts exactly a name.
 *
 * `kind` is deliberately not renameable: a room does not become a device, and
 * allowing it would let a resource's identity drift underneath any future
 * assignment that referenced it.
 */
export class RenameLocationResourceDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}

/**
 * `retire` is an empty command. This bound DTO is what makes "accept no body
 * field" a 400 rather than a silently-ignored extra: an empty object validates,
 * anything with a property does not.
 *
 * There is no restore or reactivate counterpart. `retired` is terminal
 * (`V33-DEC-034` R2 and the owner's 2026-09-09 clarification), enforced by
 * `tg_location_resources_lifecycle` in PostgreSQL as well as by the absence of a
 * route.
 */
export class EmptyLocationResourceCommandDto {}

/**
 * The list query, bound so unknown query parameters are refused rather than
 * ignored.
 *
 * Declaring no property is the point: there is no filter, no cursor and no
 * `lifecycle` selector to pass. The collection is naturally bounded -- the
 * resources of one location of one business -- so a caller who sends
 * `?lifecycle=retired` or `?businessId=…` gets a 400 instead of a silently
 * different result set.
 */
export class ListLocationResourcesQueryDto {}
