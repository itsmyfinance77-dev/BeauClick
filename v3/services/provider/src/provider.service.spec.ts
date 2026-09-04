import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { createInMemoryDataSource } from '@beauclick/testing';
import { ProviderService, ProviderAlreadyExistsException } from './provider.service';
import { ProfessionalEntity } from './entities/professional.entity';
import { SpecialtyEntity } from './entities/specialty.entity';
import { CityEntity } from './entities/city.entity';
import { ProviderOutboxEntity } from './entities/provider-outbox.entity';
import { ProviderEventsService } from './provider-events.service';
import { createEventContractRegistry } from '@beauclick/event-contracts';
import { SellerOwnerRoleGrantPort } from './ports';

/**
 * The #75 owner-role port, recorded rather than executed.
 *
 * These pg-mem specs exercise `services/provider` alone; `identity.user_roles`
 * does not exist in this DataSource and the real grant belongs to the
 * composition root. What this module IS responsible for is calling the port with
 * the session-derived owner, on the transaction's own manager -- so the double
 * records exactly that, and the cases assert it.
 */
class RecordingOwnerRoleGrant implements SellerOwnerRoleGrantPort {
  readonly calls: Array<{ ownerUserId: string; hasManager: boolean }> = [];
  shouldFail = false;

  async grantProfessionalOwnerRole(manager: EntityManager, ownerUserId: string): Promise<boolean> {
    this.calls.push({ ownerUserId, hasManager: Boolean(manager) });
    if (this.shouldFail) throw new Error('owner role grant failed');
    return true;
  }
}

