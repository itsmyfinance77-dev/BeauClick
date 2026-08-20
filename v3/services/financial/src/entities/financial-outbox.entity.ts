import { Entity } from 'typeorm';
import { OutboxEventEntityBase } from '@beauclick/events';

/**
 * The ONE financial table the writer role may UPDATE -- and only because
 * the relay must mark a row published.
 *
 * That narrow exception is deliberate and is asserted by the role-contract
 * spec: UPDATE is granted on `financial.outbox_events` and on nothing else
 * in the schema. An outbox row is a delivery receipt, not a financial fact,
 * so making it mutable costs the immutability guarantee nothing -- whereas
 * dropping the outbox entirely would leave financial events with no
 * transactional publication path at all.
 */
@Entity({ name: 'outbox_events', schema: 'financial' })
export class FinancialOutboxEntity extends OutboxEventEntityBase {}
