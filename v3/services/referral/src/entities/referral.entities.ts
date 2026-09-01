import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { OutboxEventEntityBase } from '@beauclick/events';
import type {
  ReferralRewardOutcome,
  ReferralRewardSide,
} from '@beauclick/event-contracts';

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

  /**
   * The lifecycle state — V3.2-C Story #12 (ADR-037 §2).
   *
   * Story #27 shipped without this column and ADR-036 §12 recorded why: the
   * pending state was the existence of the row plus `expires_at`, and a column
   * whose only value was `'pending'` would have been speculative. It is the
   * left-hand side of the qualification compare-and-swap now.
   *
   * See `REFERRAL_STATUSES` for why there is no `expired` and no `reversed`.
   */
  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: ReferralStatus;

  /**
   * When qualification happened, and WHICH booking caused it.
   *
   * Both NULL until qualification, both non-NULL after, and
   * `ck_referrals_qualification_complete` makes any other combination
   * unwritable — so a qualified referral without its qualifying booking is
   * unrepresentable rather than merely unlikely.
   *
   * `qualifyingBookingId` is the ONE thing this story builds for Story #28
   * (ADR-037 §13): `V32-DEC-017` makes a full refund of the qualifying
   * booking's order the reversal trigger, and without this column that story
   * would have to identify the order by guessing. **Nothing in this story reads
   * it.**
   *
   * Both are frozen once set by `tg_referrals_immutable`, with a different rule
   * from the four attribution columns: those are frozen always, these are
   * frozen once non-NULL, because NULL -> value is the qualification itself.
   */
  @Column({ type: 'timestamptz', nullable: true })
  qualifiedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  qualifyingBookingId!: string | null;
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

/**
 * The referral lifecycle status — V3.2-C Story #12 (ADR-037 §2).
 *
 * Exactly two values, and the two that are absent are absent on purpose:
 *
 *  * **no `expired`** — expiry is a PREDICATE (`expires_at <= now()`), not a
 *    state. Storing it would need a sweeper to maintain, which would make a
 *    referral's expiry depend on whether a background job had run rather than
 *    on the clock. The compare-and-swap reads the predicate directly.
 *  * **no `reversed`** — Story #28's vocabulary. Adding it now would put that
 *    story's data model on the table before its behaviour exists.
 */
export const REFERRAL_STATUSES = ['pending', 'qualified'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

/**
 * A reward grant — one per referral per side, always both — V3.2-C Story #12.
 *
 * ## Why two rows exist even when neither pays anything
 *
 * `V32-DEC-019`'s owner correction is explicit: *both grants must not be
 * skipped merely because the inviter reached their cap*, and *an invited
 * customer must never lose their own approved reward because of somebody
 * else's activity*. The two sides are independent facts, so they are two rows.
 *
 * With both configured values at 0 today, both rows will read
 * `disabled_zero, points 0` — and that is the point rather than a degenerate
 * case. `V32-DEC-016` requires zero to be **honestly disabled**: the platform
 * recording that it decided, on that date, to award zero is a materially
 * different claim from the platform recording nothing at all.
 *
 * ## The disposition is `retained`, and this row is the reason
 *
 * `V32-DEC-019` retains this table because it **explains a retained loyalty
 * ledger entry**. A points row with no grant accounting for it would be a
 * balance nobody could justify to the person holding it.
 */
@Entity({ name: 'reward_grants', schema: 'referral' })
@Unique('uq_reward_grants_referral_side', ['referralId', 'side'])
@Index('ix_reward_grants_recipient', ['recipientUserId'])
export class ReferralRewardGrantEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /**
   * The referral this grant explains.
   *
   * No relation and no foreign key, for the erasure-lifecycle reason ADR-036 §2
   * records: both rows are retained, and a referential action would tie their
   * fates together in a way no disposition asked for.
   */
  @Column({ type: 'uuid' })
  referralId!: string;

  /**
   * Whose grant this is.
   *
   * Named with the `_user_id` suffix so ADR-027's coverage heuristic recognises
   * it, and present at all so a subject's own grants are addressable **without
   * joining back to `referrals`** — which is what lets the privacy export show
   * a person their own outcome without ever loading the row that names the
   * counterparty.
   */
  @Column({ type: 'uuid' })
  recipientUserId!: string;

  @Column({ type: 'varchar', length: 16 })
  side!: ReferralRewardSide;

  @Column({ type: 'varchar', length: 24 })
  outcome!: ReferralRewardOutcome;

  /**
   * The CONFIGURED value at qualification time.
   *
   * Captured per row rather than derived on read, for the same reason
   * `loyalty.points_entries` captures `multiplier_bp`: a later change to the
   * configured figure must never retroactively alter what a past qualification
   * was worth. It is also what makes `disabled_zero, points 0` an explanation
   * instead of a restatement.
   */
  @Column({ type: 'int' })
  points!: number;

  /**
   * The ledger reason this side uses.
   *
   * Stored rather than derived from `side`, because this row's job is to
   * explain a retained ledger entry: if the side-to-reason mapping ever
   * changed, deriving it would silently rewrite the history of every past
   * grant.
   */
  @Column({ type: 'varchar', length: 64 })
  ledgerReason!: string;

  @Column({ type: 'timestamptz' })
  grantedAt!: Date;
}

