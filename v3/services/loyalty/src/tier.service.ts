import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { TierEntity } from './entities/loyalty.entities';

export interface TierView {
  id: string;
  slug: string;
  name: string;
  thresholdPoints: number;
  sortOrder: number;
}

export interface TierProgress {
  lifetimePoints: number;
  currentTier: TierView | null;
  nextTier: TierView | null;
  pointsToNext: number | null;
  percentToNext: number | null;
}

/**
 * Deterministic tier qualification.
 *
 * A customer's tier is NEVER stored -- it is computed from lifetime earned
 * points against the configurable `loyalty.tiers` table on every read, so
 * there is no cache to go stale and no second source of truth to reconcile
 * against the ledger. V2's choice, preserved for exactly its stated reason.
 *
 * The qualification rule is `>=`, not `>`: reaching a threshold exactly
 * qualifies. That boundary is the one most likely to be got wrong silently,
 * and it has its own test.
 */
@Injectable()
export class TierService {
  constructor(@InjectRepository(TierEntity) private readonly tiers: Repository<TierEntity>) {}

  private repo(manager?: EntityManager): Repository<TierEntity> {
    return manager ? manager.getRepository(TierEntity) : this.tiers;
  }

  /** Active tiers, threshold-ascending. The order every method below depends on. */
  async activeTiers(manager?: EntityManager): Promise<TierView[]> {
    const rows = await this.repo(manager).find({
      where: { isActive: true },
      order: { thresholdPoints: 'ASC' },
    });
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      thresholdPoints: r.thresholdPoints,
      sortOrder: r.sortOrder,
    }));
  }

  /** The highest active tier the given lifetime total qualifies for, or null. */
  async tierForPoints(lifetimePoints: number, manager?: EntityManager): Promise<TierView | null> {
    const tiers = await this.activeTiers(manager);
    let qualifying: TierView | null = null;
    for (const tier of tiers) {
      // Ascending order means the LAST match is the highest qualifying tier.
      if (lifetimePoints >= tier.thresholdPoints) qualifying = tier;
    }
    return qualifying;
  }

  async tierSlugForPoints(lifetimePoints: number, manager?: EntityManager): Promise<string | null> {
    return (await this.tierForPoints(lifetimePoints, manager))?.slug ?? null;
  }

  /**
   * The customer's current tier slug.
   *
   * Takes the lifetime total as a callback rather than importing
   * LoyaltyLedgerService, which would make the two classes mutually
   * dependent. The ledger passes its own already-computed figure in.
   */
  async currentTierSlug(userId: string, manager?: EntityManager): Promise<string | null> {
    const lifetime = await this.lifetimeEarnedFor(userId, manager);
    return this.tierSlugForPoints(lifetime, manager);
  }

  /**
   * Reads lifetime earned directly, so `currentTierSlug` does not require the
   * ledger service and create a dependency cycle. Deliberately the same
   * query the ledger runs -- if these two ever disagree the tier is wrong, so
   * they are asserted equal by test rather than left to inspection.
   */
  private async lifetimeEarnedFor(userId: string, manager?: EntityManager): Promise<number> {
    const runner = manager ?? this.tiers.manager;
    const row = await runner.query(
      'SELECT COALESCE(SUM(points), 0)::int AS total FROM loyalty.points_entries WHERE user_id = $1 AND points > 0',
      [userId],
    );
    return Number(row?.[0]?.total ?? 0);
  }

  async progressFor(userId: string, lifetimePoints: number, manager?: EntityManager): Promise<TierProgress> {
    const tiers = await this.activeTiers(manager);
    const current = await this.tierForPoints(lifetimePoints, manager);
    const next = tiers.find((t) => t.thresholdPoints > lifetimePoints) ?? null;

    const pointsToNext = next ? Math.max(0, next.thresholdPoints - lifetimePoints) : null;

    let percentToNext: number | null = null;
    if (next) {
      const floor = current?.thresholdPoints ?? 0;
      // max(1, ...) guards a zero-width span -- two tiers configured at the
      // same threshold -- from a division by zero. The schema's partial unique
      // index on active thresholds now makes that unrepresentable, but the
      // guard stays: the index only covers ACTIVE tiers.
      const span = Math.max(1, next.thresholdPoints - floor);
      percentToNext = Math.round(Math.min(100, Math.max(0, ((lifetimePoints - floor) / span) * 100)) * 10) / 10;
    }

    return { lifetimePoints, currentTier: current, nextTier: next, pointsToNext, percentToNext };
  }
}
