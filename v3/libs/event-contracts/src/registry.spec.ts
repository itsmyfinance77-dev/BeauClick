import { z } from 'zod';
import { defineEvent } from './event-contract';
import {
  DuplicateEventContractError,
  EventContractRegistry,
  EventContractViolationError,
  ProducerViolationError,
  UnknownEventContractError,
} from './registry';
import { ALL_EVENT_CONTRACTS, BookingCompleted, OrderPaid, SearchPerformed } from './catalog';
import { createEventContractRegistry } from './event-catalog.provider';

describe('EventContractRegistry', () => {
  const Sample = defineEvent({
    name: 'SampleEvent',
    version: 1,
    aggregateType: 'sample',
    producer: 'booking',
    description: 'test',
    idempotency: 'test',
    schema: z.object({ id: z.string().uuid(), count: z.number().int() }),
  });

  it('rejects a payload that violates its contract, naming the field', () => {
    const registry = new EventContractRegistry().register(Sample);

    expect(() => registry.validate('SampleEvent', 1, { id: 'not-a-uuid', count: 1 })).toThrow(
      EventContractViolationError,
    );

    try {
      registry.validate('SampleEvent', 1, { id: 'not-a-uuid', count: 1 });
    } catch (err) {
      // The field must be named. A validation error that says only "invalid"
      // sends whoever is on call reading the whole payload by hand.
      expect((err as EventContractViolationError).issues.join()).toContain('id');
    }
  });

  it('rejects an unknown event outright', () => {
    const registry = new EventContractRegistry();
    expect(() => registry.validate('NeverDeclared', 1, {})).toThrow(UnknownEventContractError);
  });

  it('treats a version bump as a different contract', () => {
    const v2 = defineEvent({ ...Sample, version: 2 });
    const registry = new EventContractRegistry().register(Sample, v2);

    expect(registry.has('SampleEvent', 1)).toBe(true);
    expect(registry.has('SampleEvent', 2)).toBe(true);
    expect(registry.has('SampleEvent', 3)).toBe(false);
  });

  it('refuses to re-register the same (name, version)', () => {
    // The rule that keeps a deployed consumer working: a payload change must
    // be a NEW version, never an edit to one already in the wild.
    const registry = new EventContractRegistry().register(Sample);
    expect(() => registry.register(defineEvent({ ...Sample }))).toThrow(DuplicateEventContractError);
  });

  it('refuses an emit from a service that does not own the event', () => {
    const registry = new EventContractRegistry().register(Sample);
    expect(() => registry.assertProducer('SampleEvent', 1, 'commerce')).toThrow(ProducerViolationError);
    expect(() => registry.assertProducer('SampleEvent', 1, 'booking')).not.toThrow();
  });

  it('STRIPS undeclared keys rather than passing them through', () => {
    const registry = new EventContractRegistry().register(Sample);
    const id = '018f0000-0000-7000-8000-000000000000';

    const parsed = registry.validate('SampleEvent', 1, {
      id,
      count: 3,
      // The realistic accident: an entity spread into a payload, carrying a
      // field nobody meant to publish.
      phone: '+989120000000',
      internalNote: 'do not share',
    });

    expect(parsed).toEqual({ id, count: 3 });
    expect(parsed).not.toHaveProperty('phone');
    expect(parsed).not.toHaveProperty('internalNote');
  });

  it('fails boot when a consumer names an event nobody produces', () => {
    const registry = new EventContractRegistry().register(Sample);
    registry.registerConsumer({
      eventName: 'SampleEvnet', // typo, on purpose
      eventVersion: 1,
      consumer: 'search',
      handler: 'TypoHandler',
      description: 'registered against a name that does not exist',
    });

    // The failure mode this prevents: a handler sitting silently idle in
    // production, discovered only when somebody asks why nothing happened.
    expect(() => registry.assertConsumersHaveProducers()).toThrow(/SampleEvnet/);
  });

  it('fails boot when a consumer pins a version that was never published', () => {
    const registry = new EventContractRegistry().register(Sample);
    registry.registerConsumer({
      eventName: 'SampleEvent',
      eventVersion: 2,
      consumer: 'search',
      handler: 'StaleHandler',
      description: 'pinned to a version nobody publishes',
    });
    expect(() => registry.assertConsumersHaveProducers()).toThrow(/SampleEvent@v2/);
  });

  it('reports events nothing consumes without treating it as an error', () => {
    const registry = new EventContractRegistry().register(Sample);
    expect(registry.unconsumedEvents()).toEqual(['SampleEvent@v1']);
    registry.registerConsumer({
      eventName: 'SampleEvent',
      eventVersion: 1,
      consumer: 'search',
      handler: 'RealHandler',
      description: 'x',
    });
    expect(registry.unconsumedEvents()).toEqual([]);
  });
});

