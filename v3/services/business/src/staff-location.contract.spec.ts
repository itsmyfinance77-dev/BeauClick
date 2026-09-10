import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { getMetadataArgsStorage } from 'typeorm';
import { OWNER_RESOLVER_KEY } from '@beauclick/ownership';
import { LOCATION_REFERENCE_DOMAIN, WORKSPACE_REFERENCE_DOMAIN } from '@beauclick/workspace-reference';

import { BusinessStaffEntity } from './entities/business-staff.entity';
import { SCOPED_STAFF_ROLES } from './entities/staff-role-grant.entity';
import { SetStaffLocationDto } from './dto/staff-location.dto';
import {
  AUDIT_TARGET_STAFF_LOCATION,
  STAFF_LOCATION_AUDIT_ACTIONS,
  STAFF_LOCATION_AUDIT_REASONS,
} from './staff-location.audit';
import { BusinessController } from './business.controller';
import { BusinessOwnerResolver } from './business-membership.resolver';

/**
 * V3.3 Story #127 (`#127a`) -- the closed contract, pinned.
 *
 * Everything here is a shape `V33-DEC-035` ratified and code must not widen on
 * its own: a caller-supplied location id, a professional-facing binding field, a
 * second scoped role, a new reference kind, a free-text audit reason, a
 * class-level ownership decorator. Each would be a silent security or privacy
 * change, so each has an assertion rather than a reviewer.
 *
 * The transactional, locking, snapshot and constraint behaviour lives in
 * `apps/api/test/delivery-location-context.pg-spec.ts` -- it needs a real server.
 */
