import { DataSource, Entity } from 'typeorm';
import { createInMemoryDataSource } from '@beauclick/testing';
import { ForbiddenEventPayloadError, assertPayloadHasNoSecrets, EventEnvelope } from './event-envelope';
import { OutboxEventEntityBase } from './outbox-event.entity';
import { emitEvent } from './outbox.writer';
import { OutboxRelay, OutboxSource } from './outbox.relay';
import { DomainEventHandler } from './event-handler';

@Entity({ name: 'outbox_events', schema: 'events_test' })
class TestOutboxEntity extends OutboxEventEntityBase {}

class RecordingHandler implements DomainEventHandler {
  readonly seen: EventEnvelope[] = [];
  constructor(readonly eventType: string) {}
  async handle(envelope: EventEnvelope): Promise<void> {
    this.seen.push(envelope);
  }
}

class ExplodingHandler implements DomainEventHandler {
  calls = 0;
  constructor(
    readonly eventType: string,
    private readonly failTimes: number,
  ) {}
  async handle(): Promise<void> {
    this.calls += 1;
    if (this.calls <= this.failTimes) throw new Error('handler blew up');
  }
}

describe('event payload secret guard', () => {
  it('accepts a legitimate domain payload', () => {
    expect(() =>
      assertPayloadHasNoSecrets({ bookingId: 'b1', orderId: 'o1', amount: 250_000, providerReference: 'A0000001' }),
    ).not.toThrow();
  });

  it('rejects an OTP code at the top level', () => {
    expect(() => assertPayloadHasNoSecrets({ phone: '+98912', code: '123456' })).toThrow(ForbiddenEventPayloadError);
  });

  it('rejects a refresh token nested inside another object', () => {
    expect(() => assertPayloadHasNoSecrets({ session: { device: 'web', refreshToken: 'abc' } })).toThrow(
      /refreshToken/,
    );
  });

  it('rejects a secret hidden inside an array element', () => {
    expect(() => assertPayloadHasNoSecrets({ attempts: [{ ok: true }, { password: 'hunter2' }] })).toThrow(
      ForbiddenEventPayloadError,
    );
  });

  it('is case-insensitive about the forbidden key name', () => {
    expect(() => assertPayloadHasNoSecrets({ CodeHash: 'deadbeef' })).toThrow(ForbiddenEventPayloadError);
  });

  it('does not reject legitimate keys that merely contain a sensitive-looking substring', () => {
    // A naive /token|secret/ substring rule would break these real payload fields.
    expect(() => assertPayloadHasNoSecrets({ paymentIntentId: 'p1', tokenizedCardLast4: null })).not.toThrow();
  });
});

describe('transactional outbox', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await createInMemoryDataSource([TestOutboxEntity]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.getRepository(TestOutboxEntity).clear();
  });

  // NOTE: the outbox's defining guarantee -- that a staged event is rolled
  // back together with a failed business write -- is deliberately NOT
  // asserted here. pg-mem does not honour TypeORM's ROLLBACK (verified
  // directly in this pass: a row written inside a transaction that throws
  // is still present afterwards), so an assertion here would pass or fail
  // for reasons unrelated to our code. It is asserted for real, against a
  // real server, in apps/api/test/outbox-transactional.pg-spec.ts.

  it('commits the event row together with a successful business transaction', async () => {
    await dataSource.transaction(async (manager) => {
      await emitEvent(manager, TestOutboxEntity, {
        aggregateType: 'booking',
        aggregateId: '01926a3e-0000-7000-8000-000000000002',
        eventType: 'BookingCreated',
        payload: { bookingId: 'b2' },
      });
    });

    const rows = await dataSource.getRepository(TestOutboxEntity).find();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('BookingCreated');
    expect(rows[0].eventVersion).toBe(1);
    expect(rows[0].publishedAt).toBeNull();
  });

  it('refuses to stage an event whose payload carries a secret', async () => {
    await expect(
      dataSource.transaction(async (manager) =>
        emitEvent(manager, TestOutboxEntity, {
          aggregateType: 'identity',
          aggregateId: '01926a3e-0000-7000-8000-000000000003',
          eventType: 'OtpGenerated',
          payload: { phone: '+989120000000', code: '123456' },
        }),
      ),
    ).rejects.toThrow(ForbiddenEventPayloadError);
  });
});

