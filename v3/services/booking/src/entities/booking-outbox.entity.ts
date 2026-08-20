import { Entity } from 'typeorm';
import { OutboxEventEntityBase } from '@beauclick/events';

/** booking-service's own outbox table. One per schema, per ADR-011: no module reads another module's tables. */
@Entity({ name: 'outbox_events', schema: 'booking' })
export class BookingOutboxEntity extends OutboxEventEntityBase {}
