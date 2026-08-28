import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { WaitlistEntryEntity } from './entities/waitlist-entry.entity';

/**
 * waitlist's subject-data contract.
 *
 * The erasure step here has a consequence outside privacy, and it is the
 * reason it exists rather than returning zeroes like commerce does: a
 * `waiting` or `offered` entry is a LIVE claim on a professional's future
 * availability. Left in place after the account is erased, the matcher would
 * keep offering slots to somebody who cannot receive the notification, cannot
 * sign in, and cannot accept -- and each offer would sit out its window before
 * moving on, delaying the next real customer by the full offer period.
 *
 * So open entries are closed as `removed`. The rows survive (they are half of
 * the professional's own waitlist history) and the queue starts behaving
 * correctly again.
 */
@Injectable()
export class WaitlistSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'waitlist';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    { table: 'waitlist.entries', disposition: 'subject_data' },
    { table: 'waitlist.outbox_events', disposition: 'retained', reason: 'Transactional outbox.' },
  ];

  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const entries = await manager.getRepository(WaitlistEntryEntity).find({
      where: { customerId: userId },
      order: { createdAt: 'DESC' },
    });

    return [
      {
        key: 'entries',
        description: 'لیست‌های انتظاری که در آن عضو شده‌اید',
        rows: entries.map((e) => ({
          id: e.id,
          professionalId: e.professionalId,
          serviceId: e.serviceId,
          status: e.status,
          offeredAt: e.offeredAt,
          offerExpiresAt: e.offerExpiresAt,
          resultingBookingId: e.resultingBookingId,
          createdAt: e.createdAt,
        })),
      },
    ];
  }

  async eraseSubjectData(manager: EntityManager, userId: string): Promise<SubjectErasureOutcome> {
    const closed = await manager.query(
      `UPDATE waitlist.entries
          SET status = 'removed', updated_at = now()
        WHERE customer_id = $1 AND status IN ('waiting', 'offered')`,
      [userId],
    );

    return {
      moduleKey: this.moduleKey,
      anonymized: Array.isArray(closed) && typeof closed[1] === 'number' ? closed[1] : 0,
      deleted: 0,
      retained: [
        { table: 'waitlist.entries', reason: "half of the professional's own waitlist history; ids and statuses only" },
      ],
    };
  }
}