describe('the published catalog', () => {
  const registry = createEventContractRegistry();

  it('registers every contract with no duplicate (name, version)', () => {
    expect(ALL_EVENT_CONTRACTS.length).toBeGreaterThan(0);
    const keys = ALL_EVENT_CONTRACTS.map((c) => `${c.name}@v${c.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every contract exactly one producer and a stated idempotency strategy', () => {
    for (const contract of ALL_EVENT_CONTRACTS) {
      expect(contract.producer).toBeTruthy();
      // ADR-007's requirement: idempotency is a required field per event, not
      // an afterthought each consumer invents for itself.
      expect(contract.idempotency.length).toBeGreaterThan(10);
      expect(contract.description.length).toBeGreaterThan(10);
    }
  });

  it('accepts the payload shape booking-service actually emits', () => {
    expect(() =>
      registry.validate(BookingCompleted.name, 1, {
        bookingId: '018f0000-0000-7000-8000-000000000001',
        professionalId: '018f0000-0000-7000-8000-000000000002',
        customerId: '018f0000-0000-7000-8000-000000000003',
        serviceId: '018f0000-0000-7000-8000-000000000004',
        completedAt: new Date().toISOString(),
      }),
    ).not.toThrow();
  });

  it('rejects an OrderPaid whose total is a float', () => {
    // Integer Toman throughout (ADR-017). A fractional amount reaching the
    // ledger is a money bug, and the payload is where it would enter.
    expect(() =>
      registry.validate(OrderPaid.name, 1, {
        orderId: '018f0000-0000-7000-8000-000000000001',
        sourceType: 'booking',
        sourceId: '018f0000-0000-7000-8000-000000000002',
        customerId: '018f0000-0000-7000-8000-000000000003',
        sellerPartyType: 'professional',
        sellerPartyId: '018f0000-0000-7000-8000-000000000004',
        totalToman: 1000.5,
        currency: 'IRT',
        paidAt: new Date().toISOString(),
      }),
    ).toThrow(EventContractViolationError);
  });

  it('gives SearchPerformed no field capable of holding query text', () => {
    // The privacy rule, asserted structurally rather than by reading the code:
    // a raw query smuggled into the payload must not survive validation.
    const parsed = registry.validate(SearchPerformed.name, 1, {
      searchId: '018f0000-0000-7000-8000-000000000001',
      queryClass: 'text',
      queryTermCount: 2,
      filterKeys: ['city'],
      sort: 'relevance',
      resultCount: 5,
      page: 1,
      tookMs: 12,
      degraded: false,
      userId: null,
      occurredAt: new Date().toISOString(),
      query: 'سالن زیبایی کیمیا',
      q: 'سالن زیبایی کیمیا',
    });

    expect(parsed).not.toHaveProperty('query');
    expect(parsed).not.toHaveProperty('q');
    expect(JSON.stringify(parsed)).not.toContain('کیمیا');
  });

  it('declares no contract carrying a credential-shaped field name', () => {
    // The catalog's hardest rule, checked against the catalog itself rather
    // than only at write time.
    const forbidden = ['code', 'otp', 'password', 'token', 'accessToken', 'refreshToken', 'secret', 'cardNumber'];
    for (const contract of ALL_EVENT_CONTRACTS) {
      const shape = (contract.schema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      for (const key of Object.keys(shape)) {
        expect(forbidden).not.toContain(key);
      }
    }
  });
});
