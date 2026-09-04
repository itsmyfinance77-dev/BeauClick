import { IsInt, IsString, Length, Min } from 'class-validator';

/**
 * The seller surface's request contracts — Story #69 (`#56b`).
 *
 * ## Every field a caller may send is declared here, and nothing else is
 *
 * The global `ValidationPipe` runs with `whitelist: true` and
 * `forbidNonWhitelisted: true`, so a property that is not declared on the DTO
 * is REFUSED rather than stripped. `V33-DEC-019` requires that explicitly, and
 * the difference matters: a stripped `ownerId` would be silently ignored by a
 * server that had already resolved the owner from the session, which reads to
 * the caller like the field was honoured.
 *
 * ## The empty DTOs are load-bearing, not placeholders
 *
 * `EmptyBodyDto` and `EmptyQueryDto` declare NO properties, so under
 * `forbidNonWhitelisted` every field a caller sends is an error. Without them,
 * Nest performs no validation on that argument at all and unknown query
 * parameters are silently ignored — which is the behaviour the story forbids.
 * They are the reason `POST /me/subscriptions/initialization?planKey=x` is a
 * `400` rather than a success.
 *
 * ## What no DTO here declares, deliberately
 *
 * No `userId`, `ownerId`, `professionalId`, `businessId`, `partyId`,
 * `subscriberId`, `actorId` or `subscriptionId`. Every one of those is resolved
 * server-side from the authenticated session (`V33-DEC-009`), so there is
 * nothing for a caller to supply and nothing for the server to have to ignore.
 *
 * No `reason` either. `V33-DEC-018` closes the audit vocabulary to
 * server-generated constants, and a free-text field here would be the one path
 * by which caller prose reached an append-only log the application cannot edit.
 */

/** For a route that accepts no body. Any property is a validation failure. */
export class EmptyBodyDto {}

/** For a route that accepts no query parameters. Any parameter is a validation failure. */
export class EmptyQueryDto {}

/**
 * `POST /me/subscriptions/:workspaceRef/selection`.
 *
 * Exactly two fields. The workspace is a path segment, the actor is the
 * session, and the plan is named by its immutable catalogue coordinates rather
 * than by a `planVersionId` — an id would be a second way to name the same row
 * and the only one a caller could not verify against the catalogue they were
 * shown.
 */
export class SelectPlanVersionDto {
  /**
   * Bounded to the column's own width (`plans.plan_key varchar(64)`), so an
   * over-long key is refused by validation rather than by the driver.
   */
  @IsString()
  @Length(1, 64)
  planKey!: string;

  /**
   * `1`-based, matching `plan_versions.version`. Not `Min(0)`: version zero
   * does not exist, and accepting it would turn a client bug into a
   * `plan_version_not_selectable` that looks like a catalogue problem.
   */
  @IsInt()
  @Min(1)
  version!: number;
}

/**
 * ## There is deliberately NO DTO or pipe for the `:workspaceRef` segment
 *
 * The obvious thing is a `@Matches(/^[A-Za-z0-9_-]{43}$/)` param DTO, and it
 * would be wrong. A validation failure is a `400 VALIDATION_ERROR` naming the
 * field; a foreign but well-formed reference is a `404
 * SUBSCRIPTION_SELLER_NOT_ELIGIBLE`. Two different responses is an oracle: it
 * tells a caller probing references when they have found the right SHAPE, which
 * is the first bit of information an attacker needs and the one thing
 * `V33-DEC-019` requires this surface never to give.
 *
 * So the format check lives inside `WorkspaceReferenceService.resolve`,
 * alongside the ownership match, and every failure — malformed, random,
 * foreign, stale, or "you own no workspace" — leaves by the same single throw
 * with the same body. One path, so the two cannot drift apart.
 */
