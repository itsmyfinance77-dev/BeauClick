import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { MediaObjectEntity } from './entities/media-object.entity';
import { MediaAbuseReportEntity } from './entities/media-abuse-report.entity';
import { MediaService } from './media.service';

/**
 * media's subject-data contract -- the only one that has to destroy something
 * outside PostgreSQL.
 *
 * THE ROW AND THE BYTES ARE TWO SEPARATE DELETIONS, and they cannot share a
 * transaction: object storage has none. The order below is the safe one and
 * the reverse is genuinely dangerous:
 *
 *   1. mark the rows `deleted`, inside the caller's transaction;
 *   2. purge the bytes AFTER that transaction commits.
 *
 * If the process dies between them, the outcome is an orphaned object in the
 * store whose row says it is gone -- an operational cleanup problem, and the
 * same state `MediaService.purgeBytes` already documents itself as tolerating.
 * Purging first would mean a rolled-back erasure had destroyed a professional's
 * portfolio images while every row still claimed they existed, and the product
 * would serve broken images with no record of why.
 *
 * The purge is therefore NOT performed here, where only a transaction is
 * available. `pendingByteDeletions` hands the caller what to purge once its
 * transaction has committed; `PrivacyErasureCompleter` in the composition root
 * is what actually calls it.
 *
 * VERIFICATION EVIDENCE goes with everything else. It is the most sensitive
 * media in the platform -- national ID cards and licences -- and a subject who
 * has asked to be erased must not leave their identity documents in the
 * platform's object store because they happened to be filed under a different
 * purpose.
 */
@Injectable()
export class MediaSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'media';

  constructor(private readonly media: MediaService) {}

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    { table: 'media.objects', disposition: 'subject_data' },
    { table: 'media.abuse_reports', disposition: 'subject_data' },
  ];

  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const objects = await manager.getRepository(MediaObjectEntity).find({
      where: { ownerUserId: userId },
      order: { createdAt: 'DESC' },
    });
    const reports = await manager.getRepository(MediaAbuseReportEntity).find({
      where: { reportedBy: userId },
      order: { createdAt: 'DESC' },
    });

    return [
      {
        key: 'objects',
        description: 'فایل‌های رسانه‌ای که بارگذاری کرده‌اید',
        // `storageKey` is deliberately absent: it is an internal addressing
        // detail, and publishing the key layout of the object store in a
        // document anyone can obtain is a gift to whoever obtains it.
        rows: objects.map((o) => ({
          id: o.id,
          purpose: o.purpose,
          accessClass: o.accessClass,
          status: o.status,
          contentType: o.contentType,
          byteSize: o.byteSize,
          width: o.width,
          height: o.height,
          createdAt: o.createdAt,
          finalizedAt: o.finalizedAt,
          deletedAt: o.deletedAt,
        })),
      },
      {
        key: 'abuse_reports',
        description: 'گزارش‌هایی که درباره محتوای دیگران ثبت کرده‌اید',
        // `decidedBy` and `decisionReason` are excluded: the first identifies
        // a moderator, and the second is the platform's internal reasoning
        // about somebody else's content.
        rows: reports.map((r) => ({
          id: r.id,
          mediaObjectId: r.mediaObjectId,
          reason: r.reason,
          note: r.note,
          status: r.status,
          createdAt: r.createdAt,
        })),
      },
    ];
  }

  /**
   * Which objects still need their bytes removed after the caller commits.
   *
   * Read BEFORE the erasure marks them, because afterwards they are
   * indistinguishable from objects deleted last month -- and purging those
   * too would be correct-looking, unbounded work on somebody else's schedule.
   */
  async pendingByteDeletions(
    manager: EntityManager,
    userId: string,
  ): Promise<Array<{ id: string; storageKey: string }>> {
    const rows = await manager.getRepository(MediaObjectEntity).find({
      where: { ownerUserId: userId },
      select: { id: true, storageKey: true, status: true },
    });
    return rows.filter((r) => r.status !== 'deleted').map((r) => ({ id: r.id, storageKey: r.storageKey }));
  }

  async eraseSubjectData(manager: EntityManager, userId: string): Promise<SubjectErasureOutcome> {
    const objects = await manager.query(
      `UPDATE media.objects
          SET status = 'deleted', deleted_at = COALESCE(deleted_at, now())
        WHERE owner_user_id = $1 AND status <> 'deleted'`,
      [userId],
    );

    // The subject's own words about somebody else's content. The report
    // survives -- a moderator's decision has to stay explicable -- and the
    // free text they typed does not.
    const notes = await manager.query(
      `UPDATE media.abuse_reports SET note = NULL WHERE reported_by = $1 AND note IS NOT NULL`,
      [userId],
    );

    return {
      moduleKey: this.moduleKey,
      anonymized: rowCount(notes),
      deleted: rowCount(objects),
      retained: [
        {
          table: 'media.abuse_reports',
          reason: 'a moderation decision has to stay explicable; the reporter\'s free text is removed',
        },
      ],
    };
  }

  /** Best-effort byte removal, called by the composition root after the erasure transaction commits. */
  async purge(rows: Array<{ id: string; storageKey: string }>): Promise<void> {
    await this.media.purgeBytes(rows);
  }
}

function rowCount(result: unknown): number {
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}
