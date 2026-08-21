import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { createInMemoryDataSource } from '@beauclick/testing';
import { ProviderService, ProviderAlreadyExistsException } from './provider.service';
import { ProfessionalEntity } from './entities/professional.entity';
import { SpecialtyEntity } from './entities/specialty.entity';
import { CityEntity } from './entities/city.entity';
import { ProviderOutboxEntity } from './entities/provider-outbox.entity';
import { ProviderEventsService } from './provider-events.service';
import { createEventContractRegistry } from '@beauclick/event-contracts';

describe('ProviderService (integration, pg-mem)', () => {
  let dataSource: DataSource;
  let service: ProviderService;

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
      events,
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
