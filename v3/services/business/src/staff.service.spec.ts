import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { createInMemoryDataSource } from '@beauclick/testing';

import { BusinessEntity } from './entities/business.entity';
import { BusinessStaffEntity } from './entities/business-staff.entity';
import { BusinessOutboxEntity } from './entities/business-outbox.entity';
import { BusinessService } from './business.service';
import { StaffService } from './staff.service';
import { StaffInviteRejectedException, StaffMembershipNotFoundException } from './business.errors';

describe('StaffService (integration, pg-mem)', () => {
  let dataSource: DataSource;
  let businesses: BusinessService;
  let staff: StaffService;

  beforeEach(async () => {
    dataSource = await createInMemoryDataSource([BusinessEntity, BusinessStaffEntity, BusinessOutboxEntity]);
    businesses = new BusinessService(dataSource.getRepository(BusinessEntity), dataSource);
    staff = new StaffService(dataSource.getRepository(BusinessEntity), dataSource.getRepository(BusinessStaffEntity), dataSource);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  async function business() {
    const ownerId = uuidv7();
    const b = await businesses.create(ownerId, { displayName: 'Salon' });
    return { ownerId, businessId: b.id };
  }

  describe('roleFor -- the authorization primitive every resolver depends on', () => {
    it('resolves the owner to "owner" without any staff row existing', async () => {
      const { ownerId, businessId } = await business();
      expect(await staff.roleFor(businessId, ownerId)).toBe('owner');
    });

    it('resolves a stranger to null (cross-business denial)', async () => {
      const { businessId } = await business();
      expect(await staff.roleFor(businessId, uuidv7())).toBeNull();
    });

    it('resolves an invited-but-not-yet-accepted user to null -- an invite alone grants nothing', async () => {
      const { ownerId, businessId } = await business();
      const userId = uuidv7();
      await staff.invite(businessId, ownerId, { userId, role: 'staff' });
      expect(await staff.roleFor(businessId, userId)).toBeNull();
    });

    it('resolves an ACTIVE member to their real role', async () => {
      const { ownerId, businessId } = await business();
      const userId = uuidv7();
      const invited = await staff.invite(businessId, ownerId, { userId, role: 'manager' });
      await staff.accept(invited.id, userId);
      expect(await staff.roleFor(businessId, userId)).toBe('manager');
    });

    it('a staff member of Business A resolves to null for Business B (cross-business isolation)', async () => {
      const a = await business();
      const b = await business();
      const userId = uuidv7();
      const invited = await staff.invite(a.businessId, a.ownerId, { userId, role: 'staff' });
      await staff.accept(invited.id, userId);

      expect(await staff.roleFor(a.businessId, userId)).toBe('staff');
      expect(await staff.roleFor(b.businessId, userId)).toBeNull();
    });
  });

  describe('consent -- an owner cannot grant themselves a staff member\'s access', () => {
    it('accept() succeeds only for the INVITED user\'s own session', async () => {
      const { ownerId, businessId } = await business();
      const userId = uuidv7();
      const invited = await staff.invite(businessId, ownerId, { userId, role: 'staff' });

      // The owner (or anyone else) cannot accept on the invitee's behalf.
      await expect(staff.accept(invited.id, ownerId)).rejects.toBeInstanceOf(StaffMembershipNotFoundException);
      await expect(staff.accept(invited.id, uuidv7())).rejects.toBeInstanceOf(StaffMembershipNotFoundException);

      // Only the real invitee succeeds.
      const accepted = await staff.accept(invited.id, userId);
      expect(accepted.status).toBe('active');
    });

    it('rejects inviting yourself', async () => {
      const { ownerId, businessId } = await business();
      await expect(staff.invite(businessId, ownerId, { userId: ownerId, role: 'manager' })).rejects.toBeInstanceOf(
        StaffInviteRejectedException,
      );
    });

    it('rejects a second invite to an already-invited/active user (uq_business_staff_membership)', async () => {
      const { ownerId, businessId } = await business();
      const userId = uuidv7();
      await staff.invite(businessId, ownerId, { userId, role: 'staff' });
      await expect(staff.invite(businessId, ownerId, { userId, role: 'manager' })).rejects.toBeInstanceOf(
        StaffInviteRejectedException,
      );
    });

    it('accepting twice fails the second time (invited->active CAS, not re-enterable)', async () => {
      const { ownerId, businessId } = await business();
      const userId = uuidv7();
      const invited = await staff.invite(businessId, ownerId, { userId, role: 'staff' });
      await staff.accept(invited.id, userId);
      await expect(staff.accept(invited.id, userId)).rejects.toBeInstanceOf(StaffMembershipNotFoundException);
    });
  });

  describe('deactivate', () => {
    it('moves an active member to inactive, and roleFor then returns null', async () => {
      const { ownerId, businessId } = await business();
      const userId = uuidv7();
      const invited = await staff.invite(businessId, ownerId, { userId, role: 'staff' });
      await staff.accept(invited.id, userId);

      expect(await staff.deactivate(invited.id)).toBe(true);
      expect(await staff.roleFor(businessId, userId)).toBeNull();
    });

    it('is idempotent -- deactivating an already-inactive row reports false, not an error', async () => {
      const { ownerId, businessId } = await business();
      const userId = uuidv7();
      const invited = await staff.invite(businessId, ownerId, { userId, role: 'staff' });
      await staff.deactivate(invited.id);
      expect(await staff.deactivate(invited.id)).toBe(false);
    });
  });

  describe('activeBusinessForProfessional -- what financial party resolution depends on', () => {
    it('returns null for a professional with no business affiliation', async () => {
      expect(await staff.activeBusinessForProfessional(uuidv7())).toBeNull();
    });

    it('returns the business once the linked professional\'s invite is accepted, not before', async () => {
      const { ownerId, businessId } = await business();
      const userId = uuidv7();
      const professionalId = uuidv7();
      const invited = await staff.invite(businessId, ownerId, { userId, professionalId, role: 'staff' });

      expect(await staff.activeBusinessForProfessional(professionalId)).toBeNull();
      await staff.accept(invited.id, userId);
      expect(await staff.activeBusinessForProfessional(professionalId)).toBe(businessId);
    });
  });
});
