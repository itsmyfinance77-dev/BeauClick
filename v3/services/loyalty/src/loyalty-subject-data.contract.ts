import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { PointsEntryEntity, MembershipEntity, TierCrossingEntity } from './entities/loyalty.entities';

/**
 * loyalty's subject-data contract.
 *
 * Points are money-adjacent without being money: they are earned against real
 * completed bookings and paid orders, and the entries are the audit trail that
 * makes a balance defensible. Deleting them on erasure would not protect
 * anybody -- once the identity is anonymized a points entry says "+50 for a
 * completed booking" about nobody -- and it WOULD destroy the only record of
 * why a balance was what it was.
 *
 * `reason` is a stable enum-shaped key written by the platform
 * (`booking_completed`, `review_created`), never free text a user typed, so
 * there is nothing here to redact.
 */
@Injectable()
export class LoyaltySubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'loyalty';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    {
      table: 'loyalty.points_entries',
      disposition: 'retained',
      reason:
        'The append-style audit trail behind a points balance, keyed by platform-written reason codes. Anonymous once the identity behind user_id is destroyed.',
    },
    {
      table: 'loyalty.memberships',
      disposition: 'retained',
      reason: 'A paid or granted membership term, referenced by orders. Ids, a plan, and dates.',
    },
    {
      table: 'loyalty.tier_crossings',
      disposition: 'retained',
      reason: 'When a member crossed a tier threshold. Two tier slugs and a number.',
    },
    { table: 'loyalty.tiers', disposition: 'no_subject_data', reason: 'The tier catalogue.' },
    { table: 'loyalty.membership_plans', disposition: 'no_subject_data', reason: 'The plan catalogue.' },
    { table: 'loyalty.benefits', disposition: 'no_subject_data', reason: 'What each tier or plan grants.' },
    { table: 'loyalty.outbox_events', disposition: 'retained', reason: 'Transactional outbox.' },
  ];

  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const points = await manager.getRepository(PointsEntryEntity).find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    const memberships = await manager.getRepository(MembershipEntity).find({ where: { userId } });
    const crossings = await manager.getRepository(TierCrossingEntity).find({ where: { userId } });

    return [
      {
        key: 'points',
        description: 'امتیازهای وفاداری شما',
        rows: points.map((p) => ({
          id: p.id,
          points: p.points,
          basePoints: p.basePoints,
          multiplierBp: p.multiplierBp,
          reason: p.reason,
          referenceType: p.referenceType,
          referenceId: p.referenceId,
          createdAt: p.createdAt,
        })),
      },
      {
        key: 'memberships',
        description: 'عضویت‌های شما',
        rows: memberships.map((m) => ({
          id: m.id,
          planId: m.planId,
          status: m.status,
          activationSource: m.activationSource,
          startedAt: m.startedAt,
          expiresAt: m.expiresAt,
        })),
      },
      {
        key: 'tier_crossings',
        description: 'تغییرات سطح باشگاه مشتریان شما',
        rows: crossings.map((c) => ({
          id: c.id,
          fromTierSlug: c.fromTierSlug,
          toTierSlug: c.toTierSlug,
          lifetimeEarned: c.lifetimeEarned,
          createdAt: c.createdAt,
        })),
      },
    ];
  }

  async eraseSubjectData(): Promise<SubjectErasureOutcome> {
    return {
      moduleKey: this.moduleKey,
      anonymized: 0,
      deleted: 0,
      retained: [
        { table: 'loyalty.points_entries', reason: 'the audit trail behind a balance; carries no free text' },
      ],
    };
  }
}
