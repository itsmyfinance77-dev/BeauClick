import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
  SubjectTombstone,
} from '@beauclick/subject-data';

import { ReferralService, rowCount } from './referral.service';

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
 * ## THREE tables are claimed, and the two added by Story #27 have DIFFERENT
 * dispositions
 *
 * `V32-DEC-019`'s dispositions table names four `referral` tables. Three now
 * exist and are claimed below; `referral.reward_grants` and
 * `referral.referrer_counters` still do not, because they arrive with Stories
 * #12 and #28.
 *
 * Claiming a table that does not exist is ADR-027's `claimed_but_absent`
 * violation and it fails the boot, for the reason that check records: a stale
 * claim silently covers nothing, which is worse than no claim at all, because it
 * reads as coverage. The converse also fails the boot, which is why this file
 * had to change in the same commit as the migration rather than after it.
 *
 * ## `referral.referrals` is the first RETAINED table this module owns
 *
 * `V32-DEC-019` ratifies it directly: **`retained`, with the erased side's
 * identity tombstoned**, because the row is what explains a **retained** loyalty
 * ledger entry the other party still holds. Destroying it would leave a points
 * row with no explanation.
 *
 * That makes it the opposite call from `referral_codes` above, and the two
 * reasons do not conflict: a code is a single-party bearer credential that must
 * not outlive its owner, and an attribution is a two-party fact that explains
 * something the *other* party keeps. Erasing the second to be thorough would
 * destroy the counterpart's record, which is not the erasing subject's to give
 * away.
 *
 * ## What each side's export may and may not contain
 *
 * `V32-DEC-019` binds both shapes, and they are asymmetric:
 *
 *  * a **referrer's** export may contain their own code and their own referral
 *    facts, and **no referee identity**;
 *  * a **referee's** export contains their own referral fact and **never the
 *    referrer's bearer code**.
 *
 * The second is structural rather than filtered: `referral.referrals` does not
 * store the code string at all (ADR-036 §2), so there is no field to leave out.
 * The first is enforced here, by building rows field by field and never
 * including a counterparty id.
 *
 * **No internal eligibility reason appears in either export**, because none is
 * stored: there is no column that could hold "refused because the account was
 * too old".
 */
