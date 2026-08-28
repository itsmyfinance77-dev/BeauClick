import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { DataRequestEntity } from './entities/data-request.entity';

/**
 * privacy's own claim.
 *
 * It also claims `public.schema_migrations`, which belongs to no domain at
 * all. That is not tidying: the coverage check treats an unclaimed table as a
 * boot failure and deliberately excludes no schema, because excluding one is
 * how the first genuinely unclaimed table gets in. Migration bookkeeping has
 * to be claimed by SOMEBODY, and the module whose job is to account for every
 * table is the honest owner.
 */
@Injectable()
export class PrivacySubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'privacy';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    {
      table: 'privacy.data_requests',
      disposition: 'retained',
      reason:
        'The compliance record. It must outlive the erasure it proves happened, so it carries counts and timestamps and never content.',
    },
    {
      table: 'privacy.export_payloads',
      disposition: 'subject_data',
    },
    {
      table: 'privacy.outbox_events',
      disposition: 'retained',
      reason:
        'Transactional outbox. Payloads carry request and subject ids only -- never a document, a phone number, or a name (see privacy.events.ts).',
    },
    {
      table: 'public.schema_migrations',
      disposition: 'no_subject_data',
      reason: 'Migration bookkeeping: filename and applied-at. Claimed here because no schema is excluded from coverage.',
    },
  ];

  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const requests = await manager.getRepository(DataRequestEntity).find({
      where: { subjectUserId: userId },
      order: { requestedAt: 'DESC' },
    });

    return [
      {
        key: 'requests',
        description: 'درخواست‌های دریافت اطلاعات و حذف حساب شما',
        rows: requests.map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          requestedAt: r.requestedAt,
          executeAfter: r.executeAfter,
          expiresAt: r.expiresAt,
          completedAt: r.completedAt,
          cancelledAt: r.cancelledAt,
        })),
      },
    ];
  }

  /**
   * Destroys every stored export document for the subject.
   *
   * A subject who has asked to be erased must not leave a complete, downloadable
   * copy of their own data behind -- which is exactly what an unexpired export
   * from last week is. The request ROWS survive (they are the compliance
   * record); the documents do not.
   *
   * The in-flight erasure request's own row is untouched: it is `processing`
   * at this point and the caller is about to mark it `completed`.
   */
  async eraseSubjectData(manager: EntityManager, userId: string): Promise<SubjectErasureOutcome> {
    const deleted = await manager.query(
      `DELETE FROM privacy.export_payloads p
        USING privacy.data_requests r
        WHERE p.request_id = r.id AND r.subject_user_id = $1`,
      [userId],
    );

    // A DELETE ... USING returns [rows, rowCount] through TypeORM's raw query
    // path; the count is the second element.
    const count = Array.isArray(deleted) && typeof deleted[1] === 'number' ? deleted[1] : 0;

    await manager.query(
      `UPDATE privacy.data_requests
          SET status = 'expired', updated_at = now()
        WHERE subject_user_id = $1 AND kind = 'export' AND status = 'ready'`,
      [userId],
    );

    return {
      moduleKey: this.moduleKey,
      anonymized: 0,
      deleted: count,
      retained: [
        {
          table: 'privacy.data_requests',
          reason: 'proof that the platform honoured this request; counts and timestamps only',
        },
      ],
    };
  }
}
