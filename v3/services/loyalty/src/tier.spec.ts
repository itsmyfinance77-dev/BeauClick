import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { createInMemoryDataSource } from '@beauclick/testing';
import { BenefitEntity, MembershipEntity, MembershipPlanEntity, PointsEntryEntity, TierEntity } from './entities/loyalty.entities';
import { TierService } from './tier.service';
import { BenefitService } from './benefit.service';

/**
 * Fast-layer cases for the pure qualification and entitlement rules.
 *
 * Note what is deliberately NOT here: idempotency, concurrency, and anything
 * resting on a unique index. Phase 2 established that pg-mem does not honour
 * TypeORM's ROLLBACK, so no test on this layer can prove anything about
 * atomicity or isolation -- those live in the real-PostgreSQL suite.
 */
describe('TierService', () => {
  let dataSource: DataSource;
  let tiers: TierService;

  const seedTier = async (slug: string, threshold: number, isActive = true) => {
    await dataSource.getRepository(TierEntity).save({
      id: uuidv7(),
      slug,
      name: slug,
      thresholdPoints: threshold,
      sortOrder: threshold,
      isActive,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  };

  beforeEach(async () => {
    dataSource = await createInMemoryDataSource([
      PointsEntryEntity,
      TierEntity,
      MembershipPlanEntity,
      MembershipEntity,
      BenefitEntity,
    ]);
    tiers = new TierService(dataSource.getRepository(TierEntity));
    await seedTier('bronze', 0);
    await seedTier('silver', 100);
    await seedTier('gold', 500);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('qualifies at a threshold EXACTLY, not just above it', async () => {
    // The boundary most likely to be got wrong silently. V2 used >= and this
    // preserves it -- a customer who reaches 500 is Gold, not "almost Gold".
    expect((await tiers.tierForPoints(499))?.slug).toBe('silver');
    expect((await tiers.tierForPoints(500))?.slug).toBe('gold');
    expect((await tiers.tierForPoints(501))?.slug).toBe('gold');
  });

  it('returns the HIGHEST qualifying tier, not the first match', async () => {
    expect((await tiers.tierForPoints(1000))?.slug).toBe('gold');
  });

  it('returns null when the total is below every configured threshold', async () => {
    await dataSource.getRepository(TierEntity).clear();
    await seedTier('silver', 100);
    expect(await tiers.tierForPoints(50)).toBeNull();
  });

  it('ignores inactive tiers', async () => {
    await seedTier('platinum', 900, false);
    expect((await tiers.tierForPoints(1000))?.slug).toBe('gold');
  });

  it('computes progress toward the next tier', async () => {
    const progress = await tiers.progressFor(uuidv7(), 300);
    expect(progress.currentTier?.slug).toBe('silver');
    expect(progress.nextTier?.slug).toBe('gold');
    expect(progress.pointsToNext).toBe(200);
    // 300 sits halfway between silver's 100 and gold's 500.
    expect(progress.percentToNext).toBeCloseTo(50, 1);
  });

  it('reports no next tier once the top is reached', async () => {
    const progress = await tiers.progressFor(uuidv7(), 900);
    expect(progress.currentTier?.slug).toBe('gold');
    expect(progress.nextTier).toBeNull();
    expect(progress.pointsToNext).toBeNull();
    expect(progress.percentToNext).toBeNull();
  });
});

describe('BenefitService', () => {
  let dataSource: DataSource;
  let benefits: BenefitService;
  let userId: string;
  let tierId: string;
  let planId: string;

  beforeEach(async () => {
    dataSource = await createInMemoryDataSource([
      PointsEntryEntity,
      TierEntity,
      MembershipPlanEntity,
      MembershipEntity,
      BenefitEntity,
    ]);
    userId = uuidv7();
    tierId = uuidv7();
    planId = uuidv7();

    await dataSource.getRepository(TierEntity).save({
      id: tierId,
      slug: 'gold',
      name: 'Gold',
      thresholdPoints: 0,
      sortOrder: 0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await dataSource.getRepository(MembershipPlanEntity).save({
      id: planId,
      slug: 'vip',
      name: 'VIP',
      tierId: null,
      isPaid: false,
      priceToman: null,
      billingPeriodDays: null,
      isActive: true,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const tierService = new TierService(dataSource.getRepository(TierEntity));
    benefits = new BenefitService(
      dataSource.getRepository(BenefitEntity),
      dataSource.getRepository(MembershipEntity),
      dataSource.getRepository(TierEntity),
      tierService,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  const addBenefit = async (
    sourceType: 'tier' | 'membership_plan',
    sourceId: string,
    benefitType: 'bonus_points_multiplier' | 'discount_percentage',
    config: Record<string, number>,
  ) => {
    await dataSource.getRepository(BenefitEntity).save({
      id: uuidv7(),
      sourceType,
      sourceId,
      benefitType,
      label: benefitType,
      config,
      isActive: true,
      sortOrder: 0,
      createdAt: new Date(),
    });
  };

  const activateMembership = async () => {
    await dataSource.getRepository(MembershipEntity).save({
      id: uuidv7(),
      userId,
      planId,
      status: 'active',
      activationSource: 'manual',
      startedAt: new Date(),
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  };

  it('defaults to no multiplier and no discount', async () => {
    expect(await benefits.pointsMultiplierBp(userId)).toBe(10000);
    expect(await benefits.discountPercentBp(userId)).toBe(0);
  });

  it('takes the HIGHEST applicable benefit, never the sum', async () => {
    await activateMembership();
    await addBenefit('membership_plan', planId, 'discount_percentage', { percentBp: 1000 });
    await addBenefit('membership_plan', planId, 'discount_percentage', { percentBp: 1500 });

    // Two 10%+15% benefits must not become 25%. Same non-compounding rule the
    // pricing engine enforces, applied here at the source.
    expect(await benefits.discountPercentBp(userId)).toBe(1500);
  });

  it('floors the multiplier at 1.0 so a misconfigured benefit can never penalise', async () => {
    await activateMembership();
    await addBenefit('membership_plan', planId, 'bonus_points_multiplier', { multiplierBp: 5000 });
    // A benefit that halves earnings is never what an admin meant to configure.
    expect(await benefits.pointsMultiplierBp(userId)).toBe(10000);
  });

  it('grants nothing from an EXPIRED membership', async () => {
    await dataSource.getRepository(MembershipEntity).save({
      id: uuidv7(),
      userId,
      planId,
      status: 'expired',
      activationSource: 'manual',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await addBenefit('membership_plan', planId, 'discount_percentage', { percentBp: 2000 });

    expect(await benefits.discountPercentBp(userId)).toBe(0);
  });

  it('grants nothing from an inactive benefit row', async () => {
    await activateMembership();
    await dataSource.getRepository(BenefitEntity).save({
      id: uuidv7(),
      sourceType: 'membership_plan',
      sourceId: planId,
      benefitType: 'discount_percentage',
      label: 'retired',
      config: { percentBp: 3000 },
      isActive: false,
      sortOrder: 0,
      createdAt: new Date(),
    });
    expect(await benefits.discountPercentBp(userId)).toBe(0);
  });
});
