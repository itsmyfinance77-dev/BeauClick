import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import { RequireCapability } from '@beauclick/auth';
import { AuthenticatedUser, CurrentUser, PageQueryDto } from '@beauclick/http';
import { BenefitService } from './benefit.service';
import { LoyaltyConfig } from './loyalty.config';
import { LoyaltyLedgerService } from './loyalty-ledger.service';
import { MembershipService } from './membership.service';
import { TierService } from './tier.service';

export class ActivateMembershipDto {
  @IsUUID()
  planId!: string;
}

/**
 * The customer's own loyalty surface.
 *
 * Every route derives its subject from the session and takes NO user
 * identifier. This is the same shape Phase 2 gave `MyFinanceService` and for
 * the same reason: a route that accepts a `userId` argument is one missing
 * validation away from reading someone else's balance, while a route with no
 * such parameter has no such failure mode to get wrong.
 */
@Controller('v1/me/loyalty')
export class LoyaltyController {
  constructor(
    private readonly ledger: LoyaltyLedgerService,
    private readonly tiers: TierService,
    private readonly memberships: MembershipService,
    private readonly benefits: BenefitService,
  ) {}

  @Get('summary')
  async summary(@CurrentUser() user: AuthenticatedUser) {
    const lifetimeEarned = await this.ledger.lifetimeEarned(user.userId);
    const [balance, progress, membership, benefits] = await Promise.all([
      this.ledger.balance(user.userId),
      this.tiers.progressFor(user.userId, lifetimeEarned),
      this.memberships.forUser(user.userId),
      this.benefits.benefitsForUser(user.userId),
    ]);

    return {
      balance,
      lifetimeEarned,
      tier: progress.currentTier,
      nextTier: progress.nextTier,
      pointsToNextTier: progress.pointsToNext,
      percentToNextTier: progress.percentToNext,
      membership: membership
        ? {
            planId: membership.plan.id,
            planName: membership.plan.name,
            status: membership.membership.status,
            source: membership.membership.activationSource,
            startedAt: membership.membership.startedAt,
            expiresAt: membership.membership.expiresAt,
          }
        : null,
      benefits: benefits.map((b) => ({ type: b.benefitType, label: b.label, config: b.config })),
    };
  }

  @Get('history')
  async history(@CurrentUser() user: AuthenticatedUser, @Query() pagination: PageQueryDto) {
    const page = pagination.page ?? 1;
    const pageSize = pagination.limit ?? 20;
    const { items, total } = await this.ledger.history(user.userId, pageSize, (page - 1) * pageSize);
    return {
      items: items.map((e) => ({
        id: e.id,
        points: e.points,
        basePoints: e.basePoints,
        multiplierBp: e.multiplierBp,
        reason: e.reason,
        createdAt: e.createdAt,
      })),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  @Get('tiers')
  async tiers_(@CurrentUser() user: AuthenticatedUser) {
    const lifetimeEarned = await this.ledger.lifetimeEarned(user.userId);
    const all = await this.tiers.activeTiers();
    return {
      lifetimeEarned,
      tiers: all.map((t) => ({
        slug: t.slug,
        name: t.name,
        thresholdPoints: t.thresholdPoints,
        achieved: lifetimeEarned >= t.thresholdPoints,
      })),
    };
  }

  @Get('membership/plans')
  async plans() {
    const plans = await this.memberships.activePlans();
    return plans.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      isPaid: p.isPaid,
      priceToman: p.priceToman,
      billingPeriodDays: p.billingPeriodDays,
    }));
  }

  /**
   * Self-service activation is limited to FREE plans.
   *
   * A paid plan must go through the commerce/payment path, because activating
   * it here would grant a commercial entitlement with no order, no payment,
   * and no ledger entry -- a customer could self-grant a paid membership by
   * calling this route. The refusal is in the service boundary, not in the UI.
   */
  @Post('membership')
  @HttpCode(HttpStatus.OK)
  async activate(@CurrentUser() user: AuthenticatedUser, @Body() dto: ActivateMembershipDto) {
    const plans = await this.memberships.activePlans();
    const plan = plans.find((p) => p.id === dto.planId);
    if (!plan || plan.isPaid) {
      // Identical response for "no such plan" and "that plan is paid" -- a
      // differing error would enumerate which plans exist and which cost money.
      return { activated: false, reason: 'not_self_activatable' };
    }
    const result = await this.memberships.activate(user.userId, dto.planId, 'manual');
    return { activated: result.changed };
  }

  @Delete('membership')
  @HttpCode(HttpStatus.OK)
  async cancel(@CurrentUser() user: AuthenticatedUser) {
    return { cancelled: await this.memberships.cancel(user.userId) };
  }
}

@Controller('v1/admin/loyalty')
export class LoyaltyAdminController {
  constructor(private readonly config: LoyaltyConfig) {}

  /**
   * Reports which loyalty policy values are still running on V2's provisional
   * placeholders. Deliberately a live route rather than a document: GAP-10's
   * risk is that a placeholder quietly becomes the de-facto policy because
   * nobody was reminded it was one.
   */
  @RequireCapability('bc_manage_platform')
  @Get('policy')
  policy() {
    return {
      policy: this.config.policy,
      tierQualificationBasis: this.config.tierQualificationBasis,
      unresolvedBusinessDecisions: this.config.unresolvedPolicies(),
    };
  }
}
