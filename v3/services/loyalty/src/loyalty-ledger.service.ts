import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { insertOnce } from '@beauclick/events';
import {
  EVENT_CONTRACT_REGISTRY,
  EventContractRegistry,
  LoyaltyPointsEarned,
  LoyaltyTierChanged,
  emitContractEvent,
} from '@beauclick/event-contracts';
import {
  LoyaltyOutboxEntity,
  PointsEntryEntity,
  TierCrossingEntity,
} from './entities/loyalty.entities';
import { LoyaltyConfig, LoyaltyReason } from './loyalty.config';
import { BenefitService } from './benefit.service';
import { TierService } from './tier.service';

export interface AwardInput {
  userId: string;
  reason: LoyaltyReason;
  referenceType: string;
  referenceId: string;
  /** Overrides the configured points for this reason. Only used by manual adjustments. */
  overridePoints?: number;
}

export interface AwardResult {
  awarded: boolean;
  entryId: string | null;
  points: number;
  lifetimeEarned: number;
  tierChanged: boolean;
}

/**
 * The points ledger.
 *
 * The idempotency guarantee is the whole point of this class, and it is worth
 * being precise about how it works, because "we check before inserting" is
 * NOT the guarantee:
 *
 *   The fast path is an `INSERT ... ON CONFLICT DO NOTHING` against
 *   `uq_points_entries_reference_once`. There is deliberately no
 *   read-then-write: a SELECT-then-INSERT lets two concurrent handlers both
 *   observe "not yet awarded" and both insert, and V2's own `has_awarded()`
 *   docblock is explicit that the check is defence in depth while the UNIQUE
 *   index is the actual guarantee. Here the index is the ONLY mechanism, so
 *   there is no weaker path to accidentally rely on.
 *
 * This matters because the outbox is at-least-once by design. A redelivered
 * `BookingCompleted` is not an exceptional case to be defended against -- it
 * is the expected steady state, and `awarded: false` is a normal return value,
 * not an error.
 */
