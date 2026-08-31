import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { ReferralService } from './referral.service';

/**
 * `referral`'s subject-data contract — `V32-DEC-019`, ADR-035 §6.
 *
 * ## The disposition is an OWNER decision, not an engineering one
 *
 * `V32-DEC-019` carries a dispositions table and ratifies this one directly:
 * `referral.referral_codes` is `subject_data`, **deleted/revoked on the owner's
 * erasure**, with the reason stated in the decision itself — *an ownerless code
 * must not remain claimable*.
 *
 * That reason is worth restating in full, because it is stronger than the
 * platform's usual erasure argument. A referral code is a **bearer credential**:
 * once attribution exists (Story #27), whoever holds the string can claim to
 * have been invited by its owner. A code that outlived its owner would let
 * somebody form a referral relationship with a subject the platform has erased —
 * creating new personal data about a person who asked to be forgotten, after
 * they asked.
 *
 * So this module **deletes**, and does not anonymise. The platform's
 * anonymise-with-referential-integrity default exists for rows that are half of
 * a two-party fact; a referral code is single-party and, in this story,
 * referenced by nothing.
 *
 * ## Exactly ONE table is claimed, and the restraint is load-bearing
 *
 * `V32-DEC-019`'s dispositions table also names `referral.referrals`,
 * `referral.reward_grants`, and `referral.referrer_counters`. **None of them is
 * claimed here, because none of them exists yet** — they arrive with Stories
 * #27, #12, and #28.
 *
 * Claiming a table that does not exist is ADR-027's `claimed_but_absent`
 * violation and it fails the boot, for the reason that check records: a stale
 * claim silently covers nothing, which is worse than no claim at all, because it
 * reads as coverage.
 *
 * ## What the export may and may not contain
 *
 * `V32-DEC-019` binds the export shapes: *a referrer's export may contain their
 * own code and their own referral facts, and no referee identity.* This story
 * has no referees, so the export is the subject's own code and the instant it
 * was created — which is exactly what they own.
 */
@Injectable()
export class ReferralSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'referral';

  /**
   * The one table this module owns today.
   *
   * `subject_data` needs no `reason`: it is the default obligation, and the two
   * dispositions that EXCUSE a table from erasure are the ones that must justify
   * themselves. Note also that `owner_user_id` would make a `no_subject_data`
   * claim fail at boot on the strength of the column name alone.
   */
  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    { table: 'referral.referral_codes', disposition: 'subject_data' },
  ];

  constructor(private readonly referral: ReferralService) {}

  /**
   * Everything this module holds about the subject.
   *
   * The subject's own code and when it was created, read through the caller's
   * `EntityManager` so the whole export is one consistent snapshot.
   *
   * The code IS included, and that is correct rather than a leak: it is the
   * subject's own bearer credential, going to the subject, in a document only
   * they receive. `V32-DEC-019` says so explicitly. What the export must never
   * contain is somebody ELSE's code — and it cannot, because the query is
   * scoped to `owner_user_id` and this story has no second party.
   */
  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const codes = await this.referral.allForSubject(manager, userId);

    return [
      {
        key: 'referral_codes',
        description: 'کد دعوت شما و زمان ساخته‌شدن آن',
        rows: codes.map((row) => ({
          code: row.code,
          createdAt: row.createdAt,
        })),
      },
    ];
  }

  /**
   * Destroys the subject's referral code.
   *
   * A hard `DELETE`, inside the caller's transaction alongside every other
   * module's, so a failure anywhere leaves the subject fully intact rather than
   * half erased.
   *
   * `retained` is empty and that is the honest report: this module keeps
   * nothing. It is also the only answer compatible with `V32-DEC-019` — a
   * retained code is a claimable code.
   */
  async eraseSubjectData(manager: EntityManager, userId: string): Promise<SubjectErasureOutcome> {
    const result = await manager.query('DELETE FROM referral.referral_codes WHERE owner_user_id = $1', [userId]);

    return {
      moduleKey: this.moduleKey,
      anonymized: 0,
      deleted: rowCount(result),
      retained: [],
    };
  }
}

/**
 * How many rows a write actually touched.
 *
 * TypeORM's postgres driver returns `[rows, rowCount]` for `UPDATE` and
 * `DELETE`, including when the statement carries `RETURNING`. Counting
 * `result.length` therefore reports 2 for every such statement — the defect
 * V3.2-B recorded as bug #3, where it made an erasure report a fabricated count
 * and made a compare-and-swap unable to observe its own loss.
 */
function rowCount(result: unknown): number {
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}
