import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn, Unique } from 'typeorm';

/**
 * The referral code. One table, and the domain is complete for Story #11.
 *
 * There is deliberately no `expires_at`, no `revoked_at`, no usage or share
 * counter, no display snapshot, and no outbox entity anywhere in this module
 * (ADR-035 §§2, 7). Each absence is a decision the migration's header records at
 * length; the short version:
 *
 *  * **No expiry** — `V32-DEC-033` gives the invite link no independent expiry;
 *    its validity follows the code and the referral lifecycle. A column nothing
 *    sets would be a third clock.
 *  * **No soft revocation** — erasure is a hard delete (`V32-DEC-019`), and a
 *    `revoked_at` column would make that claim false in the schema while it was
 *    true in the code.
 *  * **No counters** — `V32-DEC-033` refuses share-tracking, and a usage count
 *    is an attribution fact this story does not build.
 *  * **No outbox** — nothing consumes a referral fact yet, and the two approved
 *    events belong to the reward path.
 */
@Entity({ name: 'referral_codes', schema: 'referral' })
@Unique('uq_referral_codes_owner', ['ownerUserId'])
@Unique('uq_referral_codes_code', ['code'])
export class ReferralCodeEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /**
   * The owner.
   *
   * Named `owner_user_id` rather than `owner_id` or anything shorter because
   * ADR-027's coverage heuristic recognises the `_user_id` SUFFIX: a
   * `no_subject_data` claim on this table would be rejected at boot on the
   * strength of the column name alone. The declared disposition and its test are
   * the real guarantee; the naming is belt, not braces.
   */
  @Column({ type: 'uuid' })
  ownerUserId!: string;

  /**
   * The code. Ten characters from the contract's 31-character alphabet.
   *
   * The column is `varchar(16)` while the code is 10 characters, deliberately:
   * the length is ratified at 10 by `V32-DEC-034` (ADR-035 §3), and the surplus
   * width means that a LATER owner decision to lengthen the code stays a constant
   * change rather than a column rewrite on a table attribution rows will by then
   * reference. The exact length is enforced by `ck_referral_codes_shape` and by
   * the contract.
   */
  @Column({ type: 'varchar', length: 16 })
  code!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

/**
 * The attribution relationship — V3.2-C Story #27 (ADR-036 §2).
 *
 * The first table in this module that is about **two people**, and every
 * property below follows from that.
 *
 * ## The guarantees are the constraints, not this class
 *
 * `@Unique` and `@Check` here generate nothing: the table is created by
 * `20260831700002_create_referral_attribution.sql`, and TypeORM never
 * synchronises this schema. They are declared anyway, and the reason is
 * legibility rather than enforcement — a reader looking at the entity should
 * see the two rules that make the domain safe, and a reader who changes this
 * class should be looking straight at what the migration will refuse.
 *
 * The real enforcement is in PostgreSQL and is proved by raw-SQL tests that
 * bypass this class entirely.
 *
 * ## Why there is no `@UpdateDateColumn`
 *
 * Because there is no update. Four of these columns are frozen by a database
 * trigger (`tg_referrals_immutable`) and the other two are stamped once, by
 * erasure. An `updated_at` would imply an ordinary mutable row and would be the
 * first thing a future writer reached for when adding one.
 */
