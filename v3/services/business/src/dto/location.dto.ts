import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * The location commands -- V3.3 Story #108 (`#44b`), ADR-049 section 3.5.
 *
 * ## What these DTOs structurally cannot carry
 *
 * The global `ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted`,
 * so any property not declared here is REJECTED with a 400 rather than ignored.
 * That is what keeps an owner/user/business/party id, a `workspaceRef`, a raw
 * location id, a `lifecycle` value, an actor, a staff scope, a `reason` or any
 * unknown field out of every location route: the business comes from the path
 * and is ownership-guarded, the location from the opaque `locationRef` in the
 * path, and the actor from the session -- none is ever a body field.
 *
 * The name is trimmed before validation, so a value that is only whitespace
 * fails `@IsNotEmpty` here rather than reaching the `ck_locations_name_shape`
 * database constraint as a 500. The constraint remains the backstop for any
 * write that goes around the DTO.
 */
export class CreateLocationDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsUUID()
  cityId!: string;
}

export class RenameLocationDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}

/**
 * suspend / reactivate / close are empty commands. This bound DTO is what makes
 * "accept no body field" a 400 rather than a silently-ignored extra: an empty
 * object validates, anything with a property does not.
 */
export class EmptyLocationCommandDto {}
