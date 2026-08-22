import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { createInMemoryDataSource } from '@beauclick/testing';

import { BusinessEntity } from './entities/business.entity';
import { BusinessStaffEntity } from './entities/business-staff.entity';
import { BusinessOutboxEntity } from './entities/business-outbox.entity';
import { BusinessService } from './business.service';
import { BusinessAlreadyExistsException } from './business.errors';

describe('BusinessService (integration, pg-mem)', () => {
  let dataSource: DataSource;
  let service: BusinessService;

  beforeEach(async () => {
    dataSource = await createInMemoryDataSource([BusinessEntity, BusinessStaffEntity, BusinessOutboxEntity]);
    service = new BusinessService(dataSource.getRepository(BusinessEntity), dataSource);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  describe('create', () => {
    it('creates a business owned by the given user, self-service (no capability/role check)', async () => {
      const ownerId = uuidv7();
      const created = await service.create(ownerId, { displayName: 'Salon Sara' });
      expect(created.ownerId).toBe(ownerId);
      expect(created.verificationStatus).toBe('unverified');
    });

    it('rejects a second business for the same owner -- exactly ProfessionalEntity.ownerId\'s uniqueness discipline', async () => {
      const ownerId = uuidv7();
      await service.create(ownerId, { displayName: 'First' });
      await expect(service.create(ownerId, { displayName: 'Second' })).rejects.toBeInstanceOf(BusinessAlreadyExistsException);
    });
  });

  describe('update', () => {
    it('updates fields and bumps revision', async () => {
      const ownerId = uuidv7();
      const created = await service.create(ownerId, { displayName: 'Before' });
      const updated = await service.update(created.id, { displayName: 'After' });
      expect(updated.displayName).toBe('After');
      expect(Number(updated.revision)).toBeGreaterThan(Number(created.revision));
    });
  });

  describe('reads', () => {
    it('findByOwner resolves the real owning row', async () => {
      const ownerId = uuidv7();
      const created = await service.create(ownerId, { displayName: 'X' });
      const found = await service.findByOwner(ownerId);
      expect(found?.id).toBe(created.id);
    });

    it('findByOwner returns null for a user with no business', async () => {
      expect(await service.findByOwner(uuidv7())).toBeNull();
    });
  });
});
