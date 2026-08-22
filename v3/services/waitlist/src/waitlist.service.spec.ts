import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { createInMemoryDataSource } from '@beauclick/testing';

import { WaitlistEntryEntity } from './entities/waitlist-entry.entity';
import { WaitlistOutboxEntity } from './entities/waitlist-outbox.entity';
import { WaitlistConfig } from './waitlist.config';
import { WaitlistService } from './waitlist.service';
import { AlreadyOnWaitlistException, OfferNotAvailableException } from './waitlist.errors';

function config(values: Record<string, string> = {}): WaitlistConfig {
  return new WaitlistConfig({ get: (key: string) => values[key] } as unknown as ConfigService);
}

describe('WaitlistService (integration, pg-mem)', () => {
  let dataSource: DataSource;
  let service: WaitlistService;

  beforeEach(async () => {
    dataSource = await createInMemoryDataSource([WaitlistEntryEntity, WaitlistOutboxEntity]);
    service = new WaitlistService(dataSource.getRepository(WaitlistEntryEntity), dataSource, config());
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  describe('join', () => {
    it('creates a waiting entry', async () => {
      const customerId = uuidv7();
      const professionalId = uuidv7();
      const entry = await service.join({ customerId, professionalId, serviceId: null });
      expect(entry.status).toBe('waiting');
      expect(entry.customerId).toBe(customerId);
    });

    it('rejects a duplicate ACTIVE join for the same (customer, professional, service)', async () => {
      // A non-null serviceId deliberately: pg-mem's index (synthesized from
      // the entity decorator, not the real COALESCE-expression migration)
      // treats two NULL serviceIds as distinct, so it cannot prove the
      // null-serviceId case -- see WaitlistEntryEntity's docblock. That
      // exact case is proven against real PostgreSQL instead
      // (waitlist-concurrency.pg-spec.ts), which is the authoritative
      // constraint here regardless.
      const customerId = uuidv7();
      const professionalId = uuidv7();
      const serviceId = uuidv7();
      await service.join({ customerId, professionalId, serviceId });
      await expect(service.join({ customerId, professionalId, serviceId })).rejects.toBeInstanceOf(
        AlreadyOnWaitlistException,
      );
    });

    it('allows joining again for a DIFFERENT service on the same professional', async () => {
      const customerId = uuidv7();
      const professionalId = uuidv7();
      const serviceA = uuidv7();
      const serviceB = uuidv7();
      await service.join({ customerId, professionalId, serviceId: serviceA });
      await expect(service.join({ customerId, professionalId, serviceId: serviceB })).resolves.toBeDefined();
    });

    it('allows re-joining after the previous entry left "waiting" (e.g. removed)', async () => {
      const customerId = uuidv7();
      const professionalId = uuidv7();
      const first = await service.join({ customerId, professionalId, serviceId: null });
      await service.remove(first.id, customerId);
      await expect(service.join({ customerId, professionalId, serviceId: null })).resolves.toBeDefined();
    });
  });

  describe('remove', () => {
    it('lets the customer leave while still waiting', async () => {
      const customerId = uuidv7();
      const entry = await service.join({ customerId, professionalId: uuidv7(), serviceId: null });
      expect(await service.remove(entry.id, customerId)).toBe(true);
    });

    it('refuses to remove someone else\'s entry', async () => {
      const entry = await service.join({ customerId: uuidv7(), professionalId: uuidv7(), serviceId: null });
      expect(await service.remove(entry.id, uuidv7())).toBe(false);
    });
  });

  describe('claimOfferForAcceptance -- the CAS WaitlistAcceptanceService relies on', () => {
    it('rejects a claim on an entry that was never offered anything', async () => {
      const customerId = uuidv7();
      const entry = await service.join({ customerId, professionalId: uuidv7(), serviceId: null });
      await dataSource.transaction(async (manager) => {
        await expect(service.claimOfferForAcceptance(entry.id, customerId, manager)).rejects.toBeInstanceOf(
          OfferNotAvailableException,
        );
      });
    });

    it('rejects a claim by someone other than the offered customer', async () => {
      const customerId = uuidv7();
      const entry = await service.join({ customerId, professionalId: uuidv7(), serviceId: null });
      await dataSource.getRepository(WaitlistEntryEntity).update(entry.id, {
        status: 'offered',
        offeredSlotId: uuidv7(),
        offerExpiresAt: new Date(Date.now() + 60_000),
      });
      await dataSource.transaction(async (manager) => {
        await expect(service.claimOfferForAcceptance(entry.id, uuidv7(), manager)).rejects.toBeInstanceOf(
          OfferNotAvailableException,
        );
      });
    });

    it('rejects a claim on an EXPIRED offer', async () => {
      const customerId = uuidv7();
      const entry = await service.join({ customerId, professionalId: uuidv7(), serviceId: null });
      await dataSource.getRepository(WaitlistEntryEntity).update(entry.id, {
        status: 'offered',
        offeredSlotId: uuidv7(),
        offerExpiresAt: new Date(Date.now() - 1000), // already in the past
      });
      await dataSource.transaction(async (manager) => {
        await expect(service.claimOfferForAcceptance(entry.id, customerId, manager)).rejects.toBeInstanceOf(
          OfferNotAvailableException,
        );
      });
    });

    it('moves a valid offer to accepted and is not re-enterable', async () => {
      const customerId = uuidv7();
      const slotId = uuidv7();
      const entry = await service.join({ customerId, professionalId: uuidv7(), serviceId: null });
      await dataSource.getRepository(WaitlistEntryEntity).update(entry.id, {
        status: 'offered',
        offeredSlotId: slotId,
        offerExpiresAt: new Date(Date.now() + 60_000),
      });

      await dataSource.transaction(async (manager) => {
        const claimed = await service.claimOfferForAcceptance(entry.id, customerId, manager);
        expect(claimed.status).toBe('accepted');
        // A second claim within the same flow must not succeed twice.
        await expect(service.claimOfferForAcceptance(entry.id, customerId, manager)).rejects.toBeInstanceOf(
          OfferNotAvailableException,
        );
      });
    });
  });

  // offerNextFor() is NOT unit-tested here: it uses FOR UPDATE SKIP LOCKED,
  // which pg-mem cannot parse at all ("AST which parts have not been read
  // by the query planner... skip locked" -- confirmed directly, not assumed
  // -- pg-mem's own README already documents it as work-in-progress). Real
  // PostgreSQL is the only layer that can prove this method correct, and it
  // does: waitlist-concurrency.pg-spec.ts covers earliest-first matching,
  // idempotent redelivery, and every service-eligibility combination
  // (any-service, generic-slot, and the non-matching case) against a real
  // server. See PHASE2-01 in the gap register for the same class of
  // pg-mem-cannot-prove-this limitation on FOR UPDATE-dependent code.

  describe('markMissed', () => {
    it('moves an offered entry to missed, a terminal state the matcher never re-offers', async () => {
      const entry = await service.join({ customerId: uuidv7(), professionalId: uuidv7(), serviceId: null });
      await dataSource.getRepository(WaitlistEntryEntity).update(entry.id, {
        status: 'offered',
        offeredSlotId: uuidv7(),
        offerExpiresAt: new Date(Date.now() + 60_000),
      });
      await service.markMissed(entry.id);
      const row = await service.findById(entry.id);
      expect(row?.status).toBe('missed');
    });
  });

  describe('expireStaleOffers', () => {
    it('expires an offer past its window and leaves a fresh one untouched', async () => {
      const stale = await service.join({ customerId: uuidv7(), professionalId: uuidv7(), serviceId: null });
      const fresh = await service.join({ customerId: uuidv7(), professionalId: uuidv7(), serviceId: null });
      const entries = dataSource.getRepository(WaitlistEntryEntity);
      await entries.update(stale.id, { status: 'offered', offeredSlotId: uuidv7(), offerExpiresAt: new Date(Date.now() - 1000) });
      await entries.update(fresh.id, { status: 'offered', offeredSlotId: uuidv7(), offerExpiresAt: new Date(Date.now() + 60_000) });

      const count = await service.expireStaleOffers();
      expect(count).toBe(1);
      expect((await service.findById(stale.id))?.status).toBe('expired');
      expect((await service.findById(fresh.id))?.status).toBe('offered');
    });
  });

  describe('reads', () => {
    it('listForProfessional returns only waiting/offered, in position order', async () => {
      const professionalId = uuidv7();
      const first = await service.join({ customerId: uuidv7(), professionalId, serviceId: null });
      const second = await service.join({ customerId: uuidv7(), professionalId, serviceId: null });
      const declined = await service.join({ customerId: uuidv7(), professionalId, serviceId: null });
      await dataSource.getRepository(WaitlistEntryEntity).update(declined.id, { status: 'declined' });

      const queue = await service.listForProfessional(professionalId);
      expect(queue.map((e) => e.id)).toEqual([first.id, second.id]);
    });
  });
});
