import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { getMetadataArgsStorage } from 'typeorm';

import { BUSINESS_STAFF_ROLES, BUSINESS_STAFF_STATUSES, BusinessStaffEntity } from './entities/business-staff.entity';
import { SCOPED_STAFF_ROLES, StaffRoleGrantEntity } from './entities/staff-role-grant.entity';
import { InviteStaffByPhoneDto, ScopedStaffRoleDto } from './dto/staff.dto';
import {
  AUDIT_TARGET_STAFF_MEMBERSHIP,
  AUDIT_TARGET_STAFF_ROLE_GRANT,
  STAFF_AUTHORITY_AUDIT_ACTIONS,
  STAFF_AUTHORITY_AUDIT_REASONS,
} from './staff-authority.audit';

/**
 * V3.3 Story #109 (`#44c`) -- the closed contract, pinned.
 *
 * Everything here is a shape `V33-DEC-033` ratified and code must not widen on
 * its own: a second scoped role, `owner` as a grantable role, a wider
 * `business_staff.role`, a missing `removed`, a caller-supplied identity in an
 * invitation body, a free-text audit reason. Each would be a silent security
 * change, so each has an assertion rather than a reviewer.
 *
 * The transactional, concurrency, timing-distribution and database-integrity
 * behaviour lives in `apps/api/test/scoped-staff-authority.pg-spec.ts` -- it
 * needs a real server (ADR-049 section 2.4).
 */
