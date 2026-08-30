import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import { OutboxEventEntityBase } from '@beauclick/events';
import type {
  ChatClosedReason,
  ChatCounterpartyType,
  ChatModerationAction,
  ChatReportReason,
  ChatReportStatus,
  ChatSide,
} from '@beauclick/chat-contract';

/**
 * The `chat` schema's entities.
 *
 * Every column maps a column in
 * `database/migrations/chat/20260830500001_create_chat_schema.sql`, which is the
 * authority — `synchronize` is off everywhere and these classes exist so TypeORM
 * can read and write the real table, not so it can create one.
 *
 * Types come from `@beauclick/chat-contract` rather than being redeclared, so
 * the server and the browser cannot end up with two ideas of what a counterparty
 * type or a report reason is.
 */

@Entity({ schema: 'chat', name: 'conversations' })
export class ChatConversationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** The customer side. Always the authenticated session's user. */
  @Index()
  @Column({ type: 'uuid' })
  customerUserId!: string;

  /**
   * The seller side, as it was at checkout — copied once from
   * `commerce.orders.seller_party_type/seller_party_id` and **never
   * recomputed** (ADR-031 §1).
   *
   * `SellerPartyLookup` computes the CURRENT party and is deliberately not used
   * here. Using it would move an existing conversation to a business the
   * customer never transacted with, the first time a professional changed salon.
   */
  @Column({ type: 'varchar', length: 16 })
  counterpartyType!: ChatCounterpartyType;

  @Column({ type: 'uuid' })
  counterpartyId!: string;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status!: 'open' | 'closed';

  @Column({ type: 'int', default: 0 })
  messageCount!: number;

  /** The sequence high-water mark, allocated under this row's lock. */
  @Column({ type: 'int', default: 0 })
  lastSequence!: number;

  /** Retention is measured from here. Null until the first message. */
  @Column({ type: 'timestamptz', nullable: true })
  lastMessageAt!: Date | null;

  /**
   * Non-null means sending is refused; reading is unaffected.
   *
   * `V32-DEC-014` keeps history readable after a block, because destroying the
   * past would let one party unilaterally erase a record the other may need.
   */
  @Column({ type: 'timestamptz', nullable: true })
  closedForSendingAt!: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true })
  closedReason!: ChatClosedReason | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ schema: 'chat', name: 'conversation_participants' })
export class ChatParticipantEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  conversationId!: string;

  /** Denormalized, so the composite foreign key can hold. */
  @Column({ type: 'uuid' })
  customerUserId!: string;

  @Index()
  @Column({ type: 'uuid' })
  participantUserId!: string;

  @Column({ type: 'varchar', length: 16 })
  side!: ChatSide;

  /**
   * Monotonic. Only ever increases — a client reporting a lower value is
   * ignored rather than obeyed, because a watermark that can go backwards is a
   * way to make somebody else's unread badge reappear.
   *
   * A watermark rather than a per-message `read_at`: V2 used the column form,
   * which is correct for exactly two participants and wrong for three, and a
   * business-side conversation already has more than one legitimate reader.
   */
  @Column({ type: 'int', default: 0 })
  lastReadSequence!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastReadAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ schema: 'chat', name: 'messages' })
export class ChatMessageEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  conversationId!: string;

  @Column({ type: 'uuid' })
  customerUserId!: string;

  /** Null only on a structural placeholder left by account erasure. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  senderUserId!: string | null;

  /**
   * The message text — the platform's second store of private subject-authored
   * prose, and the first with two people in it.
   *
   * On account erasure this becomes NULL and `erasedAt` is stamped
   * (`V32-DEC-013`, the ADR-027-consistent option). The row survives so the
   * surviving counterparty's own messages keep their sequence and read as a
   * conversation; the prose does not. A null body carries no excerpt, no
   * searchable text, and nothing reconstructable — no ciphertext, no hash, not
   * even a preserved length.
   *
   * Stored here and in no event payload, notification payload, analytics
   * dimension, metric label, or log line.
   */
  @Column({ type: 'text', nullable: true })
  body!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  erasedAt!: Date | null;

  @Column({ type: 'int' })
  sequence!: number;

  /** Client-supplied. Scoped by (conversation, sender), never globally. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  idempotencyKey!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ schema: 'chat', name: 'blocks' })
export class ChatBlockEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** Directional record, mutual effect. See ADR-032 §2. */
  @Index()
  @Column({ type: 'uuid' })
  blockerUserId!: string;

  @Index()
  @Column({ type: 'uuid' })
  blockedUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ schema: 'chat', name: 'reports' })
export class ChatReportEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  conversationId!: string;

  @Column({ type: 'uuid' })
  customerUserId!: string;

  /** The anchor. Null once the anchored message is erased or gone. */
  @Column({ type: 'uuid', nullable: true })
  messageId!: string | null;

  /** Tombstoned rather than removed on erasure — a decision must stay attributable. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  reportedBy!: string | null;

  @Column({ type: 'varchar', length: 32 })
  reason!: ChatReportReason;

  /**
   * Moderation prose, capped at 500 code points by the application.
   *
   * Never enters an event, a notification, an analytics dimension, a metric
   * label, or a log line (ADR-032 §3).
   */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status!: ChatReportStatus;

  @Column({ type: 'uuid', nullable: true })
  decidedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  decisionReason!: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true })
  decisionAction!: ChatModerationAction | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ schema: 'chat', name: 'send_counters' })
export class ChatSendCounterEntity {
  @PrimaryColumn('uuid')
  userId!: string;

  /**
   * The minute this bucket covers, truncated, in UTC.
   *
   * A bucket rather than a rolling window: one counter row per user rewritten on
   * every send becomes a contention point on the busiest table in the schema.
   * Bucketing means concurrent senders in different minutes touch different rows.
   */
  @PrimaryColumn({ type: 'timestamptz' })
  windowStart!: Date;

  @Column({ type: 'int', default: 0 })
  sentCount!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ schema: 'chat', name: 'outbox_events' })
export class ChatOutboxEntity extends OutboxEventEntityBase {}

export const CHAT_ENTITIES = [
  ChatConversationEntity,
  ChatParticipantEntity,
  ChatMessageEntity,
  ChatBlockEntity,
  ChatReportEntity,
  ChatSendCounterEntity,
  ChatOutboxEntity,
];
