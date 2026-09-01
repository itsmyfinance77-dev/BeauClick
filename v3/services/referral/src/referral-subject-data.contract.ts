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
 * ## SIX tables are claimed, with THREE different dispositions
 *
 * `V32-DEC-019`'s dispositions table names four `referral` tables and all four
 * now exist: Story #27 added `referrals` and `claim_attempts`, and Story #12
 * added `reward_grants` and `referrer_counters`. The sixth,
 * `referral.outbox_events`, is Story #12's and is not in the owner's table
 * because it holds no subject data to have a disposition about — which is
 * itself a claim that has to be made and justified.
 *
 * The dispositions are not uniform, and the split is the same one throughout:
 * **what the row is FOR decides what happens to it.** A bearer credential and
 * a rate-limit counter are destroyed; a record that EXPLAINS a retained loyalty
 * entry is kept.
 *
 * Claiming a table that does not exist is ADR-027's `claimed_but_absent`
 * violation and it fails the boot, for the reason that check records: a stale
 * claim silently covers nothing, which is worse than no claim at all, because it
 * reads as coverage. The converse also fails the boot, which is why this file
 * had to change in the same commit as the migration rather than after it —
 * twice now, for the same reason.
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
   * The six tables this module owns today.
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
    /**
     * V3.2-C Story #12. `V32-DEC-019` ratifies both of these directly, and they
     * get OPPOSITE dispositions for the same reason `referral_codes` and
     * `referrals` do: what the row is FOR decides what happens to it.
     */
    {
      table: 'referral.reward_grants',
      disposition: 'retained',
      reason:
        'V32-DEC-019: the grant is the audit explanation for a retained loyalty ledger entry. Retaining the points row while destroying the grant that explains it would leave a balance nobody could justify to the person holding it.',
    },
    // A cap counter about a person who no longer exists. `V32-DEC-019` names
    // this table explicitly and gives it the same treatment as
    // `chat.send_counters`: deleted, because a rate limit on somebody who
    // cannot act is not data about anybody.
    { table: 'referral.referrer_counters', disposition: 'subject_data' },
    /**
     * The outbox, created by Story #12 with its first producer.
     *
     * `no_subject_data` and the reason is structural rather than a judgement:
     * `ReferralQualified` v1 carries only uuids, closed enums, integer point
     * values and instants (`V32-DEC-033`, ADR-037 §10), so a payload here
     * cannot contain a name, a phone, a code, or prose — there is no field of a
     * type that could hold one.
     *
     * The ids it does carry are the same ids `referral.referrals` holds, and
     * they are covered by that table's own retained-with-tombstone disposition.
     * An outbox row is a dispatch record that the relay drains and that carries
     * no fact the referral row does not already carry more durably.
     */
    {
      table: 'referral.outbox_events',
      disposition: 'no_subject_data',
      reason:
        'Dispatch records for ReferralQualified v1, whose schema admits only uuids, closed enums, integers and instants — so no name, phone, code or prose can be present. The ids duplicate referral.referrals, which carries the retained-with-tombstone disposition.',
    },
  ];

  constructor(private readonly referral: ReferralService) {}

  /**
   * Everything this module holds about the subject — now four sections.
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
    const grants = await this.referral.rewardGrantsForSubject(manager, userId);

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
      {
        key: 'referral_rewards',
        description: 'نتیجه پاداش دعوت‌های مربوط به شما',
        /**
         * V3.2-C Story #12. The subject's OWN reward outcomes, both sides.
         *
         * Addressed by `recipient_user_id`, so this section never loads a row
         * that names the counterparty — the export cannot leak an identity it
         * does not read. That is why the grant carries a recipient column at
         * all rather than being joined back through `referrals`.
         *
         * **`side` is included and the counterparty is not.** Telling somebody
         * "this was your referrer reward" describes their own role; naming who
         * was on the other end would be the referee identity `V32-DEC-019`
         * keeps out of a referrer's export, and the referrer identity it keeps
         * out of a referee's.
         *
         * **`outcome` and `points` are included, and they are the honest
         * disclosure the zero requires.** A subject seeing
         * `disabled_zero, 0` learns that the platform decided to award zero —
         * which is the fact `V32-DEC-016` insists must not be silent. A subject
         * seeing `capped` learns their own monthly limit was reached, which is
         * a fact about them and nobody else.
         *
         * `referralId` is deliberately absent: it is an internal identifier the
         * subject cannot use, and including it would let two exports be
         * correlated by a value neither person chose — the same reasoning that
         * keeps `referralCodeId` out of the sections above.
         */
        rows: grants.map((row) => ({
          side: row.side,
          outcome: row.outcome,
          points: row.points,
          grantedAt: row.grantedAt,
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
    /**
     * V3.2-C Story #12. The monthly cap counter, deleted (`V32-DEC-019`).
     *
     * The same treatment `claim_attempts` gets and the decision gives the same
     * reason for both: a rate limit about a person who can no longer act is not
     * data about anybody. Deleting it also cannot advantage the erased subject
     * — an erased account has no referrals to qualify.
     */
    const counters = await this.referral.eraseReferrerCounters(manager, userId);

    // The platform's SHARED tombstone, not a local one. `tombstoneFor` already
    // produces the deterministic placeholder every module uses, and its
    // `erasedAt` is the instant the whole erasure ran -- so two modules that
    // both mark a subject agree on when, and this module invents no mechanism
    // of its own (ADR-036 §9).
    const tombstoned = await this.referral.tombstoneAttributions(manager, userId, tombstone.erasedAt);

    /**
     * The reward grants are RETAINED and deliberately not touched here.
     *
     * `V32-DEC-019` retains them because they explain a retained loyalty ledger
     * entry, and unlike `referrals` there is nothing on a grant row to
     * tombstone: it carries a recipient id, a side, an outcome, an integer and
     * an instant, and no name, phone, code, or prose. Once the identity the
     * recipient id points at no longer exists, the row no longer describes a
     * person — the platform's stated treatment for id-only rows.
     *
     * They are reported in `retained` below rather than silently kept, because
     * an erasure report that omits a surviving table is the failure ADR-027
     * exists to prevent.
     */
    const grantsRetained = await this.referral.countRewardGrants(manager, userId);

    const retained: Array<{ table: string; reason: string }> = [];
    if (tombstoned > 0) {
      retained.push({
        table: 'referral.referrals',
        reason:
          'V32-DEC-019: the relationship explains a retained loyalty entry the other party still holds. Your side of it is tombstoned; the row itself is kept so the other party\'s record stays coherent.',
      });
    }
    if (grantsRetained > 0) {
      retained.push({
        table: 'referral.reward_grants',
        reason:
          'V32-DEC-019: the grant is the audit explanation for a loyalty ledger entry that is itself retained. It holds only ids, an outcome and a number — no name, phone, code or prose — so it no longer describes a person once the identity it references is gone.',
      });
    }

    return {
      moduleKey: this.moduleKey,
      anonymized: tombstoned,
      // TRUTHFUL counts, summed from what each statement actually reported
      // rather than from what it was asked to do. `rowCount` reads the driver's
      // real count for the raw DELETE, and the two service helpers return
      // theirs the same way -- the defect V3.2-B recorded as bug #3 was an
      // erasure report fabricating a count, and this is the line where that
      // would happen again.
      deleted: rowCount(codes) + attempts + counters,
      retained,
    };
  }
}
