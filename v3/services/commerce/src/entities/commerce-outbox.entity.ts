import { Entity } from 'typeorm';
import { OutboxEventEntityBase } from '@beauclick/events';

@Entity({ name: 'outbox_events', schema: 'commerce' })
export class CommerceOutboxEntity extends OutboxEventEntityBase {}
