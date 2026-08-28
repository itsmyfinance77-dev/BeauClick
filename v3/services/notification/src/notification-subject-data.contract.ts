import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { NotificationEntity, NotificationPreferenceEntity } from './entities/notification.entities';

/**
 * notification's subject-data contract.
 *
 * `notifications.payload` is why these rows are deleted rather than kept.
 *
 * The channel port's docblock records the design that avoided the worse
 * problem: a recipient is resolved at dispatch time and never persisted, so
 * unlike V2 there is no phone number or email address on a notification row to
 * scrub. But `payload` holds the TEMPLATE VARIABLES -- a professional's
 * display name, a service name, an amount -- and those are rendered into a
 * message that was sent to this specific person. A notification is also
 * inherently single-party: nobody else's record references it, and the
 * platform has no operational need for a delivered message after the fact.
 *
 * So the rows go, and preferences go with them: a preference is a statement
 * about how one person wants to be contacted, and that person can no longer be
 * contacted at all.
 */
@Injectable()
export class NotificationSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'notification';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    { table: 'notification.notifications', disposition: 'subject_data' },
    { table: 'notification.preferences', disposition: 'subject_data' },
    { table: 'notification.outbox_events', disposition: 'retained', reason: 'Transactional outbox.' },
  ];

  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const notifications = await manager.getRepository(NotificationEntity).find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 1000,
    });
    const preferences = await manager.getRepository(NotificationPreferenceEntity).find({ where: { userId } });

    return [
      {
        key: 'notifications',
        description: 'اعلان‌هایی که برای شما ارسال شده است',
        rows: notifications.map((n) => ({
          id: n.id,
          category: n.category,
          templateKey: n.templateKey,
          channel: n.channel,
          payload: n.payload,
          status: n.status,
          createdAt: n.createdAt,
          sentAt: n.sentAt,
          readAt: n.readAt,
        })),
      },
      {
        key: 'preferences',
        description: 'تنظیمات اعلان شما',
        rows: preferences.map((p) => ({ category: p.category, enabled: p.enabled, updatedAt: p.updatedAt })),
      },
    ];
  }

  async eraseSubjectData(manager: EntityManager, userId: string): Promise<SubjectErasureOutcome> {
    let deleted = 0;
    for (const table of ['notification.notifications', 'notification.preferences']) {
      const result = await manager.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
      deleted += Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
    }
    return { moduleKey: this.moduleKey, anonymized: 0, deleted, retained: [] };
  }
}
