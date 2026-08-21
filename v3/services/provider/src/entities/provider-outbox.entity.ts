import { Entity } from 'typeorm';
import { OutboxEventEntityBase } from '@beauclick/events';

/**
 * provider-service's transactional outbox, new in Phase 3.
 *
 * Phase 2 gave booking, commerce, and payment an outbox because their facts
 * had consumers. Provider had none, so it had none. Search-service is that
 * consumer, and the outbox is what lets a profile edit and the announcement
 * of that edit commit or roll back together.
 */
@Entity({ name: 'outbox_events', schema: 'provider' })
export class ProviderOutboxEntity extends OutboxEventEntityBase {}
