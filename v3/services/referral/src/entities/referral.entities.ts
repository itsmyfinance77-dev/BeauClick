import { Column, CreateDateColumn, Entity, PrimaryColumn, Unique } from 'typeorm';

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

export const REFERRAL_ENTITIES = [ReferralCodeEntity];
