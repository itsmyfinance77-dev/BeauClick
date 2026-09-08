import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { createInMemoryDataSource } from '@beauclick/testing';

import { BusinessEntity } from './entities/business.entity';
import { BusinessStaffEntity } from './entities/business-staff.entity';
import { BusinessOutboxEntity } from './entities/business-outbox.entity';
import { BusinessService } from './business.service';
import { StaffService } from './staff.service';
import { StaffMembershipNotFoundException } from './business.errors';
import { BusinessOwnerRoleGrantPort, StaffInviteIdentityResolverPort } from './ports';
import { StaffInviteClock } from './staff-invite.clock';
import { AdminAuditService } from '@beauclick/audit';

/**
 * `StaffService`'s cases need a business to attach staff to, and nothing more.
 * The owner-role port is a no-op here on purpose: `V33-DEC-021` Ruling 6 says a
 * staff affiliation grants NO global role, so a staff spec that exercised the
 * grant would be testing the wrong thing.
 */
const noOpOwnerRoles: BusinessOwnerRoleGrantPort = { grantBusinessOwnerRole: async () => true };

/**
 * The #109 collaborators, stubbed.
 *
 * `inviteByPhone` itself is proved in `apps/api/test/scoped-staff-authority.pg-spec.ts`:
 * it needs `admin.admin_audit_log` (which does not exist on this DataSource, and
 * whose append-only guarantee is a GRANT pg-mem cannot model), a real
 * `ON CONFLICT` and a real transaction. What this file still owns is everything
 * around it -- `roleFor`, the consent lifecycle and deactivation -- which needs
 * none of that.
 */
const noOpAudit = { record: async () => undefined } as unknown as AdminAuditService;
const noIdentities: StaffInviteIdentityResolverPort = { resolveInvitableIdentity: async () => null };
const instantClock: StaffInviteClock = { monotonicNowMs: () => 0, sleep: async () => undefined };

describe('StaffService (integration, pg-mem)', () => {
  let dataSource: DataSource;
  let businesses: BusinessService;
  let staff: StaffService;

  beforeEach(async () => {
    dataSource = await createInMemoryDataSource([BusinessEntity, BusinessStaffEntity, BusinessOutboxEntity]);
    businesses = new BusinessService(dataSource.getRepository(BusinessEntity), dataSource, noOpOwnerRoles);
    staff = new StaffService(
      dataSource.getRepository(BusinessEntity),
      dataSource.getRepository(BusinessStaffEntity),
      dataSource,
      noOpAudit,
      noIdentities,
      instantClock,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  async function business() {
    const ownerId = uuidv7();
    const b = await businesses.create(ownerId, { displayName: 'Salon' });
    return { ownerId, businessId: b.id };
  }

  /**
   * A membership at `invited`, written directly.
   *
   * V3.3 #109 (`#44c`) replaced the invitation contract with a phone-based one
   * that resolves identity server-side and discloses no membership id, so a spec
   * that needs a specific membership creates it. Consent is still exercised where
   * it matters: every case below moves `invited -> active` through `accept` from
   * the invitee's own id, exactly as production does.
   */
  async function seedMembership(
    businessId: string,
    userId: string,
    role: 'manager' | 'staff',
    invitedBy: string,
    professionalId: string | null = null,
  ): Promise<string> {
    const id = uuidv7();
    await dataSource.getRepository(BusinessStaffEntity).insert({
      id,
      businessId,
      userId,
      professionalId,
      role,
      status: 'invited',
      invitedBy,
      respondedAt: null,
    });
    return id;
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
      await seedMembership(businessId, userId, 'staff', ownerId);
      expect(await staff.roleFor(businessId, userId)).toBeNull();
    });

    it('resolves an ACTIVE member to their real role', async () => {
      const { ownerId, businessId } = await business();
      const userId = uuidv7();
      const invitedId = await seedMembership(businessId, userId, 'manager', ownerId);
      await staff.accept(invitedId, userId);
      expect(await staff.roleFor(businessId, userId)).toBe('manager');
    });

    it('a staff member of Business A resolves to null for Business B (cross-business isolation)', async () => {
      const a = await business();
      const b = await business();
      const userId = uuidv7();
      const invitedId = await seedMembership(a.businessId, userId, 'staff', a.ownerId);
      await staff.accept(invitedId, userId);

      expect(await staff.roleFor(a.businessId, userId)).toBe('staff');
      expect(await staff.roleFor(b.businessId, userId)).toBeNull();
    });
  });

  describe('consent -- an owner cannot grant themselves a staff member\'s access', () => {
    it('accept() succeeds only for the INVITED user\'s own session', async () => {
      const { ownerId, businessId } = await business();
      const userId = uuidv7();
      const invitedId = await seedMembership(businessId, userId, 'staff', ownerId);

      // The owner (or anyone else) cannot accept on the invitee's behalf.
      await expect(staff.accept(invitedId, ownerId)).rejects.toBeInstanceOf(StaffMembershipNotFoundException);
      await expect(staff.accept(invitedId, uuidv7())).rejects.toBeInstanceOf(StaffMembershipNotFoundException);

      // Only the real invitee succeeds.
      const accepted = await staff.accept(invitedId, userId);
      expect(accepted.status).toBe('active');
    });

    /*
     * V3.3 #109 (`#44c`) deleted the two cases that used to sit here --
     * "rejects inviting yourself" and "rejects a second invite" -- because the
     * behaviour they asserted was itself the defect. Both raised a DISTINCT
     * `409` (`StaffInviteRejectedException`, the second carrying the violated
     * constraint name), which let an owner submit an identity and read back
     * whether it existed and whether it was already affiliated.
     *
     * `V33-DEC-033` R3/R4 replaced all of it with one uniform `202 {}`: a
     * self-invite and a duplicate now write nothing and are externally
     * indistinguishable from a phone with no account. That is proved where it
     * can be proved honestly -- against a real database and over HTTP -- in
     * `apps/api/test/scoped-staff-authority.pg-spec.ts`.
     */

    it('accepting twice fails the second time (invited->active CAS, not re-enterable)', async () => {
      const { ownerId, businessId } = await business();
      const userId = uuidv7();
      const invitedId = await seedMembership(businessId, userId, 'staff', ownerId);
      await staff.accept(invitedId, userId);
      await expect(staff.accept(invitedId, userId)).rejects.toBeInstanceOf(StaffMembershipNotFoundException);
    });
  });

  describe('deactivate', () => {
    it('moves an active member to inactive, and roleFor then returns null', async () => {
      const { ownerId, businessId } = await business();
      const userId = uuidv7();
      const invitedId = await seedMembership(businessId, userId, 'staff', ownerId);
      await staff.accept(invitedId, userId);

      expect(await staff.deactivate(invitedId)).toBe(true);
      expect(await staff.roleFor(businessId, userId)).toBeNull();
    });

    it('is idempotent -- deactivating an already-inactive row reports false, not an error', async () => {
      const { ownerId, businessId } = await business();
      const userId = uuidv7();
      const invitedId = await seedMembership(businessId, userId, 'staff', ownerId);
      await staff.deactivate(invitedId);
      expect(await staff.deactivate(invitedId)).toBe(false);
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
      const invitedId = await seedMembership(businessId, userId, 'staff', ownerId, professionalId);

      expect(await staff.activeBusinessForProfessional(professionalId)).toBeNull();
      await staff.accept(invitedId, userId);
      expect(await staff.activeBusinessForProfessional(professionalId)).toBe(businessId);
    });
  });
});
