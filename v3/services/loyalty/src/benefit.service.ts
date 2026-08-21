import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { BenefitEntity, MembershipEntity, TierEntity } from './entities/loyalty.entities';
import { TierService } from './tier.service';

export interface BenefitView {
  id: string;
  sourceType: 'tier' | 'membership_plan';
  benefitType: string;
  label: string;
  config: Record<string, number | string>;
}

/**
 * Entitlements, resolved for a user.
 *
 * The rule that matters and is easy to get wrong: a tier benefit and a
 * membership benefit are INDEPENDENT and a customer can hold both. Qualifying
 * for a tier does not imply a membership, and holding a membership does not
 * imply a tier -- V2's explicit "keep loyalty and membership separate"
 * instruction, preserved.
 *
 * When two benefits of the same type apply, the HIGHEST wins rather than the
 * sum. Two 10% discounts must not become 20%, and two 1.2x multipliers must
 * not become 1.44x -- the same non-compounding principle Phase 2 built into
 * the pricing engine, applied here at the source.
 */
@Injectable()
export class BenefitService {
  constructor(
    @InjectRepository(BenefitEntity) private readonly benefits: Repository<BenefitEntity>,
    @InjectRepository(MembershipEntity) private readonly memberships: Repository<MembershipEntity>,
    @InjectRepository(TierEntity) private readonly tiers: Repository<TierEntity>,
    private readonly tierService: TierService,
  ) {}

  async benefitsForUser(userId: string, manager?: EntityManager): Promise<BenefitView[]> {
    const benefitRepo = manager ? manager.getRepository(BenefitEntity) : this.benefits;
    const membershipRepo = manager ? manager.getRepository(MembershipEntity) : this.memberships;
    const tierRepo = manager ? manager.getRepository(TierEntity) : this.tiers;

    const sources: Array<{ type: 'tier' | 'membership_plan'; id: string }> = [];

    const tierSlug = await this.tierService.currentTierSlug(userId, manager);
    if (tierSlug) {
      const tier = await tierRepo.findOne({ where: { slug: tierSlug } });
      if (tier) sources.push({ type: 'tier', id: tier.id });
    }

    const membership = await membershipRepo.findOne({ where: { userId } });
    // An expired or cancelled membership grants nothing. Checked here rather
    // than trusted from a caller, because every benefit read must agree.
    if (membership && membership.status === 'active') {
      sources.push({ type: 'membership_plan', id: membership.planId });
    }

    if (sources.length === 0) return [];

    const rows = await benefitRepo
      .createQueryBuilder('b')
      .where('b.is_active = true')
      .andWhere(
        '(' + sources.map((_, i) => `(b.source_type = :t${i} AND b.source_id = :i${i})`).join(' OR ') + ')',
        Object.fromEntries(sources.flatMap((s, i) => [[`t${i}`, s.type], [`i${i}`, s.id]])),
      )
      .orderBy('b.sort_order', 'ASC')
      .getMany();

    return rows.map((r) => ({
      id: r.id,
      sourceType: r.sourceType,
      benefitType: r.benefitType,
      label: r.label,
      config: r.config ?? {},
    }));
  }

  /**
   * The highest applicable points multiplier, in basis points.
   *
   * Floors at 10000 (1.0x): a benefit can only ever help. A misconfigured
   * `multiplierBp: 5000` would otherwise silently halve a customer's earnings
   * — a benefit that penalises is never what an admin meant to configure.
   */
  async pointsMultiplierBp(userId: string, manager?: EntityManager): Promise<number> {
    const benefits = await this.benefitsForUser(userId, manager);
    return benefits
      .filter((b) => b.benefitType === 'bonus_points_multiplier')
      .reduce((max, b) => Math.max(max, Number(b.config.multiplierBp ?? 10000)), 10000);
  }

  /** The highest applicable discount, in basis points (1000 = 10%). Zero when none applies. */
  async discountPercentBp(userId: string, manager?: EntityManager): Promise<number> {
    const benefits = await this.benefitsForUser(userId, manager);
    return benefits
      .filter((b) => b.benefitType === 'discount_percentage')
      .reduce((max, b) => Math.max(max, Number(b.config.percentBp ?? 0)), 0);
  }
}