@Injectable()
export class LoyaltyLedgerService {
  private readonly auditLog = new Logger('AUDIT:loyalty');

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(PointsEntryEntity) private readonly entries: Repository<PointsEntryEntity>,
    private readonly config: LoyaltyConfig,
    private readonly tiers: TierService,
    private readonly benefits: BenefitService,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  /**
   * Awards points for a domain fact, exactly once per (referenceType,
   * referenceId, reason).
   *
   * Runs in one transaction covering the ledger row, the tier-crossing row,
   * and both outbox events -- so a customer can never be observed to have
   * points without the event that explains them, and can never receive a
   * "you reached Gold" notification for a crossing that rolled back.
   */
  async award(input: AwardInput, manager?: EntityManager): Promise<AwardResult> {
    const run = async (m: EntityManager): Promise<AwardResult> => {
      const basePoints = input.overridePoints ?? this.config.pointsFor(input.reason);

      // A zero-point award is a real configuration state (see
      // `pointsReferralQualified`, which defaults to 0 precisely because no
      // business figure exists). Recording a zero row would clutter the
      // ledger and, worse, would consume the idempotency slot -- so if the
      // policy is later set to a real number, the award could never happen.
      if (basePoints === 0) {
        return { awarded: false, entryId: null, points: 0, lifetimeEarned: await this.lifetimeEarned(input.userId, m), tierChanged: false };
      }

      const multiplierBp = await this.benefits.pointsMultiplierBp(input.userId, m);
      // Integer arithmetic with explicit rounding, never a float multiply:
      // points are a whole-number currency and `10 * 1.15` is 11.499999... in
      // binary floating point.
      const points = Math.round((basePoints * multiplierBp) / 10000);

      const tierBefore = await this.tiers.currentTierSlug(input.userId, m);

      const entryId = uuidv7();
      // `insertOnce` rather than reading `identifiers`: TypeORM echoes back a
      // caller-supplied id whether or not the row was inserted, so the obvious
      // check would report every duplicate as a fresh award. See insert-once.ts.
      const won = await insertOnce(
        m
          .createQueryBuilder()
          .insert()
          .into(PointsEntryEntity)
          .values({
            id: entryId,
            userId: input.userId,
            points,
            basePoints,
            multiplierBp,
            reason: input.reason,
            referenceType: input.referenceType,
            referenceId: input.referenceId,
          }),
      );
      if (!won) {
        this.auditLog.log({ action: 'loyalty.award_deduplicated', userId: input.userId, reason: input.reason, referenceId: input.referenceId });
        return {
          awarded: false,
          entryId: null,
          points: 0,
          lifetimeEarned: await this.lifetimeEarned(input.userId, m),
          tierChanged: false,
        };
      }

      const lifetimeEarned = await this.lifetimeEarned(input.userId, m);

      await emitContractEvent(this.contracts, m, LoyaltyOutboxEntity, LoyaltyPointsEarned, {
        aggregateId: input.userId,
        payload: {
          userId: input.userId,
          entryId,
          points,
          reason: input.reason,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          lifetimeEarned,
          earnedAt: new Date().toISOString(),
        },
      });

      const tierChanged = await this.recordTierCrossingIfChanged(m, input.userId, tierBefore, lifetimeEarned);

      this.auditLog.log({ action: 'loyalty.awarded', userId: input.userId, points, reason: input.reason });
      return { awarded: true, entryId, points, lifetimeEarned, tierChanged };
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  /**
   * Records a tier crossing if the computed tier differs from before.
   *
   * The tier is still never stored -- `currentTierSlug` recomputes it from the
   * ledger every time. What is stored is the crossing event, guarded by a
   * unique index on (user, toTier, lifetimeEarned) so a redelivered award that
   * recomputes the same crossing inserts nothing and emits nothing.
   */
  private async recordTierCrossingIfChanged(
    m: EntityManager,
    userId: string,
    fromTierSlug: string | null,
    lifetimeEarned: number,
  ): Promise<boolean> {
    const toTierSlug = await this.tiers.tierSlugForPoints(lifetimeEarned, m);
    if (toTierSlug === fromTierSlug) return false;

    const recorded = await insertOnce(
      m
        .createQueryBuilder()
        .insert()
        .into(TierCrossingEntity)
        .values({ id: uuidv7(), userId, fromTierSlug, toTierSlug, lifetimeEarned }),
    );

    if (!recorded) return false;

    await emitContractEvent(this.contracts, m, LoyaltyOutboxEntity, LoyaltyTierChanged, {
      aggregateId: userId,
      payload: { userId, fromTierSlug, toTierSlug, lifetimeEarned, changedAt: new Date().toISOString() },
    });
    return true;
  }

  /** Spendable balance: every row, positive and negative. */
  async balance(userId: string, manager?: EntityManager): Promise<number> {
    const repo = manager ? manager.getRepository(PointsEntryEntity) : this.entries;
    const row = await repo
      .createQueryBuilder('e')
      .select('COALESCE(SUM(e.points), 0)', 'total')
      .where('e.user_id = :userId', { userId })
      .getRawOne<{ total: string }>();
    return Number(row?.total ?? 0);
  }

  /**
   * Lifetime earned: positive rows only.
   *
   * The qualification question is "how much have you earned", which is a
   * different question from "how much can you still spend". Redeeming points
   * must never demote a customer's tier -- V2's rule, preserved deliberately
   * and load-bearing for the whole tier model.
   *
   * When `LOYALTY_TIER_BASIS` is `rolling_365`, the same sum is taken over the
   * trailing year instead. Implemented rather than merely configurable so the
   * business can actually adopt it without a code change.
   */
  async lifetimeEarned(userId: string, manager?: EntityManager): Promise<number> {
    const repo = manager ? manager.getRepository(PointsEntryEntity) : this.entries;
    const qb = repo
      .createQueryBuilder('e')
      .select('COALESCE(SUM(e.points), 0)', 'total')
      .where('e.user_id = :userId AND e.points > 0', { userId });

    if (this.config.tierQualificationBasis === 'rolling_365') {
      qb.andWhere("e.created_at >= now() - interval '365 days'");
    }

    const row = await qb.getRawOne<{ total: string }>();
    return Number(row?.total ?? 0);
  }

  async history(userId: string, limit: number, offset: number): Promise<{ items: PointsEntryEntity[]; total: number }> {
    const [items, total] = await this.entries.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { items, total };
  }
}
