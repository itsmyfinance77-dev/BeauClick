import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

import { Public, RequireCapability } from '@beauclick/auth';
import { AuditAction } from '@beauclick/audit';
import { AuthenticatedUser, CurrentUser, PageQueryDto, PaginatedResult } from '@beauclick/http';
import { ResolveOwner } from '@beauclick/ownership';

import { ProviderService } from './provider.service';
import { ProviderOwnerResolver } from './provider-owner.resolver';
import { ReviewEntity } from './entities/review.entity';
import { ModerationDecision, ReviewService } from './review.service';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';

export class CreateReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  comment?: string;
}

export class RespondToReviewDto {
  @IsString()
  @Length(1, 2000)
  text!: string;
}

export class ModerateReviewDto {
  @IsIn(['hide', 'publish'])
  decision!: ModerationDecision;

  /** Required in both directions: a takedown with no stated basis is unauditable, and so is a decision to keep. */
  @IsString()
  @Length(4, 500)
  reason!: string;
}

/**
 * The public shape.
 *
 * `customerId` is deliberately NOT here. A review is attributed to a booking,
 * not to a browsable customer identity: publishing the id would let anyone
 * assemble one customer's entire visit history across every professional they
 * have ever booked, from public data. The reviewer's identity is visible to
 * the reviewer and to a moderator, and to nobody else.
 */
function toPublicShape(row: ReviewEntity) {
  return {
    id: row.id,
    rating: row.rating,
    comment: row.comment,
    response: row.responseText ? { text: row.responseText, respondedAt: row.respondedAt?.toISOString() ?? null } : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A customer reviews their own completed booking.
 *
 * The route is addressed by BOOKING id, which is the roadmap's own contract
 * (`POST /v1/bookings/:id/review`) and is also the right shape: eligibility is
 * a property of a booking, and naming the professional instead would invite a
 * request that reviews one professional for another's work.
 *
 * There is no customer parameter anywhere on this controller. The reviewer is
 * the session, and the professional is read from provider's own eligibility
 * projection.
 */
@Controller('v1/bookings')
export class BookingReviewController {
  constructor(private readonly reviews: ReviewService) {}

  @Post(':id/review')
  async create(@Param('id') bookingId: string, @Body() dto: CreateReviewDto, @CurrentUser() user: AuthenticatedUser) {
    const row = await this.reviews.create({
      bookingId,
      customerUserId: user.userId,
      rating: dto.rating,
      comment: dto.comment?.trim() || null,
    });
    return toPublicShape(row);
  }
}

/** The caller's own reviews. */
@Controller('v1/me')
export class MyReviewsController {
  constructor(private readonly reviews: ReviewService) {}

  /**
   * Not one of the roadmap's five named routes, and added deliberately.
   *
   * Without it a client has no way to tell which of its completed bookings it
   * has already reviewed, so the only reachable behaviour would be to offer
   * "leave a review" on every completed booking and let the second attempt
   * fail with a conflict. The alternative — putting a review summary on the
   * booking list — would need a cross-domain read from booking into provider,
   * which ADR-011 forbids and which would couple the two modules for a display
   * concern. One small provider-owned read route is the smaller answer.
   */
  @Get('reviews')
  async mine(@Query() query: PageQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<PaginatedResult<unknown[]>> {
    const { items, total } = await this.reviews.listForCustomer(user.userId, { page: query.page, limit: query.limit });
    return {
      value: items.map((row) => ({
        ...toPublicShape(row),
        bookingId: row.bookingId,
        professionalId: row.professionalId,
        // The author sees their own review's moderation state; nobody else does.
        status: row.status,
      })),
      meta: { pagination: { page: query.page, limit: query.limit, total } },
    };
  }
}

/** A professional's public reviews, and their reply. */
@Controller('v1/providers')
export class ProviderReviewController {
  constructor(
    private readonly reviews: ReviewService,
    private readonly providers: ProviderService,
  ) {}

  @Public()
  @Get(':id/reviews')
  async list(@Param('id') id: string, @Query() query: PageQueryDto): Promise<PaginatedResult<unknown[]>> {
    const provider = await this.providers.findById(id);
    if (!provider) throw new NotFoundOrNotYoursException();

    const { items, total } = await this.reviews.listForProfessional(id, { page: query.page, limit: query.limit });

    // Just the list. The aggregate lives on the professional's own shape
    // (`GET /v1/providers/:id` -> `rating`), beside `images`, because a profile
    // header needs it without fetching a page of reviews -- and because `meta`
    // in this codebase means pagination and nothing else.
    return {
      value: items.map(toPublicShape),
      meta: { pagination: { page: query.page, limit: query.limit, total } },
    };
  }

  /**
   * Two independent ownership checks, the pairing this module uses everywhere:
   * `OwnershipGuard` proves `:id` is the session's own professional, and the
   * service additionally scopes the update by `professionalId`, so another
   * professional's review id resolves exactly the way a nonexistent one does.
   */
  @ResolveOwner(ProviderOwnerResolver)
  @Post(':id/reviews/:reviewId/respond')
  async respond(
    @Param('id') id: string,
    @Param('reviewId') reviewId: string,
    @Body() dto: RespondToReviewDto,
  ) {
    const row = await this.reviews.respond(id, reviewId, dto.text.trim());
    return toPublicShape(row);
  }
}

/**
 * Review moderation.
 *
 * Gated on `bc_moderate_reviews`, which has existed as a capability since
 * Phase A with nothing behind it — the gap register records exactly that. It
 * is held by `moderator` and `administrator` and NOT by `platform_operator`,
 * and that separation is the one the roles migration already reasoned through:
 * content moderation is not the operational tier's work.
 */
@Controller('v1/admin/reviews')
export class AdminReviewController {
  constructor(private readonly reviews: ReviewService) {}

  @RequireCapability('bc_moderate_reviews')
  @Get('queue')
  async queue(@Query() query: PageQueryDto): Promise<PaginatedResult<unknown[]>> {
    const { items, total } = await this.reviews.moderationQueue({ page: query.page, limit: query.limit });
    return {
      value: items.map((row) => ({
        id: row.id,
        professionalId: row.professionalId,
        displayName: row.displayName,
        rating: row.rating,
        // A moderator reads the text — deciding whether it should stay up is
        // the whole job. It still never enters an event or an audit snapshot.
        comment: row.comment,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: { pagination: { page: query.page, limit: query.limit, total } },
    };
  }

  @RequireCapability('bc_moderate_reviews')
  @AuditAction('provider.review_moderated')
  @Post(':id/moderate')
  async moderate(@Param('id') id: string, @Body() dto: ModerateReviewDto, @CurrentUser() user: AuthenticatedUser) {
    // Actor from the session, never the body.
    const row = await this.reviews.moderate({
      reviewId: id,
      decision: dto.decision,
      actorUserId: user.userId,
      reason: dto.reason,
    });
    return { id: row.id, status: row.status, moderatedAt: row.moderatedAt?.toISOString() ?? null };
  }
}