@Entity({ name: 'referrals', schema: 'referral' })
@Unique('uq_referrals_referee', ['refereeUserId'])
@Check('ck_referrals_no_self', '"referrer_user_id" <> "referee_user_id"')
@Index('ix_referrals_referrer', ['referrerUserId'])
export class ReferralAttributionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /**
   * Who invited. Read from the claimed code's row, never sent by a caller.
   *
   * Not unique: one person may invite many, which is the entire product. Only
   * the referee is capped, and at one.
   */
  @Column({ type: 'uuid' })
  referrerUserId!: string;

  /**
   * Who was invited. **Always** the authenticated session (ADR-036 §1).
   *
   * `UNIQUE` is `V32-DEC-019`'s *attributed once, ever*, and it is the ONLY
   * mechanism — not a safety net under an application check. Two concurrent
   * claims for one referee both pass every eligibility read under READ
   * COMMITTED, and this constraint decides which wins; the loser reads `23505`
   * by constraint name and returns the collapsed refusal.
   *
   * Named with the `_user_id` suffix for the ADR-027 reason `ownerUserId`
   * above records: the coverage check recognises the suffix, so a
   * `no_subject_data` claim on this table would fail at boot on the strength of
   * the column name alone.
   */
  @Column({ type: 'uuid' })
  refereeUserId!: string;

  /**
   * WHICH code was claimed — the row's id, **not the code string**.
   *
   * A privacy decision rather than normalisation. The code is a bearer
   * credential and this row is `retained` past the referrer's erasure; storing
   * the string would retain a destroyed credential and put it one join from the
   * referee's export, which `V32-DEC-019` forbids in terms.
   *
   * There is deliberately **no relation and no foreign key**. The two rows have
   * different erasure lifecycles — the code is deleted, this row is retained —
   * and no referential action expresses that. A dangling reference after the
   * referrer's erasure is the correct end state.
   */
  @Column({ type: 'uuid' })
  referralCodeId!: string;

  /**
   * When the relationship formed, and when the pending attribution lapses.
   *
   * A plain `@Column` rather than `@CreateDateColumn`, deliberately: both are
   * written from ONE reading of the injected clock so the 90-day relationship
   * between them is exact. `@CreateDateColumn` would take its own value from
   * the driver and make `expires_at - attributed_at` differ from 90 days by
   * however long the transaction took.
   */
  @Column({ type: 'timestamptz' })
  attributedAt!: Date;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  /**
   * The tombstone markers (`V32-DEC-019`, ADR-036 §9).
   *
   * `referral.referrals` is `retained` **with the erased side's identity
   * tombstoned**, because the row is what explains a retained loyalty entry the
   * other party still holds. The row holds only ids and instants, so there is
   * no identifying content to destroy; what these add is a positive record that
   * one side is erased, which the ids alone cannot express.
   *
   * **These two are the only columns on this entity that may ever change**, and
   * `tg_referrals_immutable` is what makes that true rather than a convention.
   */
  @Column({ type: 'timestamptz', nullable: true })
  referrerErasedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  refereeErasedAt!: Date | null;
}

/**
 * The claim throttle's counter — V3.2-C Story #27 (`V32-DEC-019`, ADR-036 §6).
 *
 * **Nothing reads this entity through the repository API**, and that is
 * deliberate rather than an oversight. The counter is charged by one conditional
 * `INSERT … ON CONFLICT DO UPDATE … WHERE attempt_count < $3 RETURNING`, written
 * as raw SQL on the caller's `EntityManager`, because the whole guarantee is
 * that the read and the write are **one statement**. A repository `findOne`
 * followed by a `save` is `GAP-04`: two concurrent claims both observe 9 and
 * both write 10.
 *
 * The entity exists so the table is registered with TypeORM — which the
 * subject-data coverage check and the test harness's reset both rely on — and so
 * the column names have one definition. It is not a seam anybody should start
 * querying through.
 *
 * The composite primary key **is** the conflict target of that statement.
 */
@Entity({ name: 'claim_attempts', schema: 'referral' })
export class ReferralClaimAttemptEntity {
  /** `claimant_user_id`, not `user_id`, for the ADR-027 suffix reason above. */
  @PrimaryColumn('uuid')
  claimantUserId!: string;

  /** The start of the UTC hour, from `hourBucket` and the injected clock. */
  @PrimaryColumn({ type: 'timestamptz' })
  windowStart!: Date;

  @Column({ type: 'int' })
  attemptCount!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

export const REFERRAL_ENTITIES = [ReferralCodeEntity, ReferralAttributionEntity, ReferralClaimAttemptEntity];
