import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { FINANCE_PAGE_SIZE_MAX } from '../finance-workspace.service';

/**
 * The workspace-aware finance surface's request contracts — V3.3 #72.
 *
 * ## Every field a caller may send is declared here, and nothing else is
 *
 * The global `ValidationPipe` runs with `whitelist: true` and
 * `forbidNonWhitelisted: true`, so an undeclared property is REFUSED rather
 * than stripped. That matters on this surface specifically: a stripped
 * `partyId` would be silently ignored by a server that had already resolved the
 * party from the session, which reads to the caller like the field was
 * honoured.
 *
 * ## What no DTO here declares
 *
 * No `userId`, `ownerId`, `professionalId`, `businessId` or `partyId`. The
 * caller comes from the session and the workspace from an opaque reference that
 * is matched, never looked up — so cross-party access is not something a check
 * could fail to catch, it is unrepresentable.
 *
 * ## There is deliberately NO DTO for the `:workspaceRef` segment
 *
 * The obvious thing is a `@Matches(/^[A-Za-z0-9_-]{43}$/)` param DTO, and it
 * would be wrong. A validation failure is a `400 VALIDATION_ERROR` naming the
 * field; a foreign but well-formed reference is a `404 NOT_FOUND_OR_NOT_YOURS`.
 * Two different responses is an oracle: it tells a caller probing references
 * when they have found the right SHAPE. The format check therefore lives inside
 * `resolveWorkspaceReference`, alongside the ownership match, so every failure
 * leaves by the same throw with the same body.
 */

/** For a route that accepts no query parameters. Any parameter is a validation failure. */
export class EmptyFinanceQueryDto {}

/**
 * Keyset pagination for `GET /me/finance/:workspaceRef/settlements`.
 *
 * `cursor` is opaque and workspace-bound — see `encodeWorkspaceCursor`. It is
 * validated as a string here and verified against the workspace being read
 * before a single row is fetched; a cursor issued for another workspace is
 * refused with the same body every other reference failure produces.
 */
export class SettlementPageQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FINANCE_PAGE_SIZE_MAX)
  limit?: number;
}
