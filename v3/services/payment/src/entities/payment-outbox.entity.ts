import { Entity } from 'typeorm';
import { OutboxEventEntityBase } from '@beauclick/events';

@Entity({ name: 'outbox_events', schema: 'payment' })
export class PaymentOutboxEntity extends OutboxEventEntityBase {}
