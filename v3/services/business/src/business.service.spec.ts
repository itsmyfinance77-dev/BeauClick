import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { createInMemoryDataSource } from '@beauclick/testing';

import { BusinessEntity } from './entities/business.entity';
import { BusinessStaffEntity } from './entities/business-staff.entity';
import { BusinessOutboxEntity } from './entities/business-outbox.entity';
import { BusinessService } from './business.service';
import { BusinessAlreadyExistsException } from './business.errors';
import { BusinessOwnerRoleGrantPort } from './ports';


/**
 * The #75 owner-role port, recorded rather than executed.
 *
 * These pg-mem specs exercise `services/business` alone; `identity.user_roles`
 * does not exist in this DataSource and the real grant belongs to the
 * composition root. What this module IS responsible for is calling the port with
 * the session-derived owner, on the transaction's own manager -- so the double
 * records exactly that, and the cases assert it.
 */
class RecordingOwnerRoleGrant implements BusinessOwnerRoleGrantPort {
  readonly calls: Array<{ ownerUserId: string; hasManager: boolean }> = [];
  shouldFail = false;

  async grantBusinessOwnerRole(manager: EntityManager, ownerUserId: string): Promise<boolean> {
    this.calls.push({ ownerUserId, hasManager: Boolean(manager) });
    if (this.shouldFail) throw new Error('owner role grant failed');
    return true;
  }
}

describe('BusinessService (integration, pg-mem)', () => {
  let dataSource: DataSource;
  let service: BusinessService;
  let ownerRoles: RecordingOwnerRoleGrant;

  beforeEach(async () => {
    dataSource = await createInMemoryDataSource([BusinessEntity, BusinessStaffEntity, BusinessOutboxEntity]);
    ownerRoles = new RecordingOwnerRoleGrant();
    service = new BusinessService(dataSource.getRepository(BusinessEntity), dataSource, ownerRoles);
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

    /**
     * V3.3 #75 (`V33-DEC-021` Rulings 3 and 8).
     *
     * The port is called with the SESSION-derived owner on the transaction's own
     * manager, and with nothing else -- there is no argument that could carry a
     * role slug, an affiliation, or another user's id.
     */
    it('grants the business owner role through the port, on the transaction manager', async () => {
      const ownerId = uuidv7();
      await service.create(ownerId, { displayName: 'Salon Sara' });

      expect(ownerRoles.calls).toEqual([{ ownerUserId: ownerId, hasManager: true }]);
    });

    it('propagates a role-grant failure instead of creating a business the owner cannot act on', async () => {
      const ownerId = uuidv7();
      ownerRoles.shouldFail = true;

      await expect(service.create(ownerId, { displayName: 'Salon Sara' })).rejects.toThrow('owner role grant failed');
      expect(ownerRoles.calls).toHaveLength(1);
    });

    it('consults no staff affiliation when granting: the port receives the owner and nothing else', async () => {
      const ownerId = uuidv7();
      const employee = uuidv7();
      const business = await service.create(ownerId, { displayName: 'Salon Sara' });

      // An active staff row exists and changes nothing about the grant --
      // `V33-DEC-021` Ruling 6. The port's shape cannot express an affiliation,
      // so this is a property of the signature and not of this method's care.
      await dataSource.getRepository(BusinessStaffEntity).insert({
        id: uuidv7(),
        businessId: business.id,
        userId: employee,
        professionalId: null,
        role: 'manager',
        status: 'active',
        invitedBy: ownerId,
        respondedAt: new Date(),
      });

      expect(ownerRoles.calls).toEqual([{ ownerUserId: ownerId, hasManager: true }]);
      expect(ownerRoles.calls.map((c) => c.ownerUserId)).not.toContain(employee);
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
