import { IsString, Matches, ValidateIf } from 'class-validator';

import { LOCATION_REFERENCE_PATTERN } from '@beauclick/workspace-reference';

/**
 * The staff delivery-location command -- V3.3 Story #127 (`#127a`),
 * `V33-DEC-035` R2.
 *
 * ## What this DTO structurally cannot carry
 *
 * The global `ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted`,
 * so any property not declared here is **rejected with a 400** rather than
 * ignored. That is what keeps `businessId`, `staffId`, `locationId`, `ownerId`,
 * `userId`, `professionalId`, `actorId`, `lifecycle`, `reason`, `state` and every
 * raw-uuid selector out of this route: the business comes from the path and is
 * ownership-guarded, the membership from the path, the branch from the opaque
 * reference below, and the actor from the session -- none is ever a body field.
 *
 * ## `null` is a real value, not a missing one
 *
 * Clearing a binding is an explicit command, so `locationRef: null` must be
 * accepted and must mean "remove it" — while a **missing** `locationRef` is a
 * malformed request. `@ValidateIf` is what separates the two: the string rules
 * apply only when the value is not null, and the property itself is still
 * required, so `{}` fails.
 *
 * ## The shape is validated here; the meaning is not
 *
 * `LOCATION_REFERENCE_PATTERN` refuses anything that is not 43 base64url
 * characters before the service does any HMAC work, exactly as
 * `resolveLocationReference` does internally. Whether the reference names a live,
 * owned, active branch is decided server-side by enumerate-and-compare, and every
 * failure there is the single non-enumerating refusal rather than a 400.
 */
export class SetStaffLocationDto {
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @Matches(LOCATION_REFERENCE_PATTERN, { message: 'locationRef must be an opaque location reference or null' })
  locationRef!: string | null;
}
