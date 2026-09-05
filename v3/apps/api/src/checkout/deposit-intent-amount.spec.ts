import { DataSource, EntityManager } from 'typeorm';

import type { OrderWithDetail } from '@beauclick/commerce';

import { CheckoutService } from './checkout.service';

/**
 * The intent is created for the SCHEDULE's collectible — V3.3 #82 (`#41c`),
 * ADR-045 §8.
 *
 * ## Why this claim is proved here and not in the pg suite
 *
 * The real-PostgreSQL suite plants a deposit schedule onto an order whose intent
 * already exists, then re-prices the intent so the sandbox gateway agrees with
 * it. That makes the pipeline runnable, and it makes the intent's amount
 * unusable as evidence for THIS claim: the fixture would overwrite a wrong value
 * with the right one, and the test would pass against a `checkout` that had
 * asked for the service total. A mutation probe found exactly that.
 *
 * Here the two numbers differ in the harness and nothing rewrites them, so the
 * assertion discriminates. That is the whole reason this file exists.
 */

const MANAGER = { marker: 'checkout-transaction' } as unknown as EntityManager;

const SERVICE_TOTAL = 300_000;
const COLLECTIBLE = 90_000;

function depositOrder(): OrderWithDetail {
  return {
    order: {
      id: 'order-82',
      customerId: 'customer-82',
      totalToman: SERVICE_TOTAL,
      status: 'pending',
    },
    items: [],
    adjustments: [],
    schedule: {
      orderId: 'order-82',
      serviceTotalToman: SERVICE_TOTAL,
      platformCollectibleToman: COLLECTIBLE,
      venueBalanceToman: SERVICE_TOTAL - COLLECTIBLE,
    },
  } as unknown as OrderWithDetail;
}

function harness() {
  const requestedAmounts: number[] = [];
  const created = depositOrder();

  const dataSource = {
    async transaction<T>(fn: (m: EntityManager) => Promise<T>): Promise<T> {
      return fn(MANAGER);
    },
  } as unknown as DataSource;

  const service = new CheckoutService(
    dataSource,
    {
      async create() {
        return { id: 'booking-82', customerId: 'customer-82', professionalId: 'pro-82', serviceId: 'service-82' };
      },
      async confirm() {
        return true;
      },
      async findById() {
        return { id: 'booking-82', status: 'confirmed' };
      },
    } as never,
    {
      async createForBooking() {
        return created;
      },
      async detailFor() {
        return created;
      },
    } as never,
    {
      async createIntentForOrder(input: { amountToman: number }) {
        requestedAmounts.push(input.amountToman);
        return { id: 'intent-82' };
      },
      async initiate() {
        return { redirectUrl: 'https://gateway.example/pay' };
      },
    } as never,
    { async drain() {} } as never,
    { async onZeroCollectibleConfirmation() {} },
  );

  return { service, requestedAmounts };
}

const INPUT = {
  customerId: 'customer-82',
  professionalId: 'pro-82',
  slotId: 'slot-82',
  serviceId: 'service-82',
  idempotencyKey: null,
  callbackBaseUrl: 'https://api.example/v1/payments/callback',
};

describe('deposit intent amount (#82)', () => {
  it('asks the gateway for the schedule collectible, never the service total', async () => {
    const h = harness();

    await h.service.checkout(INPUT as never);

    expect(h.requestedAmounts).toEqual([COLLECTIBLE]);
    // The discriminating assertion: the order total is a different, larger
    // number in this harness, so a `totalToman`-based implementation fails here.
    expect(h.requestedAmounts).not.toContain(SERVICE_TOTAL);
    expect(SERVICE_TOTAL).toBeGreaterThan(COLLECTIBLE);
  });

  it('control: exactly one intent is created, so the assertion is not vacuous', async () => {
    const h = harness();

    await h.service.checkout(INPUT as never);

    expect(h.requestedAmounts).toHaveLength(1);
  });
});
