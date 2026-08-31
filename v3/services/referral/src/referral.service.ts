import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import {
  REFERRAL_CLAIM_ATTEMPTS_PER_HOUR,
  REFERRAL_CLAIM_MAX_ACCOUNT_AGE_DAYS,
  REFERRAL_PENDING_ATTRIBUTION_EXPIRY_DAYS,
  REFERRAL_SHARE_CHANNELS,
  REFERRAL_SHARE_TITLE,
  buildReferralInviteUrl,
  buildReferralShareText,
  isReferralCodeShape,
} from '@beauclick/referral-contract';
import type { ReferralClaimResult, ReferralCodeView, ReferralSharePayload } from '@beauclick/referral-contract';

import { ReferralAttributionEntity, ReferralCodeEntity } from './entities/referral.entities';
import {
  REFERRAL_CLOCK,
  ReferralClock,
  accountAgeCutoff,
  hourBucket,
  pendingAttributionExpiry,
} from './referral-clock';
import { REFERRAL_CODE_GENERATOR, ReferralCodeGenerator } from './referral-code.generator';
import { ReferralClaimRefusedException, ReferralClaimThrottledException } from './referral.exceptions';
import {
  REFERRAL_BOOKING_PORT,
  REFERRAL_IDENTITY_PORT,
  ReferralBookingPort,
  ReferralIdentityPort,
} from './ports/referral.ports';

/**
 * How many times to redraw a code after a global-uniqueness collision.
 *
 * At ~49.5 bits of entropy a collision is a lottery rather than a design case:
 * with a million codes issued, the chance any single draw collides is about
 * 1 in 8×10^8. Five attempts is therefore not a tuned number — it is a bound
 * that exists so a pathological state (a exhausted keyspace, a misconfigured
 * alphabet) fails loudly and finitely instead of spinning forever.
 *
 * The loop is tested by FORCING a collision, because a retry path that is never
 * exercised is a retry path nobody knows works.
 */
const MAX_CODE_ATTEMPTS = 5;

/** PostgreSQL's unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

/**
 * The referral identity (ADR-035).
 *
 * ## The one interesting problem in this module: two different unique conflicts
 *
 * `referral.referral_codes` carries two unique constraints, and a conflict on
 * each means something completely different:
 *
 *   * **`uq_referral_codes_code`** — this draw collided with somebody else's
 *     code. The right response is to **draw again**.
 *   * **`uq_referral_codes_owner`** — a concurrent request already created this
 *     owner's code. The right response is to **re-read and return theirs**.
 *     Drawing again would be actively wrong: it would try to mint a second code
 *     for an owner who now has one, and would fail on the same constraint every
 *     time until the attempts ran out.
 *
 * They are told apart **by constraint name**, never by catching `23505` and
 * guessing. A handler that treated an owner conflict as a code collision would
 * burn all five attempts on a request that should have returned immediately, and
 * would surface as an intermittent 500 under exactly the concurrency the route
 * is most likely to see — a client that fires the same read twice on mount.
 *
 * ## Ownership
 *
 * `ownerUserId` is the FIRST parameter of every method and is always the
 * session-resolved caller. No method accepts an owner, customer, or user id from
 * anywhere else, and no query in this file is missing its `owner_user_id`
 * predicate.
 */
@Injectable()
export class ReferralService {
  private readonly logger = new Logger('ReferralService');

  constructor(
    @InjectRepository(ReferralCodeEntity)
    private readonly codes: Repository<ReferralCodeEntity>,
    private readonly config: ConfigService,
    /**
     * The code source. `ReferralModule` binds the real CSPRNG generator, so this
     * is not a port and no composition has to supply it -- it is the seam that
     * lets the suite force a collision and prove the retry below actually works
     * (see `ReferralCodeGenerator`).
     */
    @Inject(REFERRAL_CODE_GENERATOR) private readonly generator: ReferralCodeGenerator,
    /**
     * The two Story #27 ports and the injected clock.
     *
     * Unlike the generator above, these ARE ports and the difference is real:
     * `ReferralModule` binds a default for the generator and **none** for these,
     * so a composition that forgets one fails to boot rather than falling back
     * to something permissive (ADR-011, ADR-036 §4).
     *
     * That asymmetry is deliberate. A stub generator still produces correct
     * codes; a stub identity or booking port answering "everybody is new" and
     * "nobody has booked" would pass every test written against this module
     * alone while silently disabling two of the six eligibility rules in
     * production.
     */
    @Inject(REFERRAL_IDENTITY_PORT) private readonly identity: ReferralIdentityPort,
    @Inject(REFERRAL_BOOKING_PORT) private readonly booking: ReferralBookingPort,
    @Inject(REFERRAL_CLOCK) private readonly clock: ReferralClock,
  ) {}