describe('scoped staff authority contract (#109)', () => {
  describe('the closed scoped-role vocabulary', () => {
    it('is EXACTLY one member: practitioner_chat', () => {
      // `V33-DEC-033` R1. A second member is a register decision tied to a real
      // consumer; this assertion is what makes that true in practice.
      expect([...SCOPED_STAFF_ROLES]).toEqual(['practitioner_chat']);
    });

    it('does NOT contain `owner`, nor any deferred or dormant role', () => {
      for (const forbidden of [
        'owner',
        'location_viewer',
        'location_manager',
        'finance',
        'finance_read',
        'reception',
        'receptionist',
        'inventory',
        'b2b',
        'admin',
        'administrator',
        'manager',
        'staff',
      ]) {
        expect(SCOPED_STAFF_ROLES as readonly string[]).not.toContain(forbidden);
      }
    });
  });

  describe('the membership vocabularies', () => {
    it('business_staff.role is UNCHANGED at exactly manager | staff', () => {
      // `V33-DEC-033` R5 and ADR-049 section 4.1: new authority is a scoped
      // grant, never a wider role string.
      expect([...BUSINESS_STAFF_ROLES]).toEqual(['manager', 'staff']);
    });

    it('business_staff.status now includes `removed`, and is exactly the five ratified members', () => {
      expect([...BUSINESS_STAFF_STATUSES]).toEqual(['invited', 'active', 'inactive', 'declined', 'removed']);
    });

    it('the scoped-role and membership-role vocabularies share no member', () => {
      // They are different axes. A membership role says what you are to the
      // business; a scoped grant says what you may do. Conflating them is what
      // `V33-DEC-030` refused when it declined to widen `business_staff.role`.
      for (const role of SCOPED_STAFF_ROLES) {
        expect(BUSINESS_STAFF_ROLES as readonly string[]).not.toContain(role);
      }
    });
  });

  describe('InviteStaffByPhoneDto is closed, and carries no identity', () => {
    const build = (payload: unknown) => plainToInstance(InviteStaffByPhoneDto, payload);

    it('accepts exactly { phone, role }', async () => {
      expect(await validate(build({ phone: '09121234567', role: 'staff' }))).toHaveLength(0);
      expect(await validate(build({ phone: '+989121234567', role: 'manager' }))).toHaveLength(0);
    });

    it('refuses a missing phone, an empty phone and an over-long one', async () => {
      expect((await validate(build({ role: 'staff' }))).map((e) => e.property)).toContain('phone');
      expect((await validate(build({ phone: '', role: 'staff' }))).map((e) => e.property)).toContain('phone');
      expect((await validate(build({ phone: '9'.repeat(33), role: 'staff' }))).map((e) => e.property)).toContain('phone');
    });

    it('refuses a role outside the MEMBERSHIP vocabulary, including a scoped role', async () => {
      for (const rejected of ['owner', 'practitioner_chat', 'admin', '']) {
        expect((await validate(build({ phone: '09121234567', role: rejected }))).map((e) => e.property)).toContain('role');
      }
    });

    it('declares exactly two properties, so the whitelist pipe rejects everything else', () => {
      expect(Object.keys(build({ phone: '09121234567', role: 'staff' })).sort()).toEqual(['phone', 'role']);
    });

    it.each(['userId', 'professionalId', 'businessId', 'ownerId', 'actorId', 'invitedBy', 'workspaceRef', 'reason'])(
      'has no `%s` property to accept -- the UUID contract is gone, not shadowed',
      (forbidden) => {
        expect(Object.getOwnPropertyNames(InviteStaffByPhoneDto.prototype)).not.toContain(forbidden);
      },
    );
  });

  describe('ScopedStaffRoleDto is one closed literal', () => {
    const build = (payload: unknown) => plainToInstance(ScopedStaffRoleDto, payload);

    it('accepts the one vocabulary member and refuses everything else', async () => {
      expect(await validate(build({ role: 'practitioner_chat' }))).toHaveLength(0);
      for (const rejected of ['owner', 'manager', 'staff', 'location_manager', '', 'practitioner_chat ']) {
        expect((await validate(build({ role: rejected }))).map((e) => e.property)).toContain('role');
      }
    });

    it('declares exactly one property, and no identity of any kind', () => {
      expect(Object.keys(build({ role: 'practitioner_chat' }))).toEqual(['role']);
      for (const forbidden of ['userId', 'membershipId', 'staffId', 'businessId', 'professionalId', 'phone', 'reason']) {
        expect(Object.getOwnPropertyNames(ScopedStaffRoleDto.prototype)).not.toContain(forbidden);
      }
    });
  });

  describe('the grant table carries the right columns and no more', () => {
    type EntityTarget = new (...args: never[]) => object;
    const columnsOf = (target: EntityTarget) =>
      getMetadataArgsStorage()
        .columns.filter((column) => column.target === target)
        .map((column) => column.propertyName)
        .sort();

    it('staff_role_grants is exactly the ratified column set', () => {
      expect(columnsOf(StaffRoleGrantEntity)).toEqual([
        'businessId',
        'grantedAt',
        'grantedByUserId',
        'id',
        'membershipId',
        'revokedAt',
        'revokedByUserId',
        'role',
      ]);
    });

    it('is anchored on the MEMBERSHIP, never on a user id', () => {
      // ADR-049 section 4.2. A grant keyed on a user id could exist for someone
      // who never accepted an invitation, which is the hazard ADR-023 closed.
      const columns = columnsOf(StaffRoleGrantEntity);
      expect(columns).toContain('membershipId');
      expect(columns).not.toContain('userId');
      expect(columns).not.toContain('granteeUserId');
    });

    it('has NO practitioner, location, phone or owner scope column', () => {
      // `V33-DEC-033` R2: the persisted grant stays business-scoped and
      // practitioner identity is derived from the consent-bearing membership. No
      // third generic scope form.
      for (const forbidden of [
        'professionalId',
        'practitionerId',
        'locationId',
        'scopeKind',
        'scopeId',
        'phone',
        'phoneHash',
        'ownerId',
        'capability',
      ]) {
        expect(columnsOf(StaffRoleGrantEntity)).not.toContain(forbidden);
      }
    });

    it('names its actor columns so ADR-027 detection cannot be evaded', () => {
      // `coverage.ts` recognises the `*_user_id` suffix. Both actor columns use
      // it, so a wrong `no_subject_data` claim on this table fails at boot.
      for (const actor of ['grantedByUserId', 'revokedByUserId']) {
        expect(columnsOf(StaffRoleGrantEntity)).toContain(actor);
      }
    });

    it('declares the partial live-uniqueness index, not an unconditional one', () => {
      const index = getMetadataArgsStorage().indices.find(
        (candidate) => candidate.target === StaffRoleGrantEntity && candidate.name === 'uq_staff_role_grants_live',
      );
      expect(index).toBeDefined();
      expect(index?.unique).toBe(true);
      expect(index?.columns).toEqual(['membershipId', 'role', 'businessId']);
      // Without the predicate a revoked grant would occupy the slot for ever and
      // revoke-then-re-grant would be impossible.
      expect(String(index?.where)).toContain('revoked_at IS NULL');
    });

    it('business_staff carries exactly the ratified column set', () => {
      /*
       * Updated -- not loosened -- by V3.3 Story #127 (`#127a`).
       *
       * This assertion was written as "gains no new column from this story",
       * and it did its job: #127a's `locationId` failed it, which is precisely
       * how a column arriving on the consent-bearing membership table should be
       * noticed. `V33-DEC-035` R2 ratified that column, so the EXACT set moves by
       * exactly one member and stays exact -- a `toContain` or a filtered
       * comparison here would retire the guard rather than update it.
       *
       * What #109's rulings actually forbid is unchanged and still asserted
       * around this case: `role` remains `manager | staff`, `status` remains the
       * five ratified members, and `locationId` confers no authority -- it says
       * WHERE a member works, never WHAT they may do.
       */
      expect(columnsOf(BusinessStaffEntity)).toEqual([
        'businessId',
        'createdAt',
        'id',
        'invitedBy',
        'locationId',
        'professionalId',
        'respondedAt',
        'role',
        'status',
        'updatedAt',
        'userId',
      ]);
    });
  });

  describe('the audit vocabulary is closed and server-generated', () => {
    it('has exactly three actions and three reasons, and the two target types', () => {
      expect(Object.values(STAFF_AUTHORITY_AUDIT_ACTIONS)).toEqual([
        'business.staff_grant_granted',
        'business.staff_grant_revoked',
        'business.staff_invited',
      ]);
      expect(Object.values(STAFF_AUTHORITY_AUDIT_REASONS)).toEqual([
        'scoped staff role granted by the business owner',
        'scoped staff role revoked by the business owner',
        'business staff invitation created by the business owner',
      ]);
      expect(AUDIT_TARGET_STAFF_ROLE_GRANT).toBe('business.staff_grant');
      expect(AUDIT_TARGET_STAFF_MEMBERSHIP).toBe('business.staff_membership');
    });

    it('no command DTO carries a `reason`, so no free text can reach the append-only log', () => {
      for (const Dto of [InviteStaffByPhoneDto, ScopedStaffRoleDto]) {
        expect(Object.getOwnPropertyNames(Dto.prototype)).not.toContain('reason');
      }
    });
  });
});