@Injectable()
export class ReferralSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'referral';

  /**
   * The three tables this module owns today.
   *
   * `subject_data` needs no `reason`: it is the default obligation, and the two
   * dispositions that EXCUSE a table from erasure are the ones that must justify
   * themselves. `retained` therefore carries one, and it is the owner's own
   * words rather than an engineering paraphrase.
   *
   * Note also that `owner_user_id`, `referrer_user_id`, `referee_user_id`, and
   * `claimant_user_id` would each make a `no_subject_data` claim fail at boot on
   * the strength of the column name alone.
   */
  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    { table: 'referral.referral_codes', disposition: 'subject_data' },
    {
      table: 'referral.referrals',
      disposition: 'retained',
      reason:
        'V32-DEC-019: the relationship record is what explains a retained loyalty ledger entry the other party still holds; destroying it would leave a points row with no explanation. The erased side is tombstoned instead.',
    },
    // A rate-limit counter about a person who no longer exists -- exactly as
    // `chat.send_counters` is treated, in `V32-DEC-019`'s own words.
    { table: 'referral.claim_attempts', disposition: 'subject_data' },
  ];

  constructor(private readonly referral: ReferralService) {}

  /**
   * Everything this module holds about the subject — now three sections.
   *
   * All read through the caller's `EntityManager` so the whole export is ONE
   * consistent snapshot: an export assembled from independent reads can contain
   * a code a concurrent erasure has already destroyed.
   *
   * **The subject's own code IS included**, and that is correct rather than a
   * leak: it is their own bearer credential, going to them, in a document only
   * they receive. `V32-DEC-019` says so explicitly.
   *
   * **Somebody ELSE's code is not, and since Story #27 that needs more than one
   * sentence.** Under Story #11 it was true because there was no second party
   * and the query was scoped to `owner_user_id`. Now there is a second party, so
   * the guarantee rests on two things instead: the `referrals` table does not
   * store the code string at all (ADR-036 §2), and the two attribution sections
   * below are built field by field rather than spread. Either alone would be
   * enough; both is what makes it hard to break by accident.
   */
  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const codes = await this.referral.allForSubject(manager, userId);
    const { asReferrer, asReferee } = await this.referral.attributionsForSubject(manager, userId);

    return [
      {
        key: 'referral_codes',
        description: 'کد دعوت شما و زمان ساخته‌شدن آن',
        rows: codes.map((row) => ({
          code: row.code,
          createdAt: row.createdAt,
        })),
      },
      {
        key: 'referrals_made',
        description: 'دعوت‌هایی که با کد شما ثبت شده است',
        /**
         * The referrer's side. `V32-DEC-019`: *no referee identity.*
         *
         * Built field by field rather than spread, and that is the enforcement
         * rather than a style: a spread would carry `refereeUserId` — the
         * identity of somebody who is not the subject of this export — and
         * would silently carry any column a later migration adds.
         *
         * `referralCodeId` is left out too. It is an internal identifier the
         * subject cannot use for anything, and including it would let two
         * exports be correlated by a value neither person chose.
         *
         * What remains is genuinely the referrer's own fact: somebody used
         * their code, when, and until when it stands.
         */
        rows: asReferrer.map((row) => ({
          attributedAt: row.attributedAt,
          expiresAt: row.expiresAt,
          // Whether the OTHER party has erased. A boolean, never a date and
          // never an id: the counterpart's erasure instant would be a fact
          // about them, and this is the referrer's export.
          refereeErased: row.refereeErasedAt !== null,
        })),
      },
      {
        key: 'referral_received',
        description: 'دعوتی که حساب شما با آن ثبت شده است',
        /**
         * The referee's side. `V32-DEC-019`: *never the referrer's bearer
         * code.*
         *
         * Structural rather than filtered — `referral.referrals` does not store
         * the code string at all (ADR-036 §2), so there is no field here that
         * could leak one even by a careless spread. `referrerUserId` is
         * likewise absent: the fact that belongs to this subject is *that they
         * were invited*, not *by whom*.
         *
         * At most one row, by `uq_referrals_referee`. Returned as an array for
         * the reason `referral_codes` above records: the document is shaped by
         * what the table can hold rather than by what the constraint currently
         * allows.
         */
        rows: asReferee.map((row) => ({
          attributedAt: row.attributedAt,
          expiresAt: row.expiresAt,
          referrerErased: row.referrerErasedAt !== null,
        })),
      },
    ];
  }

  /**
   * Destroys what must not survive, tombstones what must (`V32-DEC-019`).
   *
   * Three tables, three different treatments, all inside the caller's
   * transaction alongside every other module's — so a failure anywhere leaves
   * the subject fully intact rather than half erased.
   *
   *  * **`referral_codes` — hard `DELETE`.** A code is a bearer credential, and
   *    a code that outlived its owner would let somebody form a referral
   *    relationship with a subject the platform has erased, creating new
   *    personal data about a person who asked to be forgotten, *after* they
   *    asked. Now that Story #27 exists this is no longer hypothetical: the
   *    claim route looks a code up by value, so an undeleted code is a
   *    claimable one.
   *  * **`claim_attempts` — hard `DELETE`.** A rate-limit counter about a
   *    person who no longer exists, exactly as `chat.send_counters` is treated.
   *  * **`referrals` — RETAINED, with this side tombstoned.** Reported as
   *    `anonymized` rather than `deleted`, which is the honest count: the rows
   *    still exist and the subject's link to them is marked erased.
   *
   * ## Why the tombstone is reported as `anonymized`
   *
   * `SubjectErasureOutcome` distinguishes rows *destroyed* from rows whose
   * *identifying content* was destroyed. Neither is literally what happens here:
   * the row held only ids and instants, so there was no name or free text to
   * destroy. `anonymized` is nonetheless the truthful bucket — the row survives
   * and no longer describes an active person — and `deleted` would be a lie
   * about rows that are still there.
   *
   * The `retained` list names the table explicitly with the owner's reason, so
   * the erasure report tells the subject a referral relationship survives and
   * why, rather than quietly counting it as handled.
   */
  async eraseSubjectData(
    manager: EntityManager,
    userId: string,
    tombstone: SubjectTombstone,
  ): Promise<SubjectErasureOutcome> {
    const codes = await manager.query('DELETE FROM referral.referral_codes WHERE owner_user_id = $1', [userId]);
    const attempts = await this.referral.eraseClaimAttempts(manager, userId);

    // The platform's SHARED tombstone, not a local one. `tombstoneFor` already
    // produces the deterministic placeholder every module uses, and its
    // `erasedAt` is the instant the whole erasure ran -- so two modules that
    // both mark a subject agree on when, and this module invents no mechanism
    // of its own (ADR-036 §9).
    const tombstoned = await this.referral.tombstoneAttributions(manager, userId, tombstone.erasedAt);

    return {
      moduleKey: this.moduleKey,
      anonymized: tombstoned,
      deleted: rowCount(codes) + attempts,
      retained:
        tombstoned > 0
          ? [
              {
                table: 'referral.referrals',
                reason:
                  'V32-DEC-019: the relationship explains a retained loyalty entry the other party still holds. Your side of it is tombstoned; the row itself is kept so the other party\'s record stays coherent.',
              },
            ]
          : [],
    };
  }
}