  /**
   * The caller's own referral code, created on first read.
   *
   * Idempotent in the strong sense: the first call and the thousandth produce
   * the same row, the same code, and the same response body. There is no
   * counter, no timestamp that moves, and nothing a caller could use to observe
   * how many times this ran — which is what makes a mutating `GET` defensible
   * here (ADR-035 §5).
   *
   * Order of operations:
   *
   *  1. **Read first.** The overwhelmingly common case is an owner who already
   *     has a code, and that path must cost one indexed `SELECT` and no write.
   *  2. **Otherwise create**, retrying on a code collision and yielding to the
   *     winner on an owner collision.
   */
  async codeFor(ownerUserId: string): Promise<ReferralCodeView> {
    const existing = await this.codes.findOne({ where: { ownerUserId } });
    if (existing) return this.toView(existing);

    return this.toView(await this.create(ownerUserId));
  }

  /**
   * Every referral row this subject owns, for the privacy export.
   *
   * Takes the caller's `EntityManager` so the export is part of ONE consistent
   * snapshot with every other module's — an export assembled from independent
   * reads can contain a code a concurrent erasure has already destroyed.
   *
   * Returns an array although the owner constraint permits at most one row: the
   * export document is shaped by what the table can hold rather than by what the
   * constraint currently allows, so a future decision to permit a second code
   * does not silently truncate somebody's export to the first one.
   */
  async allForSubject(manager: EntityManager, ownerUserId: string): Promise<ReferralCodeEntity[]> {
    return manager.getRepository(ReferralCodeEntity).find({
      where: { ownerUserId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  /**
   * Mints a code, generate-and-retry against the unique index.
   *
   * **There is no `SELECT ... WHERE code = $1` anywhere in this method**, and
   * the absence is the guarantee rather than an optimisation. A read-then-write
   * availability check lets two concurrent generations that drew the same code
   * both observe it free — under `READ COMMITTED` neither transaction can see
   * the other's uncommitted row — and both proceed. That is `GAP-04` in
   * miniature, and `V32-DEC-019` forbids the shape in the same words for the
   * referrer cap.
   */
  private async create(ownerUserId: string): Promise<ReferralCodeEntity> {
    for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt += 1) {
      const row = this.codes.create({
        id: uuidv7(),
        ownerUserId,
        // Takes no arguments, so it cannot be handed the owner id even by
        // accident (ADR-035 §3).
        code: this.generator.next(),
      });

      try {
        await this.codes.insert(row);
        // Ids only. The CODE IS NOT AN ARGUMENT to this line, and that is the
        // point: `V32-DEC-033` keeps a referral code out of every log line, and
        // the way to keep it out is not to pass it (ADR-035 §8).
        this.logger.log(`referral code created for subject ${ownerUserId}`);
        return row;
      } catch (error) {
        const constraint = uniqueViolationConstraint(error);

        // Somebody else already holds this string. Draw a new one.
        if (constraint === 'uq_referral_codes_code') continue;

        // A concurrent first read for the SAME owner won. Return their code
        // rather than minting a second one -- both callers must see the same
        // code, which is the whole point of `UNIQUE (owner_user_id)`.
        if (constraint === 'uq_referral_codes_owner') {
          const winner = await this.codes.findOne({ where: { ownerUserId } });
          // `findOne` rather than `findOneOrFail`, and the null branch is
          // genuinely reachable: the winning transaction can commit its
          // constraint conflict and then roll back. Falling through to the next
          // attempt is correct -- the owner has no code after all.
          if (winner) return winner;
          continue;
        }

        throw error;
      }
    }

    // Unreachable short of an exhausted keyspace or a misconfigured alphabet,
    // and loud rather than silent if either ever happens. The subject id is
    // named; no candidate code is, because a rejected code is still a code.
    throw new Error(
      `Failed to allocate a referral code after ${MAX_CODE_ATTEMPTS} attempts for subject ${ownerUserId}`,
    );
  }


  // -------------------------------------------------------------------------
  // Attribution — V3.2-C Story #27 (ADR-036)
  // -------------------------------------------------------------------------

  /**
   * Attributes the caller to the owner of `code`, once, ever.
   *
   * ## The order of operations IS the security design
   *
   * Everything from step 2 runs in ONE transaction on ONE `EntityManager`, and
   * the order is not arbitrary:
   *
   *  1. **Charge the throttle first**, before anything is looked up. A refused
   *     claim must still consume an attempt, because `V32-DEC-034` prices this
   *     limit as a GUESS RATE and makes it the stated reason the code is ten
   *     characters rather than eight. A throttle that counted only successful
   *     claims would bound nothing. `reserveSendSlot` states the identical
   *     principle for chat.
   *  2. **Look the code up by value.** The first place in this module where
   *     that is possible, and the reason every refusal below is identical.
   *  3. **Self-referral, prior attribution, account age, completed booking**,
   *     in ascending cost order — the two port calls are last because they are
   *     the only cross-domain reads, and a caller who fails a cheap check never
   *     causes one.
   *  4. **Insert**, and treat the unique violation as a refusal rather than an
   *     error.
   *
   * The order is **not observable**: every failure from step 2 onward produces
   * the same byte-identical response, so a caller cannot tell which check
   * stopped them. Ordering by cost is a resource decision, not a disclosure
   * one.
   *
   * ## Why the throttle charge is not rolled back
   *
   * `chargeClaimAttempt` runs on the DataSource's own manager, OUTSIDE the
   * claim's transaction, and that is deliberate rather than sloppy.
   *
   * If it shared the transaction, every refusal — which is raised as an
   * exception, and therefore rolls the transaction back — would UNDO the
   * attempt it had just counted, and the limit would only ever constrain
   * SUCCESSFUL claims. That is precisely the throttle `V32-DEC-034` says would
   * bound nothing, and it would fail silently: every test that made ten
   * legitimate claims would still see the limit work.
   *
   * So the counter is durable before eligibility is evaluated and stays durable
   * when eligibility fails. The costs are both correct rather than tolerated: a
   * successful claim consumes one attempt (ADR-036 §6b), and a request that
   * dies between the charge and the insert consumes one too — it was an
   * attempt.
   *
   * ## What it never accepts
   *
   * `refereeUserId` is a parameter of this method and comes from
   * `@CurrentUser()`. The CODE is the only value that reaches here from a
   * client. No caller-supplied referrer, owner, phone, account age, booking
   * state, reward, expiry, or status participates in any decision below —
   * there is no parameter one could arrive through.
   */
  async claim(refereeUserId: string, code: string): Promise<ReferralClaimResult> {
    // (1) Charged FIRST and OUTSIDE the transaction below, so a refusal cannot
    // roll back the attempt it consumed. See the docblock.
    await this.chargeClaimAttempt(refereeUserId);

    return this.codes.manager.transaction(async (manager) => {
      // (2a) The SHAPE, checked here rather than by a DTO constraint.
      //
      // Deliberate, and the controller's `ReferralClaimDto` docblock records
      // why at length: the platform's `ValidationException` serialises
      // class-validator's `ValidationError`, which carries the submitted
      // `value` -- so an `@Matches` failure echoed a bearer credential into a
      // response body. The realistic trigger is a customer typing their
      // inviter's real code in lowercase.
      //
      // Refusing here folds a malformed code into the ONE collapsed refusal, so
      // the route makes one fewer distinction than it did, and a malformed
      // probe correctly consumes a throttle attempt rather than being free.
      if (!isReferralCodeShape(code)) throw new ReferralClaimRefusedException();

      // (2b) The lookup by value. A miss and a hit that is then refused are
      // indistinguishable to the caller by construction: both paths throw the
      // SAME no-argument exception.
      //
      // A "revoked" code is an ABSENT row -- `referral_codes` has no
      // `revoked_at` (ADR-035 §2) because erasure is a hard DELETE. So the
      // revoked case Issue #27 names collapses into this branch with no
      // collapsing logic to get wrong.
      const codeRow = await manager.getRepository(ReferralCodeEntity).findOne({ where: { code } });
      if (!codeRow) throw new ReferralClaimRefusedException();

      // (3a) The caller's own code. Refused HERE with the collapsed refusal, so
      // an honest mistake gets the same answer as everything else. The CHECK
      // constraint is the guarantee, not this line -- but a caller must never
      // reach it, because a constraint violation is a distinguishable 500.
      if (codeRow.ownerUserId === refereeUserId) throw new ReferralClaimRefusedException();

      // (3b) Attributed once, EVER. Checked here so the common case is a clean
      // refusal rather than a caught constraint violation; the constraint is
      // still what makes it true under concurrency (see the insert below).
      const attributions = manager.getRepository(ReferralAttributionEntity);
      if (await attributions.findOne({ where: { refereeUserId } })) {
        throw new ReferralClaimRefusedException();
      }

      const now = this.clock.now();

      // (3c) Account age, through the port, on THIS manager, inside THIS
      // transaction. `null` -- no such user -- is ineligible rather than an
      // error: raising would make a missing account distinguishable from every
      // other refusal, which is the account oracle `V32-DEC-019` forbids.
      const createdAt = await this.identity.accountCreatedAt(manager, refereeUserId);
      if (createdAt === null) throw new ReferralClaimRefusedException();

      // INCLUSIVE at exactly 30 days: Issue #27 says "<= 30 days", so the
      // comparison is `>=` against the cutoff and the refusal is `<`. Written
      // as `<=` here it would refuse an account exactly 30 days old -- one
      // customer per boundary, invisibly.
      if (createdAt.getTime() < accountAgeCutoff(now, REFERRAL_CLAIM_MAX_ACCOUNT_AGE_DAYS).getTime()) {
        throw new ReferralClaimRefusedException();
      }

      // (3d) Completed booking, through the port, on the same manager.
      if (await this.booking.hasCompletedBooking(manager, refereeUserId)) {
        throw new ReferralClaimRefusedException();
      }

      // (4) Both timestamps from ONE reading of the clock, so the 90-day
      // relationship between them is exact rather than approximately exact.
      const attributedAt = now;
      const expiresAt = pendingAttributionExpiry(attributedAt, REFERRAL_PENDING_ATTRIBUTION_EXPIRY_DAYS);

      try {
        await attributions.insert({
          id: uuidv7(),
          referrerUserId: codeRow.ownerUserId,
          refereeUserId,
          // The code's ID, never the string. A bearer credential does not go on
          // a row that outlives its owner's erasure (ADR-036 §2).
          referralCodeId: codeRow.id,
          attributedAt,
          expiresAt,
          referrerErasedAt: null,
          refereeErasedAt: null,
        });
      } catch (error) {
        // The concurrency case, and the ONLY thing that makes "once, ever" true
        // under load. Two simultaneous claims for one referee both pass step
        // (3b) -- under READ COMMITTED neither sees the other's uncommitted row
        // -- and `uq_referrals_referee` decides which wins. The loser refuses,
        // identically to every other refusal.
        //
        // Told apart BY CONSTRAINT NAME, never by catching 23505 and guessing,
        // for the reason `create` above records at length. A different unique
        // violation is a real fault and must surface as one rather than being
        // reported to a customer as an ineligible code.
        if (uniqueViolationConstraint(error) === 'uq_referrals_referee') {
          throw new ReferralClaimRefusedException();
        }
        throw error;
      }

      // Ids and an outcome. NO CODE IS AN ARGUMENT to this line, and that is
      // how it stays out of the logs -- not by redaction (`V32-DEC-033`,
      // ADR-035 §8). The referrer is not named either: this module logs the
      // subject it acted for, not the counterparty it resolved.
      this.logger.log(`referral attribution recorded for subject ${refereeUserId}`);

      return {
        attributedAt: attributedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  /**
   * Consumes one claim attempt, or refuses.
   *
   * `V32-DEC-019`: **10 attempts per authenticated caller per hour**, enforced
   * in PostgreSQL. One conditional statement, which is the entire algorithm:
   * the read and the write are the SAME statement, so there is no window
   * between them for a concurrent request to slip through.
   *
   * `RETURNING` yields zero rows when the `WHERE` on the `DO UPDATE` fails,
   * which is how "the limit is spent" is observed without a second query. A
   * `SELECT` followed by an `UPDATE` is `GAP-04`, and `V32-DEC-019` forbids the
   * shape in the same words it uses for the referrer cap: two concurrent claims
   * both observe 9 and both write 10.
   *
   * **Not the in-memory HTTP throttler.** `BeauClickThrottlerGuard`'s storage is
   * per-process, so its effective limit multiplies by instance count while
   * `THROTTLE-STORE` is unresolved. A PostgreSQL row is shared across every
   * instance by construction. The guard still runs as coarse abuse control; it
   * is not what makes ten mean ten.
   *
   * Runs on the DataSource's own manager rather than inside the caller's
   * transaction -- see `claim`'s docblock for why that separation is required
   * rather than incidental.
   */
  private async chargeClaimAttempt(claimantUserId: string): Promise<void> {
    const bucket = hourBucket(this.clock.now());

    const rows: Array<{ attempt_count: number }> = await this.codes.manager.query(
      `INSERT INTO referral.claim_attempts (claimant_user_id, window_start, attempt_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (claimant_user_id, window_start) DO UPDATE
         SET attempt_count = referral.claim_attempts.attempt_count + 1, updated_at = now()
         WHERE referral.claim_attempts.attempt_count < $3
       RETURNING attempt_count`,
      [claimantUserId, bucket, REFERRAL_CLAIM_ATTEMPTS_PER_HOUR],
    );

    if (rows.length === 0) throw new ReferralClaimThrottledException();
  }

  /**
   * Every attribution this subject is party to, for the privacy export.
   *
   * Returns BOTH sides -- the rows where they invited, and the row where they
   * were invited -- because both are facts about them. What each side may SEE
   * of a row is decided by `ReferralSubjectDataContract`, not here:
   * `V32-DEC-019` binds a referrer's export to carry no referee identity and a
   * referee's to carry no referrer code, and shaping that is the contract's job.
   *
   * Takes the caller's `EntityManager` so the export is one consistent snapshot
   * with every other module's, for the reason `allForSubject` above records.
   */
  async attributionsForSubject(
    manager: EntityManager,
    userId: string,
  ): Promise<{ asReferrer: ReferralAttributionEntity[]; asReferee: ReferralAttributionEntity[] }> {
    const repository = manager.getRepository(ReferralAttributionEntity);

    const [asReferrer, asReferee] = await Promise.all([
      repository.find({ where: { referrerUserId: userId }, order: { attributedAt: 'ASC', id: 'ASC' } }),
      repository.find({ where: { refereeUserId: userId }, order: { attributedAt: 'ASC', id: 'ASC' } }),
    ]);

    return { asReferrer, asReferee };
  }

  /**
   * Stamps the tombstone marker on every attribution this subject is party to,
   * and reports how many rows were touched.
   *
   * `V32-DEC-019`: `referral.referrals` is **retained**, with the **erased
   * side's identity tombstoned**, because the row explains a retained loyalty
   * entry the other party still holds.
   *
   * TWO statements rather than one `OR`, because a person can be the referrer
   * of some rows AND the referee of another, and the two markers are different
   * columns. A single `WHERE referrer_user_id = $1 OR referee_user_id = $1`
   * could not decide which marker to set without a `CASE`, and would stamp the
   * wrong one on the day somebody wrote that slightly wrong.
   *
   * Both are `UPDATE`s on a table whose four identity columns are frozen by
   * `tg_referrals_immutable` -- so if either statement ever grew a `SET` that
   * touched them, the database would refuse rather than a reviewer having to
   * catch it.
   *
   * `IS NULL` in each predicate makes this idempotent: a second erasure pass
   * stamps nothing and reports zero, rather than moving a timestamp that
   * records when the subject was erased.
   */
  async tombstoneAttributions(manager: EntityManager, userId: string, erasedAt: Date): Promise<number> {
    const asReferrer = await manager.query(
      `UPDATE referral.referrals SET referrer_erased_at = $2
        WHERE referrer_user_id = $1 AND referrer_erased_at IS NULL`,
      [userId, erasedAt],
    );
    const asReferee = await manager.query(
      `UPDATE referral.referrals SET referee_erased_at = $2
        WHERE referee_user_id = $1 AND referee_erased_at IS NULL`,
      [userId, erasedAt],
    );

    return rowCount(asReferrer) + rowCount(asReferee);
  }

  /**
   * Deletes the subject's claim-attempt counters.
   *
   * `subject_data`, deleted on erasure -- *a rate-limit counter about a person
   * who no longer exists*, which is the treatment `V32-DEC-019` prescribes for
   * `referral.referrer_counters` and the treatment `chat.send_counters`
   * already receives, in the decision's own words.
   *
   * Nothing depends on these rows surviving: they exist to bound a guess rate
   * for an account that can no longer authenticate.
   */
  async eraseClaimAttempts(manager: EntityManager, userId: string): Promise<number> {
    const result = await manager.query('DELETE FROM referral.claim_attempts WHERE claimant_user_id = $1', [userId]);
    return rowCount(result);
  }

  /**
   * The row, as the browser contract shapes it.
   *
   * Constructed field by field rather than spread. A spread would carry `id` and
   * `ownerUserId` — an internal identifier and a subject id the contract
   * deliberately does not expose — and would silently carry any column a later
   * migration adds.
   */
  private toView(row: ReferralCodeEntity): ReferralCodeView {
    const share = this.sharePayload(row.code);
    return {
      code: row.code,
      inviteUrl: share.url,
      shareText: share.text,
      shareChannels: [...REFERRAL_SHARE_CHANNELS],
    };
  }

  /**
   * The share payload, assembled from the contract's fixed template.
   *
   * Assembled HERE from the shared builders rather than written out, so the
   * server and the page cannot drift: `buildReferralInviteUrl` and
   * `buildReferralShareText` are the same functions a browser calls when it
   * renders a clipboard fallback.
   *
   * Exposed as a method rather than inlined because the payload shape is what
   * `V32-DEC-033` approved for native share — title, text, url, matching a
   * browser's `ShareData` — and keeping it assembled in one place is what makes
   * "nothing here is personal and nothing claims the platform sent it" a
   * property of one function rather than of every call site.
   */
  private sharePayload(code: string): ReferralSharePayload {
    return {
      title: REFERRAL_SHARE_TITLE,
      text: buildReferralShareText(code),
      url: buildReferralInviteUrl(this.publicOrigin(), code),
    };
  }

  /**
   * The configured public web origin the invite link is built on.
   *
   * `PUBLIC_WEB_BASE_URL` is the same variable the checkout return URL is built
   * from, and `env.validation.ts` requires it to be an absolute `https` URL in
   * production — so this is not a place that needs its own validation, only its
   * own fallback for local development.
   */
  private publicOrigin(): string {
    return this.config.get<string>('PUBLIC_WEB_BASE_URL') ?? 'http://localhost:3100';
  }
}

/**
 * The name of the unique constraint a failed write violated, or `null`.
 *
 * Reads the driver's `constraint` field rather than matching on the message
 * text: the message is localised by the server's `lc_messages` and is not a
 * stable interface, while `constraint` is the identifier the migration itself
 * chose.
 *
 * Returning `null` for anything that is not a unique violation is what makes the
 * caller's `throw error` branch reachable — a `NOT NULL` or CHECK violation must
 * surface, not be mistaken for a collision and silently retried five times.
 */
function uniqueViolationConstraint(error: unknown): string | null {
  if (!(error instanceof QueryFailedError)) return null;
  const driverError = (error as QueryFailedError & { code?: string; constraint?: string });
  if (driverError.code !== UNIQUE_VIOLATION) return null;
  return driverError.constraint ?? null;
}

/**
 * How many rows a write actually touched.
 *
 * TypeORM's postgres driver returns `[rows, rowCount]` for `UPDATE` and
 * `DELETE`, including when the statement carries `RETURNING`. Counting
 * `result.length` therefore reports 2 for every such statement — the defect
 * V3.2-B recorded as bug #3, where it made an erasure report a fabricated count
 * and made a compare-and-swap unable to observe its own loss.
 *
 * Lives HERE rather than in `referral-subject-data.contract.ts`, where it
 * previously sat as a private helper, because Story #27 gave the service its own
 * `UPDATE` and `DELETE` counts (`tombstoneAttributions`, `eraseClaimAttempts`).
 * Every other module keeps its copy inside its subject-data contract, which is
 * fine while that is the only caller; two copies inside ONE module is how the
 * two quietly stop agreeing, and this is the bug that already cost the platform
 * a fabricated erasure count once.
 *
 * Exported for the contract to import. Not part of the module's public surface
 * in any meaningful sense — it is a driver-shape detail — but the alternative is
 * duplication, and the export is the lesser cost.
 */
export function rowCount(result: unknown): number {
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}