/**
 * The per-referrer monthly cap counter — `V32-DEC-019`, ADR-037 §7.
 *
 * **Nothing reads this entity through the repository API**, and that is
 * deliberate rather than an oversight — the same note
 * `ReferralClaimAttemptEntity` carries. The counter is charged by one
 * conditional `INSERT … ON CONFLICT DO UPDATE … WHERE qualified_count < $3
 * RETURNING`, written as raw SQL on the caller's `EntityManager`, because the
 * whole guarantee is that the read and the write are **one statement**. A
 * repository `findOne` followed by a `save` is `GAP-04`, which `V32-DEC-019`
 * names and forbids in those words.
 *
 * The entity exists so the table is registered with TypeORM — which the
 * subject-data coverage check and the test harness's reset both rely on — and
 * so the column names have one definition.
 */
@Entity({ name: 'referrer_counters', schema: 'referral' })
export class ReferralReferrerCounterEntity {
  @PrimaryColumn('uuid')
  referrerUserId!: string;

  /**
   * The Tehran calendar month, `YYYY-MM`, from `tehranCalendarMonth`.
   *
   * See that function's docblock for the Gregorian-versus-Jalali question this
   * repository has not had to answer before, why it is answered as Gregorian
   * here, and why it is materially inert while both reward values are 0.
   */
  @PrimaryColumn({ type: 'varchar', length: 7 })
  period!: string;

  @Column({ type: 'int' })
  qualifiedCount!: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

/**
 * The referral outbox — the module's first, arriving with its first producer.
 *
 * ADR-035 §7 and ADR-036 §10 both declined to create this, and both were right
 * at the time: `ReferralAttributed` is deliberately not defined because it has
 * no consumer, and an outbox table nothing writes would still need a
 * subject-data claim nobody could verify.
 *
 * `ReferralQualified` v1 has a consumer (`V32-DEC-033`: the in-app,
 * opt-outable `referral` notification), so the table arrives now.
 *
 * Extends the shared base so the relay reads it through the same `OutboxSource`
 * abstraction as every other domain; a bespoke shape here would be a second
 * thing to keep in step for no benefit.
 */
@Entity({ name: 'outbox_events', schema: 'referral' })
export class ReferralOutboxEntity extends OutboxEventEntityBase {}

export const REFERRAL_ENTITIES = [
  ReferralCodeEntity,
  ReferralAttributionEntity,
  ReferralClaimAttemptEntity,
  ReferralRewardGrantEntity,
  ReferralReferrerCounterEntity,
  ReferralOutboxEntity,
];