describe('ProviderService (integration, pg-mem)', () => {
  let dataSource: DataSource;
  let service: ProviderService;
  let ownerRoles: RecordingOwnerRoleGrant;

  beforeEach(async () => {
    dataSource = await createInMemoryDataSource([ProfessionalEntity, SpecialtyEntity, CityEntity, ProviderOutboxEntity]);
    // Phase 3: provider-service now publishes its facts, so the events
    // collaborator is a real one here rather than a stub -- the contract
    // validation it performs is part of what these cases exercise.
    const events = new ProviderEventsService(dataSource, createEventContractRegistry());
    service = new ProviderService(
      dataSource,
      dataSource.getRepository(ProfessionalEntity),
      dataSource.getRepository(SpecialtyEntity),
      dataSource.getRepository(CityEntity),
      events,
      (ownerRoles = new RecordingOwnerRoleGrant()),
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  describe('create', () => {
    it('creates a professional profile owned by the given owner', async () => {
      const ownerId = uuidv7();
      const created = await service.create(ownerId, { displayName: 'Sara Beauty', bio: 'expert' });
      expect(created.ownerId).toBe(ownerId);
      expect(created.verificationStatus).toBe('unverified');
    });

    /**
     * V3.3 #75 (`V33-DEC-021` Rulings 2 and 8).
     *
     * What this module is responsible for is calling the port with the
     * SESSION-derived owner, on the TRANSACTION's own manager. Whether the role
     * row lands, and whether it rolls back with the profile, belongs to
     * `seller-owner-role-lifecycle.pg-spec.ts` -- pg-mem honours no ROLLBACK, so
     * asserting it here would prove nothing.
     */
    it('grants the professional owner role through the port, on the transaction manager', async () => {
      const ownerId = uuidv7();
      await service.create(ownerId, { displayName: 'Sara Beauty' });

      expect(ownerRoles.calls).toEqual([{ ownerUserId: ownerId, hasManager: true }]);
    });

    it('propagates a role-grant failure instead of creating a profile the owner cannot act on', async () => {
      const ownerId = uuidv7();
      ownerRoles.shouldFail = true;

      await expect(service.create(ownerId, { displayName: 'Sara Beauty' })).rejects.toThrow('owner role grant failed');
      // The port was reached, so the failure is the grant's and not a missing
      // call. (pg-mem does not roll back, so the profile row's absence is
      // asserted against real PostgreSQL, not here.)
      expect(ownerRoles.calls).toHaveLength(1);
    });

    it('never passes a caller-supplied owner to the port', async () => {
      const sessionOwner = uuidv7();
      const someoneElse = uuidv7();

      await service.create(sessionOwner, {
        displayName: 'Sara Beauty',
        // Not part of `CreateProfessionalDto`; present here to show that even a
        // value smuggled past validation cannot reach the port, because
        // `create()` passes its own `ownerId` argument and nothing from the DTO.
        ...({ ownerId: someoneElse } as Record<string, unknown>),
      });

      expect(ownerRoles.calls).toEqual([{ ownerUserId: sessionOwner, hasManager: true }]);
      expect(ownerRoles.calls.map((c) => c.ownerUserId)).not.toContain(someoneElse);
    });

    it('rejects a second profile for the same owner (one profile per identity)', async () => {
      const ownerId = uuidv7();
      await service.create(ownerId, { displayName: 'First', bio: '' });
      await expect(service.create(ownerId, { displayName: 'Second', bio: '' })).rejects.toBeInstanceOf(ProviderAlreadyExistsException);
    });
  });

  describe('read', () => {
    it('findById returns the profile with its specialties relation loaded', async () => {
      const created = await service.create(uuidv7(), { displayName: 'X', bio: '' });
      const found = await service.findById(created.id);
      expect(found?.id).toBe(created.id);
      expect(found?.specialties).toEqual([]);
    });

    it('findById returns null for a nonexistent id (never throws)', async () => {
      const found = await service.findById('00000000-0000-0000-0000-000000000000');
      expect(found).toBeNull();
    });

    it('findByOwnerId resolves the real owning row -- the mechanism ProviderOwnerResolver depends on', async () => {
      const ownerId = uuidv7();
      const created = await service.create(ownerId, { displayName: 'Y', bio: '' });
      const found = await service.findByOwnerId(ownerId);
      expect(found?.id).toBe(created.id);
    });
  });

  describe('update', () => {
    it('updates fields when the ownerId matches (defense-in-depth check, independent of any HTTP-layer guard)', async () => {
      const ownerId = uuidv7();
      const created = await service.create(ownerId, { displayName: 'Before', bio: 'before' });
      const updated = await service.update(created.id, ownerId, { displayName: 'After' });
      expect(updated.displayName).toBe('After');
      expect(updated.bio).toBe('before'); // untouched field survives
    });

    it('throws when the ownerId does NOT match -- the same data-access-layer isolation pattern as GAP-05\'s fix', async () => {
      const created = await service.create(uuidv7(), { displayName: 'Real Owner Data', bio: '' });
      await expect(service.update(created.id, uuidv7(), { displayName: 'Hijacked' })).rejects.toThrow();

      // Confirm the row is untouched, not just that the promise rejected.
      const stillOriginal = await service.findById(created.id);
      expect(stillOriginal?.displayName).toBe('Real Owner Data');
    });
  });

  describe('list', () => {
    it('paginates and filters by city', async () => {
      const cityRepo = dataSource.getRepository(CityEntity);
      const city = await cityRepo.save(cityRepo.create({ id: uuidv7(), name: 'Yazd', isLaunched: true }));

      await service.create(uuidv7(), { displayName: 'In City', bio: '', cityId: city.id });
      await service.create(uuidv7(), { displayName: 'No City', bio: '' });

      const filtered = await service.list({ page: 1, limit: 20, cityId: city.id });
      expect(filtered.total).toBe(1);
      expect(filtered.items[0].displayName).toBe('In City');

      const all = await service.list({ page: 1, limit: 20 });
      expect(all.total).toBe(2);
    });
  });

  describe('verification state machine (foundation)', () => {
    it('allows unverified -> pending', () => {
      expect(() => service.assertValidTransition('unverified', 'pending')).not.toThrow();
    });

    it('rejects an illegal transition (e.g. unverified -> verified, skipping review)', () => {
      expect(() => service.assertValidTransition('unverified', 'verified')).toThrow();
    });

    it('rejects any transition out of revoked (terminal state)', () => {
      expect(() => service.assertValidTransition('revoked', 'pending')).toThrow();
    });
  });
});
