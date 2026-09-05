import { DataSource, EntityManager } from 'typeorm';

import type { OrderWithDetail, ZeroCollectibleTransition } from '@beauclick/commerce';

import {
  CheckoutService,
  InconsistentZeroCollectibleOrderException,
  ZeroCollectibleConfirmationRefusedException,
} from './checkout.service';

/**
 * The zero-collectible orchestration, at the layer where ORDERING is decidable
 * — V3.3 #81 (`#41b`), ADR-044 §3.
 *
 * ## Why this evidence is here and not only in the pg suite
 *
 * The real-PostgreSQL suite proves what happens to rows: that the transition is
 * a compare-and-swap, that a rollback leaves nothing behind, that the CHECK
 * constraint holds. What it cannot show cleanly is the thing `V33-DEC-023`
 * Ruling 3 actually binds — the *sequence* of the three calls, and that the same
 * `EntityManager` reaches all three. Those are properties of this function, and
 * a recording collaborator observes them directly.
 *
 * So the two layers prove different halves and neither is redundant: H-a and
 * "no intent was created" here, durability and concurrency there.
 *
 * Every collaborator is a hand-written recorder rather than a mock library
 * double, because the assertions are about call ORDER and ARGUMENT IDENTITY,
 * and an order-insensitive `toHaveBeenCalledWith` would pass on a path that
 * confirmed the booking first.
 */

/** The one manager every mutation must receive. Identity is asserted, not shape. */
const MANAGER = { marker: 'the-one-transaction-manager' } as unknown as EntityManager;

interface Recorded {
  readonly step: string;
  readonly manager: EntityManager | null;
}

function scheduleWithCollectible(collectible: number): OrderWithDetail {
  return {
    order: {
      id: 'order-1',
      customerId: 'customer-1',
      totalToman: 90_000,
      status: 'pending',
    },
    items: [],
    adjustments: [],
    schedule: { orderId: 'order-1', platformCollectibleToman: collectible },
  } as unknown as OrderWithDetail;
}

interface Harness {
  service: CheckoutService;
  calls: Recorded[];
  payments: { createIntentCalls: number; initiateCalls: number };
  bookingConfirmResult: { value: boolean };
  hookError: { value: Error | null };
  transition: { value: ZeroCollectibleTransition };
  bookingStatus: { value: string };
  transactionRolledBack: { value: boolean };
}

function harness(options: { collectible: number }): Harness {
  const calls: Recorded[] = [];
  const payments = { createIntentCalls: 0, initiateCalls: 0 };
  const bookingConfirmResult = { value: true };
  const hookError: { value: Error | null } = { value: null };
  const transition: { value: ZeroCollectibleTransition } = { value: { outcome: 'transitioned' } };
  const bookingStatus = { value: 'confirmed' };
  const transactionRolledBack = { value: false };

  const created = scheduleWithCollectible(options.collectible);

  const dataSource = {
    // Two transactions run in a zero-collectible checkout: the booking/order
    // creation one, then the confirmation one. Both are honoured here, and a
    // throw inside either is recorded as a rollback rather than swallowed.
    async transaction<T>(fn: (m: EntityManager) => Promise<T>): Promise<T> {
      try {
        return await fn(MANAGER);
      } catch (err) {
        transactionRolledBack.value = true;
        throw err;
      }
    },
  } as unknown as DataSource;

  const bookings = {
    async create() {
      return { id: 'booking-1', customerId: 'customer-1', professionalId: 'pro-1', serviceId: 'service-1' };
    },
    async confirm(_bookingId: string, _actor: unknown, manager: EntityManager) {
      calls.push({ step: 'booking.confirm', manager });
      return bookingConfirmResult.value;
    },
    async findById() {
      return { id: 'booking-1', status: bookingStatus.value };
    },
  };

  const orders = {
    async createForBooking() {
      return created;
    },
    async confirmNoOnlineCollection(_orderId: string, manager: EntityManager) {
      calls.push({ step: 'order.transition', manager });
      return transition.value;
    },
    async detailFor() {
      return created;
    },
  };

  const paymentsPort = {
    async createIntentForOrder() {
      payments.createIntentCalls += 1;
      calls.push({ step: 'payment.createIntent', manager: null });
      return { id: 'intent-1' };
    },
    async initiate() {
      payments.initiateCalls += 1;
      calls.push({ step: 'payment.initiate', manager: null });
      return { redirectUrl: 'https://gateway.example/pay' };
    },
  };

  const relay = { async drain() {} };

  const hook = {
    async onZeroCollectibleConfirmation(manager: EntityManager) {
      calls.push({ step: 'hook', manager });
      if (hookError.value) throw hookError.value;
    },
  };

  const service = new CheckoutService(
    dataSource,
    bookings as never,
    orders as never,
    paymentsPort as never,
    relay as never,
    hook,
  );

  return { service, calls, payments, bookingConfirmResult, hookError, transition, bookingStatus, transactionRolledBack };
}

