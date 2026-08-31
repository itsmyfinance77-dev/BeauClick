import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import {
  REFERRAL_SHARE_CHANNELS,
  REFERRAL_SHARE_TITLE,
  buildReferralInviteUrl,
  buildReferralShareText,
} from '@beauclick/referral-contract';
import type { ReferralCodeView, ReferralSharePayload } from '@beauclick/referral-contract';

import { ReferralCodeEntity } from './entities/referral.entities';
import { REFERRAL_CODE_GENERATOR, ReferralCodeGenerator } from './referral-code.generator';

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
