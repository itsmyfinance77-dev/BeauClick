import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import {
  EVENT_CONTRACT_REGISTRY,
  EventContractRegistry,
  MembershipActivated,
  MembershipEnded,
  emitContractEvent,
} from '@beauclick/event-contracts';
import {
  ActivationSource,
  LoyaltyOutboxEntity,
  MembershipEntity,
  MembershipPlanEntity,
  TierEntity,
} from './entities/loyalty.entities';
import { TierService } from './tier.service';
import { AuditLogger } from '@beauclick/events';

/**
 * Membership is account STATE, not a ledger: at most one row per user,
 * mutated in place. Its audit trail lives in the event stream rather than in a
 * fifth table.
 *
 * The rule that carries the most product weight, preserved from V2 exactly:
 * **tier-qualification activation is additive and NEVER overwrites a
 * membership from a different source.** A customer who was granted a plan
 * manually, or who is paying for one, must not have it silently replaced
 * because they crossed a points threshold. The check is explicit in `syncFromTier`.
 */
@Injectable()
export class MembershipService {
  private readonly auditLog = new AuditLogger('loyalty');

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(MembershipEntity) private readonly memberships: Repository<MembershipEntity>,
    @InjectRepository(MembershipPlanEntity) private readonly plans: Repository<MembershipPlanEntity>,
    @InjectRepository(TierEntity) private readonly tiers: Repository<TierEntity>,
    private readonly tierService: TierService,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  async forUser(userId: string, manager?: EntityManager): Promise<{ membership: MembershipEntity; plan: MembershipPlanEntity } | null> {
    const membershipRepo = manager ? manager.getRepository(MembershipEntity) : this.memberships;
    const planRepo = manager ? manager.getRepository(MembershipPlanEntity) : this.plans;
    const membership = await membershipRepo.findOne({ where: { userId } });
    if (!membership) return null;
    const plan = await planRepo.findOne({ where: { id: membership.planId } });
    return plan ? { membership, plan } : null;
  }

  async activePlans(): Promise<MembershipPlanEntity[]> {
    return this.plans.find({ where: { isActive: true }, order: { sortOrder: 'ASC' } });
  }

