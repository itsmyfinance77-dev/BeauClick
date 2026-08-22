import { Entity } from 'typeorm';
import { OutboxEventEntityBase } from '@beauclick/events';

@Entity({ name: 'outbox_events', schema: 'business' })
export class BusinessOutboxEntity extends OutboxEventEntityBase {}
