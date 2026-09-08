import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { getMetadataArgsStorage } from 'typeorm';

import {
  BUSINESS_LOCATION_LIFECYCLES,
  BusinessLocationEntity,
} from './entities/business-location.entity';
import { CreateLocationDto, EmptyLocationCommandDto, RenameLocationDto } from './dto/location.dto';
import {
  AUDIT_TARGET_BUSINESS_LOCATION,
  LOCATION_AUDIT_ACTIONS,
  LOCATION_AUDIT_REASONS,
} from './business-location.audit';

/**
 * V3.3 Story #108 (`#44b`) -- the closed contract, pinned.
 *
 * Everything here is a shape ADR-049 section 3 ratified and code must not widen
 * on its own: a fourth lifecycle member, a body field beyond the two commands, a
 * `reason`, an identity column, a soft-delete column, an address or coordinate,
 * or a caller-supplied audit action. Each would be a silent product change, so
 * each has an assertion rather than a reviewer.
 *
 * The transactional, lock, concurrency and audit-rollback behaviour lives in
 * `apps/api/test/business-locations.pg-spec.ts` -- it needs a real server
 * (ADR-049 section 2.4).
 */
describe('business location contract (#108)', () => {
  describe('the closed lifecycle vocabulary', () => {
    it('is EXACTLY active | suspended | closed, in that order', () => {
      expect([...BUSINESS_LOCATION_LIFECYCLES]).toEqual(['active', 'suspended', 'closed']);
    });

    it('has no sentinel or fourth member', () => {
      for (const forbidden of ['inactive', 'deleted', 'archived', 'draft', 'pending', 'open', 'unknown', 'none']) {
        expect(BUSINESS_LOCATION_LIFECYCLES as readonly string[]).not.toContain(forbidden);
      }
    });
  });

  describe('CreateLocationDto is closed', () => {
    const build = (payload: unknown) => plainToInstance(CreateLocationDto, payload);
    const CITY = '018f4b1a-0000-7000-8000-0000000000bb';

    it('accepts exactly { name, cityId }', async () => {
      expect(await validate(build({ name: 'Tehran branch', cityId: CITY }))).toHaveLength(0);
    });

    it('trims the name before validating, and refuses a whitespace-only name', async () => {
      expect(build({ name: '  Trimmed  ', cityId: CITY }).name).toBe('Trimmed');
      expect((await validate(build({ name: '   ', cityId: CITY }))).map((e) => e.property)).toContain('name');
      expect((await validate(build({ name: '', cityId: CITY }))).map((e) => e.property)).toContain('name');
    });

    it('refuses a name longer than 120 characters', async () => {
      expect((await validate(build({ name: 'x'.repeat(121), cityId: CITY }))).map((e) => e.property)).toContain('name');
    });

    it('refuses a missing name and a missing cityId -- both are required', async () => {
      expect((await validate(build({ cityId: CITY }))).map((e) => e.property)).toContain('name');
      expect((await validate(build({ name: 'x' }))).map((e) => e.property)).toContain('cityId');
    });

    it('refuses a cityId that is not a uuid', async () => {
      expect((await validate(build({ name: 'x', cityId: 'not-a-uuid' }))).map((e) => e.property)).toContain('cityId');
    });

    it('declares exactly two properties, so the whitelist pipe rejects everything else', () => {
      expect(Object.keys(build({ name: 'x', cityId: CITY })).sort()).toEqual(['cityId', 'name']);
    });

    it.each(['businessId', 'ownerId', 'userId', 'actorId', 'workspaceRef', 'locationRef', 'lifecycle', 'reason', 'address', 'latitude'])(
      'has no `%s` property to accept',
      (forbidden) => {
        expect(Object.getOwnPropertyNames(CreateLocationDto.prototype)).not.toContain(forbidden);
      },
    );
  });

  describe('RenameLocationDto is closed', () => {
    const build = (payload: unknown) => plainToInstance(RenameLocationDto, payload);

    it('accepts exactly { name } and trims it', async () => {
      expect(await validate(build({ name: 'Renamed' }))).toHaveLength(0);
      expect(build({ name: '  Renamed  ' }).name).toBe('Renamed');
    });

    it('refuses a whitespace-only name and a missing name', async () => {
      expect((await validate(build({ name: '  ' }))).map((e) => e.property)).toContain('name');
      expect((await validate(build({}))).map((e) => e.property)).toContain('name');
    });

    it('declares exactly one property', () => {
      expect(Object.keys(build({ name: 'x' }))).toEqual(['name']);
    });

    it('has no cityId, lifecycle or reason property', () => {
      for (const forbidden of ['cityId', 'lifecycle', 'reason', 'locationRef']) {
        expect(Object.getOwnPropertyNames(RenameLocationDto.prototype)).not.toContain(forbidden);
      }
    });
  });

  describe('EmptyLocationCommandDto is genuinely empty', () => {
    it('has no own or prototype properties, so any body field is a 400', () => {
      const instance = plainToInstance(EmptyLocationCommandDto, { anything: 1 });
      expect(Object.getOwnPropertyNames(EmptyLocationCommandDto.prototype).filter((n) => n !== 'constructor')).toEqual([]);
      // `plainToInstance` copies unknown keys; the whitelist PIPE is what refuses
      // them. What this asserts is that the class declares nothing itself.
      expect(instance).toBeInstanceOf(EmptyLocationCommandDto);
    });
  });

  describe('the entity carries no identity, history or place detail column', () => {
    type EntityTarget = new (...args: never[]) => object;
    const columnsOf = (target: EntityTarget) =>
      getMetadataArgsStorage()
        .columns.filter((column) => column.target === target)
        .map((column) => column.propertyName)
        .sort();

    it('business.locations is exactly (id, businessId, name, cityId, lifecycle, createdAt, updatedAt)', () => {
      expect(columnsOf(BusinessLocationEntity)).toEqual([
        'businessId',
        'cityId',
        'createdAt',
        'id',
        'lifecycle',
        'name',
        'updatedAt',
      ]);
    });

    it('is keyed by `id` alone', () => {
      const primary = getMetadataArgsStorage()
        .columns.filter((column) => column.target === BusinessLocationEntity && column.options.primary)
        .map((column) => column.propertyName);
      expect(primary).toEqual(['id']);
    });

    it('has no identity column, no soft delete, no public flag and no address or coordinate', () => {
      const columns = columnsOf(BusinessLocationEntity);
      for (const forbidden of [
        'ownerId',
        'ownerUserId',
        'userId',
        'actorUserId',
        'createdBy',
        'updatedBy',
        'createdByUserId',
        'phone',
        'email',
        'deletedAt',
        'isPublic',
        'public',
        'searchText',
        'address',
        'addressLine',
        'latitude',
        'longitude',
        'coordinates',
        'provinceId',
        'districtId',
        'neighbourhoodId',
        'medicalLicense',
      ]) {
        expect(columns).not.toContain(forbidden);
      }
    });

    it('no column ends `_by` or `_user_id` -- the subject-data heuristic would flag it', () => {
      for (const column of columnsOf(BusinessLocationEntity)) {
        expect(column).not.toMatch(/By$|UserId$/);
      }
    });
  });

  describe('the audit vocabulary is closed and server-generated', () => {
    it('has exactly the five actions and five reasons, and the target type', () => {
      expect(Object.values(LOCATION_AUDIT_ACTIONS)).toEqual([
        'business.location_created',
        'business.location_renamed',
        'business.location_suspended',
        'business.location_reactivated',
        'business.location_closed',
      ]);
      expect(Object.values(LOCATION_AUDIT_REASONS)).toEqual([
        'business location created by its owner',
        'business location renamed by its owner',
        'business location suspended by its owner',
        'business location reactivated by its owner',
        'business location closed by its owner',
      ]);
      expect(AUDIT_TARGET_BUSINESS_LOCATION).toBe('business.location');
    });

    it('no command DTO carries a `reason` field, so no free text can reach the append-only log', () => {
      for (const Dto of [CreateLocationDto, RenameLocationDto, EmptyLocationCommandDto]) {
        expect(Object.getOwnPropertyNames(Dto.prototype)).not.toContain('reason');
      }
    });
  });
});
