import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { BeautyGoalEntity, BeautyProfileEntity, TimelineEntryEntity } from './entities/journey.entities';

/**
 * journey's subject-data contract -- the module where erasure DELETES rather
 * than anonymizes, and the reason is worth stating because it is the opposite
 * of every other module's answer.
 *
 * The platform's default is anonymization with referential integrity: keep the
 * row, destroy the identity it points at. That default exists because most
 * rows are half of a two-party fact -- a booking the professional still needs,
 * an order the ledger references. **Nothing in `journey` is like that.** A
 * beauty profile is one person's stated preferences, a goal is one person's
 * stated intention with a free-text title they wrote, and a timeline is one
 * person's history of their own activity. All three are single-party, and none
 * of them is referenced by anybody else's record.
 *
 * For rows like that, keeping them would be keeping personal data for no
 * reason -- so they go. Applying the anonymization default here out of
 * consistency would be the wrong answer arrived at by rule-following.
 */
@Injectable()
export class JourneySubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'journey';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    { table: 'journey.beauty_profiles', disposition: 'subject_data' },
    { table: 'journey.beauty_goals', disposition: 'subject_data' },
    { table: 'journey.timeline_entries', disposition: 'subject_data' },
    { table: 'journey.outbox_events', disposition: 'retained', reason: 'Transactional outbox.' },
  ];

  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const profile = await manager.getRepository(BeautyProfileEntity).findOne({ where: { userId } });
    const goals = await manager.getRepository(BeautyGoalEntity).find({ where: { userId } });
    const timeline = await manager.getRepository(TimelineEntryEntity).find({
      where: { userId },
      order: { occurredAt: 'DESC' },
    });

    return [
      {
        key: 'beauty_profile',
        description: 'ترجیحات زیبایی شما',
        rows: profile
          ? [
              {
                preferredCityId: profile.preferredCityId,
                preferredSpecialtyIds: profile.preferredSpecialtyIds,
                budgetMinToman: profile.budgetMinToman,
                budgetMaxToman: profile.budgetMaxToman,
                notes: profile.notes,
                updatedAt: profile.updatedAt,
              },
            ]
          : [],
      },
      {
        key: 'goals',
        description: 'هدف‌های زیبایی شما',
        rows: goals.map((g) => ({
          id: g.id,
          title: g.title,
          specialtyId: g.specialtyId,
          cityId: g.cityId,
          budgetToman: g.budgetToman,
          targetDate: g.targetDate,
          status: g.status,
          createdAt: g.createdAt,
        })),
      },
      {
        key: 'timeline',
        description: 'خط زمانی فعالیت‌های شما',
        rows: timeline.map((t) => ({
          id: t.id,
          entryType: t.entryType,
          sourceType: t.sourceType,
          sourceId: t.sourceId,
          metadata: t.metadata,
          occurredAt: t.occurredAt,
        })),
      },
    ];
  }

  async eraseSubjectData(manager: EntityManager, userId: string): Promise<SubjectErasureOutcome> {
    let deleted = 0;
    for (const table of ['journey.timeline_entries', 'journey.beauty_goals', 'journey.beauty_profiles']) {
      const result = await manager.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
      deleted += Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
    }

    return { moduleKey: this.moduleKey, anonymized: 0, deleted, retained: [] };
  }
}
