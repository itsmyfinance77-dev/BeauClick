import { Entity } from 'typeorm';
import { OutboxEventEntityBase } from '@beauclick/events';

@Entity({ name: 'outbox_events', schema: 'privacy' })
export class PrivacyOutboxEntity extends OutboxEventEntityBase {}