describe('outbox relay', () => {
  let dataSource: DataSource;
  const source: OutboxSource = { name: 'test', entity: TestOutboxEntity };

  beforeAll(async () => {
    dataSource = await createInMemoryDataSource([TestOutboxEntity]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.getRepository(TestOutboxEntity).clear();
  });

  async function stage(eventType: string, payload: Record<string, unknown>): Promise<void> {
    await dataSource.transaction(async (manager) => {
      await emitEvent(manager, TestOutboxEntity, {
        aggregateType: 'test',
        aggregateId: '01926a3e-0000-7000-8000-00000000000a',
        eventType,
        payload,
      });
    });
  }

  it('delivers a staged event to its registered handler and marks the row published', async () => {
    const handler = new RecordingHandler('OrderPaid');
    const relay = new OutboxRelay(dataSource, [source], [handler]);

    await stage('OrderPaid', { orderId: 'o1', totalAmount: 250_000 });
    const result = await relay.drain();

    expect(result).toEqual({ dispatched: 1, failed: 0 });
    expect(handler.seen).toHaveLength(1);
    expect(handler.seen[0].payload).toEqual({ orderId: 'o1', totalAmount: 250_000 });

    const [row] = await dataSource.getRepository(TestOutboxEntity).find();
    expect(row.publishedAt).not.toBeNull();
  });

  it('never redelivers an already-published row on a second drain', async () => {
    const handler = new RecordingHandler('OrderPaid');
    const relay = new OutboxRelay(dataSource, [source], [handler]);

    await stage('OrderPaid', { orderId: 'o1' });
    await relay.drain();
    await relay.drain();

    expect(handler.seen).toHaveLength(1);
  });

  it('ignores an event nobody consumes, rather than failing', async () => {
    const relay = new OutboxRelay(dataSource, [source], []);
    await stage('NobodyCares', { x: 1 });

    expect(await relay.drain()).toEqual({ dispatched: 1, failed: 0 });
  });

  it('fans one event out to every handler registered for its type', async () => {
    const a = new RecordingHandler('BookingCancelled');
    const b = new RecordingHandler('BookingCancelled');
    const relay = new OutboxRelay(dataSource, [source], [a, b]);

    await stage('BookingCancelled', { bookingId: 'b1' });
    await relay.drain();

    expect(a.seen).toHaveLength(1);
    expect(b.seen).toHaveLength(1);
  });

  it('leaves a failed row UNPUBLISHED so the next sweep retries it', async () => {
    const handler = new ExplodingHandler('PaymentSucceeded', 1);
    const relay = new OutboxRelay(dataSource, [source], [handler]);

    await stage('PaymentSucceeded', { paymentId: 'p1' });

    expect(await relay.drain()).toEqual({ dispatched: 0, failed: 1 });
    const [afterFailure] = await dataSource.getRepository(TestOutboxEntity).find();
    expect(afterFailure.publishedAt).toBeNull();
    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.lastError).toContain('handler blew up');

    // Retry succeeds -- at-least-once delivery, actually delivered.
    expect(await relay.drain()).toEqual({ dispatched: 1, failed: 0 });
    const [afterRetry] = await dataSource.getRepository(TestOutboxEntity).find();
    expect(afterRetry.publishedAt).not.toBeNull();
  });

  it('delivers a single aggregate its events in the order they happened', async () => {
    const handler = new RecordingHandler('Ordered');
    const relay = new OutboxRelay(dataSource, [source], [handler]);

    await stage('Ordered', { seq: 1 });
    await stage('Ordered', { seq: 2 });
    await stage('Ordered', { seq: 3 });
    await relay.drain();

    expect(handler.seen.map((e) => e.payload.seq)).toEqual([1, 2, 3]);
  });

  it('reports which event types have a consumer', () => {
    const relay = new OutboxRelay(dataSource, [source], [new RecordingHandler('B'), new RecordingHandler('A')]);
    expect(relay.registeredEventTypes()).toEqual(['A', 'B']);
  });
});
