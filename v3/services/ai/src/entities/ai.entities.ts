import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import { OutboxEventEntityBase } from '@beauclick/events';
import type {
  AiClosureReason,
  AiConversationStatus,
  AiMessageRole,
  AiProviderState,
  AiRecommendationTarget,
} from '@beauclick/ai-contract';

/**
 * The `ai` schema's entities.
 *
 * Every column maps a column in `database/migrations/ai/20260829400001_create_ai_schema.sql`,
 * which is the authority -- `synchronize` is off everywhere and these classes
 * exist so TypeORM can read and write the real table, not so it can create one.
 *
 * The types are imported from `@beauclick/ai-contract` rather than redeclared,
 * so the server and the browser cannot end up with two ideas of what a message
 * role or a provider state is. That package is dependency-free by design; a
 * `type`-only import keeps it that way in the direction that matters (nothing
 * here leaks into a browser bundle).
 */

@Entity({ schema: 'ai', name: 'conversations' })
export class AiConversationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /**
   * The owner. Always the authenticated session's user.
   *
   * No route accepts this value from a caller, and the composite foreign keys
   * on `messages` and `recommendations` make a mismatch between a child's owner
   * and this one impossible to write.
   */
  @Index()
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: AiConversationStatus;

  @Column({ type: 'varchar', length: 20, nullable: true })
  closureReason!: AiClosureReason | null;

  @Column({ type: 'int', default: 0 })
  messageCount!: number;

  /**
   * When this conversation last ACCEPTED a message.
   *
   * Not touched by reads. A customer re-reading their own history must not
   * extend the 24-hour horizon, or the bound would measure browsing rather than
   * use -- and an unbounded session is the exact shape `V32-DEC-002` exists to
   * prevent.
   */
  @Column({ type: 'timestamptz' })
  lastActivityAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ schema: 'ai', name: 'messages' })
export class AiMessageEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  conversationId!: string;

  @Index()
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 16 })
  role!: AiMessageRole;

  /**
   * The message text -- the most sensitive prose in the platform.
   *
   * `subject_data` under `V32-DEC-007`. It exists in this column and nowhere
   * else: not in an event payload, not in an analytics dimension, not in a
   * metric label, not in a log line, not in an error report (ADR-030 T6).
   * Every one of those is asserted by a test that drives a real exchange and
   * searches the resulting artefacts for the text.
   */
  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'int' })
  sequence!: number;

  /** The provider key on an assistant reply; null on a customer message. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  providerKey!: string | null;

  /**
   * What KIND of thing produced this reply, recorded permanently.
   *
   * `V32-DEC-008` requires provider mode to be recorded honestly. Stored per
   * message rather than derived from current configuration, because a
   * conversation read six months from now must still be able to say that a
   * particular paragraph came from a deterministic local assistant -- and by
   * then the deployment may be running something else entirely.
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  providerState!: AiProviderState | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ schema: 'ai', name: 'recommendations' })
export class AiRecommendationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  messageId!: string;

  @Column({ type: 'uuid' })
  conversationId!: string;

  @Index()
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 20 })
  targetType!: AiRecommendationTarget;

  /**
   * A catalogue id that survived independent re-verification.
   *
   * A row existing here means the record existed, was public, and was visible
   * at the moment the reply was produced -- not merely that a provider named it
   * (ADR-030 T3). There is no `verified` column because an unverified
   * recommendation has no representation.
   */
  @Column({ type: 'uuid' })
  targetId!: string;

  /** Snapshotted public display name. See the migration for why it is not re-resolved. */
  @Column({ type: 'varchar', length: 191 })
  displayName!: string;

  @Column({ type: 'int' })
  position!: number;

  @Column({ type: 'timestamptz', nullable: true })
  clickedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ schema: 'ai', name: 'assistant_consents' })
export class AiConsentEntity {
  /** The customer IS the key. One acceptance, recorded once (`V32-DEC-006`). */
  @PrimaryColumn('uuid')
  userId!: string;

  /**
   * Which acceptance was recorded.
   *
   * Not a version number: a version implies a sequence, a re-prompt, and a
   * withdrawal path, which is the platform-wide consent system scheduled at
   * V3.3-E. This names the one disclosure the user actually saw, so an
   * acceptance gathered under sandbox wording stays distinguishable from one
   * gathered under the legally-reviewed copy that does not exist yet.
   */
  @Column({ type: 'varchar', length: 60 })
  contractKey!: string;

  @Column({ type: 'timestamptz' })
  acceptedAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ schema: 'ai', name: 'usage_daily' })
export class AiUsageDailyEntity {
  @PrimaryColumn('uuid')
  userId!: string;

  /**
   * The TEHRAN calendar day, as `YYYY-MM-DD`.
   *
   * A string rather than a Date on purpose: this is a calendar coordinate, not
   * an instant, and round-tripping it through a JavaScript `Date` would
   * reintroduce exactly the timezone question the column exists to have already
   * answered.
   */
  @PrimaryColumn({ type: 'date' })
  usageDay!: string;

  /** The quota counter. Accepted customer messages only (ADR-030 T5). */
  @Column({ type: 'int', default: 0 })
  acceptedMessages!: number;

  @Column({ type: 'int', default: 0 })
  simulatedReplies!: number;

  @Column({ type: 'int', default: 0 })
  externalReplies!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ schema: 'ai', name: 'outbox_events' })
export class AiOutboxEntity extends OutboxEventEntityBase {}

export const AI_ENTITIES = [
  AiConversationEntity,
  AiMessageEntity,
  AiRecommendationEntity,
  AiConsentEntity,
  AiUsageDailyEntity,
  AiOutboxEntity,
];
