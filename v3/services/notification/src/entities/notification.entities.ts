import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { OutboxEventEntityBase } from '@beauclick/events';

export const NOTIFICATION_CATEGORIES = [
  'booking',
  'payment',
  'reminder',
  'waitlist',
  'rebooking',
  'retention',
  'referral',
  'loyalty',
  // V3.1 Phase E. Additive: no existing payload shape changes and no consumer
  // loses a value it understood. See privacy.events.ts for why these messages
  // exist and 20260828300002 for why the category is mandatory.
  'privacy',
  // V3.2-B. Deliberately NOT added to `MANDATORY_CATEGORIES` below: a chat
  // message is not operationally required the way a booking confirmation or a
  // payment receipt is, so a customer may switch it off. `V32-DEC-014`'s
  // milestone boundary requires the category to be opt-outable.
  'chat',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * Categories a customer may never switch off.
 *
 * A booking confirmation and a payment receipt are operationally required
 * messages: suppressing one leaves a customer with money gone and no record
 * of what it bought. V2 enforced this by simply having no preference key for
 * them; V3 keeps the key in the domain but makes a disabling row unwritable
 * via a CHECK constraint -- stronger, because a bug in the preference-update
 * path then cannot suppress a receipt either.
 */
export const MANDATORY_CATEGORIES: readonly NotificationCategory[] = ['booking', 'payment', 'privacy'];

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'sms'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'suppressed' | 'dead_lettered';

@Entity({ name: 'notifications', schema: 'notification' })
export class NotificationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 20 })
  category!: NotificationCategory;

  @Column({ type: 'varchar', length: 60 })
  templateKey!: string;

  @Column({ type: 'varchar', length: 10 })
  channel!: NotificationChannel;

  /**
   * Template VARIABLES, never rendered text.
   *
   * V2 deliberately did not store these, and its own retry path documents the
   * cost: it could not re-render the original message, so a retry sent a
   * generic "you have a notification" notice instead of the real one. Storing
   * the variables makes a retry send what the first attempt would have sent,
   * and keeps the rendered Persian sentence from existing at rest at all.
   */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  payload!: Record<string, string | number>;

  /** Relative path only. An absolute URL here would be an open-redirect surface. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  deepLink!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: NotificationStatus;

  @Column({ type: 'varchar', length: 255 })
  idempotencyKey!: string;

  @Column({ type: 'varchar', length: 40 })
  entityType!: string;

  @Column({ type: 'uuid' })
  entityId!: string;

  /** A stable code, never a provider's raw error string -- those carry recipient addresses. */
  @Column({ type: 'varchar', length: 60, nullable: true })
  errorCode!: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  readAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deadLetteredAt!: Date | null;
}

@Entity({ name: 'preferences', schema: 'notification' })
export class NotificationPreferenceEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 20 })
  category!: NotificationCategory;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}

@Entity({ name: 'outbox_events', schema: 'notification' })
export class NotificationOutboxEntity extends OutboxEventEntityBase {}

export const NOTIFICATION_ENTITIES = [NotificationEntity, NotificationPreferenceEntity, NotificationOutboxEntity];
