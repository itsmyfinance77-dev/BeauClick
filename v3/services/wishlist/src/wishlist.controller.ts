import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import {
  WISHLIST_MAX_CURSOR_LENGTH,
  WISHLIST_MAX_PAGE_SIZE,
  WISHLIST_TARGET_TYPES,
} from '@beauclick/wishlist-contract';
import type { WishlistItemView, WishlistPageView, WishlistTargetType } from '@beauclick/wishlist-contract';

import { WishlistService } from './wishlist.service';

/**
 * The private saved list.
 *
 * ## The rule every route follows
 *
 * **No route accepts a caller-controlled user, customer, or owner identity** —
 * not in a body, not in a query parameter, not in a path segment. The subject is
 * always `@CurrentUser().userId`, from the verified JWT. The mount point is
 * `v1/me/wishlist` rather than `v1/wishlist/:userId` so there is no path segment
 * that could ever be mistaken for one.
 *
 * A route *does* carry a target type and id, and that is not an exception: the
 * target is a public catalogue entity whose existence the public professional
 * route already discloses, so the value narrows a public set rather than naming
 * a party. The server does not trust it either — it is resolved through the
 * saveable-target port and a value that does not resolve is refused.
 *
 * ## No capability, and that is a decision
 *
 * `journey`'s `/v1/me/journey` and the customer half of `/v1/me/loyalty` are
 * authenticated-only for the same reason (ADR-033 §11): this surface acts
 * exclusively on the caller's own data and gates no privileged action. `ai`
 * requires `bc_use_ai_assistant` because its surface has real cost and safety
 * consequences; a saved id has neither.
 *
 * ## Indistinguishability
 *
 * A target that does not exist, one that is soft-deleted, and one whose
 * professional the platform has suspended or revoked all produce the shared
 * `NotFoundOrNotYoursException` — one type, one Persian message. Anything else
 * is a moderation-and-verification feed dressed as an error code.
 *
 * Removal answers identically whether or not anything was there, so a caller
 * cannot use `DELETE` to ask what somebody holds.
 */

export class SaveWishlistItemDto {
  @IsIn([...WISHLIST_TARGET_TYPES])
  targetType!: WishlistTargetType;

  @IsUUID()
  targetId!: string;
}

export class ListWishlistDto {
  @IsOptional()
  @IsString()
  @MaxLength(WISHLIST_MAX_CURSOR_LENGTH)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(WISHLIST_MAX_PAGE_SIZE)
  limit?: number;
}

/**
 * The path parameters for removal.
 *
 * `targetType` is validated against the closed vocabulary here as well as in the
 * service, because an unvalidated path segment reaches the query as a string and
 * would come back from PostgreSQL as a constraint error rather than as a clean
 * refusal.
 */
export class WishlistTargetParamsDto {
  @IsIn([...WISHLIST_TARGET_TYPES])
  targetType!: WishlistTargetType;

  @IsUUID()
  targetId!: string;
}

@Controller('v1/me/wishlist')
export class WishlistController {
  constructor(private readonly wishlist: WishlistService) {}

  /**
   * Saves a target.
   *
   * Returns **200 with the saved item** whether it was just written or was
   * already there — never 201-vs-200 as a signal, because that difference is a
   * side channel telling a caller something about state they can already read.
   * Idempotency is a property of the response, not only of the row count.
   */
  @Post('items')
  @HttpCode(HttpStatus.OK)
  async save(
    @Body() dto: SaveWishlistItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WishlistItemView> {
    return this.wishlist.save(user.userId, { targetType: dto.targetType, targetId: dto.targetId });
  }

  /**
   * The caller's own saved list, newest first.
   *
   * Addressed by nothing: there is no list id, because there is one list per
   * customer (`V32-DEC-021`).
   */
  @Get('items')
  async list(
    @Query() query: ListWishlistDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WishlistPageView> {
    return this.wishlist.list(user.userId, query.limit, query.cursor ?? null);
  }

  /**
   * Removes a saved target. Always 204.
   *
   * Addressed by `(targetType, targetId)` — the natural key the caller already
   * knows — rather than by the row's own id. Exposing the row id would invite a
   * `DELETE /items/:id` route that would then have to re-prove ownership;
   * addressing by the natural key makes not-yours and not-found the same query
   * rather than the same catch block.
   */
  @Delete('items/:targetType/:targetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param() params: WishlistTargetParamsDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.wishlist.remove(user.userId, {
      targetType: params.targetType,
      targetId: params.targetId,
    });
  }
}