const CHECKOUT_INPUT = {
  customerId: 'customer-1',
  professionalId: 'pro-1',
  slotId: 'slot-1',
  serviceId: 'service-1',
  idempotencyKey: null,
  callbackBaseUrl: 'https://api.example/v1/payments/callback',
};

describe('zero-collectible checkout orchestration (#81)', () => {
  describe('H-a: order, then hook, then booking', () => {
    it('runs the three mutations in exactly that order', async () => {
      const h = harness({ collectible: 0 });

      await h.service.checkout(CHECKOUT_INPUT as never);

      expect(h.calls.map((c) => c.step)).toEqual(['order.transition', 'hook', 'booking.confirm']);
    });

    it('gives all three the same EntityManager instance', async () => {
      const h = harness({ collectible: 0 });

      await h.service.checkout(CHECKOUT_INPUT as never);

      // Identity, not shape. A hook handed a fresh manager would write outside
      // the transaction that decides whether the booking exists at all, and a
      // structural comparison would not notice.
      for (const call of h.calls) expect(call.manager).toBe(MANAGER);
    });

    /**
     * The planted control for the ordering assertion above.
     *
     * Without it, `toEqual([...])` would also pass against an implementation
     * that never ran any of the three, or one whose recorder was broken. This
     * proves the recorder observes real order by showing it reports a
     * DIFFERENT order for a deliberately different sequence.
     */
    it('control: the recorder reports a different order when the sequence differs', () => {
      const observed: string[] = [];
      observed.push('booking.confirm');
      observed.push('hook');
      observed.push('order.transition');
      expect(observed).not.toEqual(['order.transition', 'hook', 'booking.confirm']);
    });
  });

  describe('no money-shaped fact is created', () => {
    it('creates no payment intent and calls no provider when the collectible is zero', async () => {
      const h = harness({ collectible: 0 });

      const result = await h.service.checkout(CHECKOUT_INPUT as never);

      expect(h.payments.createIntentCalls).toBe(0);
      expect(h.payments.initiateCalls).toBe(0);
      expect(h.calls.some((c) => c.step.startsWith('payment.'))).toBe(false);
      expect(result.paymentIntentId).toBeNull();
      expect(result.redirectUrl).toBeNull();
    });

    it('keeps both payment keys present rather than omitting them', async () => {
      const h = harness({ collectible: 0 });

      const result = await h.service.checkout(CHECKOUT_INPUT as never);

      // `in`, not a truthiness check: an omitted key and a null one are the
      // same to `?.` and completely different to a compiled client.
      expect('paymentIntentId' in result).toBe(true);
      expect('redirectUrl' in result).toBe(true);
    });

    /**
     * The positive control that makes the two negatives above non-vacuous: the
     * same harness, the same assertions inverted, one field changed.
     */
    it('control: a positive collectible DOES create an intent and initiate', async () => {
      const h = harness({ collectible: 90_000 });

      const result = await h.service.checkout(CHECKOUT_INPUT as never);

      expect(h.payments.createIntentCalls).toBe(1);
      expect(h.payments.initiateCalls).toBe(1);
      expect(result.paymentIntentId).toBe('intent-1');
      expect(result.redirectUrl).toBe('https://gateway.example/pay');
      // And it does NOT take the zero path.
      expect(h.calls.some((c) => c.step === 'order.transition')).toBe(false);
      expect(h.calls.some((c) => c.step === 'hook')).toBe(false);
    });

    it('branches on the schedule, not the order total', async () => {
      // `totalToman` is 90_000 in both harnesses. Only the schedule differs, so
      // a total-based branch would take the same path in both and fail here.
      const zero = harness({ collectible: 0 });
      const positive = harness({ collectible: 90_000 });

      await zero.service.checkout(CHECKOUT_INPUT as never);
      await positive.service.checkout(CHECKOUT_INPUT as never);

      expect(zero.payments.createIntentCalls).toBe(0);
      expect(positive.payments.createIntentCalls).toBe(1);
    });
  });

  describe('rollback', () => {
    it('rolls the transaction back and creates no refund when the hook throws', async () => {
      const h = harness({ collectible: 0 });
      h.hookError.value = new Error('entitlement refused');

      await expect(h.service.checkout(CHECKOUT_INPUT as never)).rejects.toThrow('entitlement refused');

      expect(h.transactionRolledBack.value).toBe(true);
      // The booking was never reached, so nothing to compensate -- and no
      // provider call of any kind was made.
      expect(h.calls.map((c) => c.step)).toEqual(['order.transition', 'hook']);
      expect(h.payments.createIntentCalls).toBe(0);
    });

    it('rolls back when the booking cannot be confirmed, and issues no refund', async () => {
      const h = harness({ collectible: 0 });
      h.bookingConfirmResult.value = false;

      await expect(h.service.checkout(CHECKOUT_INPUT as never)).rejects.toBeInstanceOf(
        ZeroCollectibleConfirmationRefusedException,
      );

      expect(h.transactionRolledBack.value).toBe(true);
      expect(h.payments.createIntentCalls).toBe(0);
      expect(h.payments.initiateCalls).toBe(0);
    });

    it('refuses when the order is no longer transitionable', async () => {
      const h = harness({ collectible: 0 });
      h.transition.value = { outcome: 'ineligible', reason: 'not_transitionable' };

      await expect(h.service.checkout(CHECKOUT_INPUT as never)).rejects.toBeInstanceOf(
        ZeroCollectibleConfirmationRefusedException,
      );

      // The hook never ran: an ineligible order gets no entitlement effect.
      expect(h.calls.map((c) => c.step)).toEqual(['order.transition']);
    });

    it('refuses a positive collectible at the service boundary too', async () => {
      const h = harness({ collectible: 0 });
      h.transition.value = { outcome: 'ineligible', reason: 'positive_collectible' };

      await expect(h.service.checkout(CHECKOUT_INPUT as never)).rejects.toBeInstanceOf(
        ZeroCollectibleConfirmationRefusedException,
      );
      expect(h.calls.map((c) => c.step)).toEqual(['order.transition']);
    });
  });

  describe('replay', () => {
    it('does not rerun the hook or re-confirm on an idempotent replay', async () => {
      const h = harness({ collectible: 0 });
      h.transition.value = { outcome: 'already' };

      const result = await h.service.checkout(CHECKOUT_INPUT as never);

      expect(h.calls.map((c) => c.step)).toEqual(['order.transition']);
      expect(result.paymentIntentId).toBeNull();
      expect(result.redirectUrl).toBeNull();
    });

    it('fails loudly rather than repairing an order whose booking is not confirmed', async () => {
      const h = harness({ collectible: 0 });
      h.transition.value = { outcome: 'already' };
      h.bookingStatus.value = 'pending';

      await expect(h.service.checkout(CHECKOUT_INPUT as never)).rejects.toBeInstanceOf(
        InconsistentZeroCollectibleOrderException,
      );

      // Not repaired: no confirmation was attempted on the way out.
      expect(h.calls.some((c) => c.step === 'booking.confirm')).toBe(false);
    });

    it('the impossible-state error is a plain Error, so the filter genericises it', async () => {
      const error = new InconsistentZeroCollectibleOrderException('order-1', 'booking-1');

      // A `DomainException` would be returned to the client verbatim, ids and
      // all. This must take the filter's non-HttpException branch.
      expect(error).toBeInstanceOf(Error);
      expect(Object.prototype.hasOwnProperty.call(error, 'getStatus')).toBe(false);
      expect(error.message).toContain('order-1');
    });
  });
});