describe('staff delivery-location contract (#127a)', () => {
  describe('the membership carries a branch and nothing more', () => {
    type EntityTarget = new (...args: never[]) => object;
    const columnsOf = (target: EntityTarget) =>
      getMetadataArgsStorage()
        .columns.filter((column) => column.target === target)
        .map((column) => column.propertyName)
        .sort();

    it('business_staff gains exactly one column: locationId', () => {
      expect(columnsOf(BusinessStaffEntity)).toContain('locationId');
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

    it('gains no second location, ordering or multi-branch column', () => {
      // `V33-DEC-035` R4: one membership carries at most ONE branch. A collection
      // or an ordering column is exactly how a first-row rule would creep in.
      for (const forbidden of [
        'locationIds',
        'locations',
        'primaryLocationId',
        'defaultLocationId',
        'locationOrder',
        'locationRank',
        'locationRef',
      ]) {
        expect(columnsOf(BusinessStaffEntity)).not.toContain(forbidden);
      }
    });

    it('the binding confers no authority -- SCOPED_STAFF_ROLES is byte-identical', () => {
      // A location says WHERE someone works, never WHAT they may do.
      expect([...SCOPED_STAFF_ROLES]).toEqual(['practitioner_chat']);
    });
  });

  describe('SetStaffLocationDto is one closed field', () => {
    const build = (payload: unknown) => plainToInstance(SetStaffLocationDto, payload);
    const REF = 'A'.repeat(43);

    it('accepts a well-formed reference and an explicit null', async () => {
      expect(await validate(build({ locationRef: REF }))).toHaveLength(0);
      expect(await validate(build({ locationRef: null }))).toHaveLength(0);
    });

    it('refuses a MISSING locationRef -- null is a value, absence is malformed', async () => {
      expect((await validate(build({}))).map((e) => e.property)).toContain('locationRef');
    });

    it.each([
      ['a raw uuid', '01930000-0000-7000-8000-000000000001'],
      ['too short', 'A'.repeat(42)],
      ['too long', 'A'.repeat(44)],
      ['a forbidden character', `${'A'.repeat(42)}+`],
      ['empty', ''],
    ])('refuses %s', async (_label, value) => {
      expect((await validate(build({ locationRef: value }))).map((e) => e.property)).toContain('locationRef');
    });

    it('declares exactly one property, so the whitelist pipe rejects everything else', () => {
      expect(Object.keys(build({ locationRef: null }))).toEqual(['locationRef']);
    });

    it.each([
      'businessId',
      'staffId',
      'locationId',
      'ownerId',
      'userId',
      'professionalId',
      'actorId',
      'lifecycle',
      'reason',
      'state',
      'workspaceRef',
      'resourceRef',
      'deliveryLocationId',
    ])('has no `%s` property to accept', (forbidden) => {
      expect(Object.getOwnPropertyNames(SetStaffLocationDto.prototype)).not.toContain(forbidden);
    });
  });

  describe('the audit vocabulary is closed and server-generated', () => {
    it('distinguishes assignment from clearing, with exactly two actions and reasons', () => {
      expect(Object.values(STAFF_LOCATION_AUDIT_ACTIONS)).toEqual([
        'business.staff_location_assigned',
        'business.staff_location_cleared',
      ]);
      expect(Object.values(STAFF_LOCATION_AUDIT_REASONS)).toEqual([
        'staff delivery location assigned by the business owner',
        'staff delivery location cleared by the business owner',
      ]);
      expect(AUDIT_TARGET_STAFF_LOCATION).toBe('business.staff_location');
    });

    it('the command DTO carries no `reason`, so no free text can reach the append-only log', () => {
      expect(Object.getOwnPropertyNames(SetStaffLocationDto.prototype)).not.toContain('reason');
    });
  });

  describe('both binding routes are owner-guarded at the HANDLER, never the class', () => {
    it.each(['readStaffLocation', 'setStaffLocation'] as const)(
      '%s carries handler-level @ResolveOwner(BusinessOwnerResolver)',
      (handler) => {
        const resolver = Reflect.getMetadata(
          OWNER_RESOLVER_KEY,
          BusinessController.prototype[handler] as (...args: never[]) => unknown,
        );
        expect(resolver).toBe(BusinessOwnerResolver);
      },
    );

    it('the CLASS carries no ownership metadata', () => {
      expect(Reflect.getMetadata(OWNER_RESOLVER_KEY, BusinessController)).toBeUndefined();
    });
  });

  describe('no new reference kind was created', () => {
    it('reuses locationRef unchanged -- the existing domains are byte-identical', () => {
      expect(LOCATION_REFERENCE_DOMAIN).toBe('beauclick.location-reference.v1');
      expect(WORKSPACE_REFERENCE_DOMAIN).toBe('beauclick.workspace-reference.v1');
    });

    it('the service derives a locationRef and never invents a fourth domain', () => {
      const source = readFileSync(join(__dirname, 'staff-location.service.ts'), 'utf8');
      expect(source).toContain('deriveLocationReference');
      expect(source).toContain('resolveLocationReference');
      for (const forbidden of ['REFERENCE_DOMAIN =', 'createHmac', 'staff-reference', 'membership-reference']) {
        expect(source).not.toContain(forbidden);
      }
    });
  });

  describe('the service mutates and audits on the caller’s EntityManager', () => {
    /*
     * A structural assertion, because the consequence is not observable from
     * outside -- the same reasoning `credit-purchase.pg-spec.ts` records for
     * `priceFor` and `#110a` records for its own audit path. An audit row written
     * on `this.dataSource.manager` commits on a second pooled connection and
     * would outlive a rolled-back binding change.
     */
    const source = readFileSync(join(__dirname, 'staff-location.service.ts'), 'utf8');
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

    it('the scan sees the real service', () => {
      expect(executable).toContain('export class StaffLocationService');
      expect(executable).toContain('this.audit.record(');
    });

    it('every audit.record call is handed the caller’s manager', () => {
      const calls = [...executable.matchAll(/this\.audit\.record\(\s*([A-Za-z.]+)/g)].map((m) => m[1]);
      expect(calls.length).toBeGreaterThan(0);
      for (const arg of calls) expect(arg).toBe('manager');
    });

    it('only the READ path uses the plain manager; the mutation opens one transaction', () => {
      expect(executable.match(/this\.dataSource\.manager/g) ?? []).toHaveLength(1);
      expect(executable).toMatch(/async read\([\s\S]*?this\.dataSource\.manager/);
      expect(executable.match(/this\.dataSource\.transaction/g) ?? []).toHaveLength(1);
    });

    it('locks the membership row it is about to rewrite', () => {
      // Without `FOR UPDATE OF s`, two concurrent rebindings would not serialise
      // and a slot creation could read a half-applied change.
      expect(executable).toContain('FOR UPDATE OF s');
    });

    it('compare-and-swaps on the observed value rather than writing blind', () => {
      expect(executable).toContain('location_id IS NOT DISTINCT FROM');
    });

    it('assigns only an ACTIVE location', () => {
      expect(executable).toContain("l.lifecycle = 'active'");
    });
  });

  describe('the migrations write no existing row and invent no location', () => {
    const migrations = [
      join(__dirname, '..', '..', '..', 'database', 'migrations', 'business', '20260914100001_add_staff_delivery_location.sql'),
      join(__dirname, '..', '..', '..', 'database', 'migrations', 'booking', '20260914200001_add_slot_delivery_location.sql'),
    ].map((path) => ({
      path,
      code: readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n'),
    }));

    const WRITES_EXISTING_ROWS =
      /\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+(business|booking)\.(locations|businesses|business_staff|availability_slots|bookings)\b/i;

    it('the scan sees both real migrations', () => {
      expect(migrations[0].code).toContain('ADD COLUMN location_id UUID');
      expect(migrations[1].code).toContain('ADD COLUMN delivery_location_id UUID');
    });

    it('neither contains an UPDATE, DELETE or INSERT against an existing table', () => {
      // A single stray `UPDATE business_staff SET …` would rewrite every row and
      // move every `xmin`, and no runtime assertion could see it afterwards.
      for (const migration of migrations) expect(WRITES_EXISTING_ROWS.test(migration.code)).toBe(false);
    });

    it('neither adds a NOT NULL, a DEFAULT or a cascade', () => {
      for (const migration of migrations) {
        expect(migration.code).not.toMatch(/ADD COLUMN\s+\w+\s+UUID\s+NOT NULL/i);
        expect(migration.code).not.toMatch(/ADD COLUMN\s+\w+\s+UUID\s+DEFAULT/i);
        expect(migration.code).not.toMatch(/ON\s+DELETE\s+CASCADE/i);
      }
    });

    it('the booking migration adds no cross-schema foreign key', () => {
      expect(migrations[1].code).not.toMatch(/REFERENCES\s+business\./i);
    });

    it('the scan is non-vacuous -- each forbidden shape is caught when planted', () => {
      expect(WRITES_EXISTING_ROWS.test('UPDATE business.business_staff SET location_id = x;')).toBe(true);
      expect(WRITES_EXISTING_ROWS.test('UPDATE booking.availability_slots SET delivery_location_id = x;')).toBe(true);
      expect(WRITES_EXISTING_ROWS.test('ALTER TABLE business.business_staff ADD COLUMN location_id UUID;')).toBe(false);
    });
  });
});