  /**
   * Activates a plan for a user. Idempotent by upsert on `UNIQUE(user_id)`.
   *
   * Returns `changed: false` when the user already holds exactly this plan,
   * active -- so a redelivered qualification event emits no second
   * `MembershipActivated` and triggers no second welcome notification.
   */
  async activate(
    userId: string,
    planId: string,
    source: ActivationSource,
    manager?: EntityManager,
  ): Promise<{ changed: boolean; membershipId: string | null }> {
    const run = async (m: EntityManager) => {
      const plan = await m.getRepository(MembershipPlanEntity).findOne({ where: { id: planId, isActive: true } });
      if (!plan) return { changed: false, membershipId: null };

      const existing = await m.getRepository(MembershipEntity).findOne({ where: { userId } });
      if (existing && existing.status === 'active' && existing.planId === planId) {
        return { changed: false, membershipId: existing.id };
      }

      const now = new Date();
      const expiresAt = plan.billingPeriodDays
        ? new Date(now.getTime() + plan.billingPeriodDays * 24 * 60 * 60 * 1000)
        : null;
      const membershipId = existing?.id ?? uuidv7();

      // A single upsert on the unique user_id, rather than
      // check-then-insert-or-update: two concurrent activations would
      // otherwise both find no row and race to insert, and one would fail on
      // the constraint instead of resolving to a single membership.
      await m
        .createQueryBuilder()
        .insert()
        .into(MembershipEntity)
        .values({
          id: membershipId,
          userId,
          planId,
          status: 'active',
          activationSource: source,
          startedAt: now,
          expiresAt,
        })
        .orUpdate(['plan_id', 'status', 'activation_source', 'started_at', 'expires_at', 'updated_at'], ['user_id'])
        .execute();

      await emitContractEvent(this.contracts, m, LoyaltyOutboxEntity, MembershipActivated, {
        aggregateId: userId,
        payload: {
          userId,
          membershipId,
          planId,
          planSlug: plan.slug,
          source,
          activatedAt: now.toISOString(),
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
        },
      });

      this.auditLog.log({ action: 'membership.activated', userId, planId, source });
      return { changed: true, membershipId };
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  /**
   * Auto-activates the membership plan linked to the user's newly-qualified
   * tier, if any.
   *
   * One-directional and additive only. Three guards, each with a real reason:
   *
   *   * no tier, or no plan linked to it -> nothing to do;
   *   * already holding exactly this plan, active -> no-op, so a redelivered
   *     award does not re-emit;
   *   * holding a DIFFERENT active membership that was not itself granted by
   *     tier qualification -> left alone. This is the important one: a paid
   *     or manually-granted membership is a commitment this system did not
   *     make and must not silently revoke.
   */
  async syncFromTier(userId: string, lifetimeEarned: number, manager?: EntityManager): Promise<{ activated: boolean }> {
    const run = async (m: EntityManager) => {
      const tierSlug = await this.tierService.tierSlugForPoints(lifetimeEarned, m);
      if (!tierSlug) return { activated: false };

      const tier = await m.getRepository(TierEntity).findOne({ where: { slug: tierSlug } });
      if (!tier) return { activated: false };

      const plan = await m.getRepository(MembershipPlanEntity).findOne({ where: { tierId: tier.id, isActive: true } });
      if (!plan) return { activated: false };

      const existing = await m.getRepository(MembershipEntity).findOne({ where: { userId } });
      if (existing?.status === 'active') {
        if (existing.planId === plan.id) return { activated: false };
        if (existing.activationSource !== 'tier_qualification') return { activated: false };
      }

      const result = await this.activate(userId, plan.id, 'tier_qualification', m);
      return { activated: result.changed };
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  async cancel(userId: string): Promise<boolean> {
    return this.dataSource.transaction(async (m) => {
      // Compare-and-swap on status: two concurrent cancels resolve to one
      // transition and one event, never two.
      const result = await m
        .createQueryBuilder()
        .update(MembershipEntity)
        .set({ status: 'cancelled' })
        .where('user_id = :userId AND status = :active', { userId, active: 'active' })
        .execute();
      if (result.affected !== 1) return false;

      const membership = await m.getRepository(MembershipEntity).findOneOrFail({ where: { userId } });
      await emitContractEvent(this.contracts, m, LoyaltyOutboxEntity, MembershipEnded, {
        aggregateId: userId,
        payload: {
          userId,
          membershipId: membership.id,
          planId: membership.planId,
          reason: 'cancelled',
          endedAt: new Date().toISOString(),
        },
      });
      this.auditLog.log({ action: 'membership.cancelled', userId });
      return true;
    });
  }

  /**
   * Expires every active membership whose term has passed.
   *
   * Never deletes the row -- an expired membership is a fact about the
   * customer's history, and its absence would make "did they ever hold one"
   * unanswerable. Each expiry is its own transaction so one bad row cannot
   * roll back a whole sweep.
   */
  async expireDue(limit = 200): Promise<number> {
    const due = await this.memberships.find({
      where: { status: 'active', expiresAt: Not(IsNull()) && LessThanOrEqual(new Date()) },
      take: limit,
    });

    let expired = 0;
    for (const row of due) {
      const done = await this.dataSource.transaction(async (m) => {
        const result = await m
          .createQueryBuilder()
          .update(MembershipEntity)
          .set({ status: 'expired' })
          .where('id = :id AND status = :active', { id: row.id, active: 'active' })
          .execute();
        if (result.affected !== 1) return false;

        await emitContractEvent(this.contracts, m, LoyaltyOutboxEntity, MembershipEnded, {
          aggregateId: row.userId,
          payload: {
            userId: row.userId,
            membershipId: row.id,
            planId: row.planId,
            reason: 'expired',
            endedAt: new Date().toISOString(),
          },
        });
        return true;
      });
      if (done) expired += 1;
    }
    return expired;
  }
}
