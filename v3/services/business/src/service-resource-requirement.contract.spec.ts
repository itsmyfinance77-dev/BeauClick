import 'reflect-metadata';

import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { getMetadataArgsStorage } from 'typeorm';
import { OWNER_RESOLVER_KEY } from '@beauclick/ownership';

import { REQUIRED_RESOURCE_KINDS, ServiceResourceRequirementEntity } from './entities/service-resource-requirement.entity';
import { LOCATION_RESOURCE_KINDS } from './entities/location-resource.entity';
import { ReadServiceResourceRequirementQueryDto, SetServiceResourceRequirementDto } from './dto/service-resource-requirement.dto';
import {
  AUDIT_TARGET_SERVICE_RESOURCE_REQUIREMENT,
  SERVICE_RESOURCE_REQUIREMENT_AUDIT_ACTIONS,
  SERVICE_RESOURCE_REQUIREMENT_AUDIT_REASONS,
} from './service-resource-requirement.audit';
import { ServiceResourceRequirementController } from './service-resource-requirement.controller';
import { BusinessOwnerResolver } from './business-membership.resolver';
import { SERVICE_OWNERSHIP_DIRECTORY } from './ports';

/**
 * V3.3 Story #131 (`#127b`) -- the closed contract, pinned.
 *
 * Everything here is a shape `V33-DEC-035` ratified and code must not widen on
 * its own: a second vocabulary, requirement versioning, a caller-supplied
 * business/service/owner selector, a class-level ownership decorator, a new
 * scoped-staff role. Each would be a silent security or product change, so
 * each has an assertion rather than a reviewer.
 *
 * The transactional, concurrency, constraint and integrity behaviour lives in
 * `apps/api/test/service-resource-requirements.pg-spec.ts` -- it needs a real
 * server (ADR-049 section 2.4).
 */
describe('service resource requirement contract (#131 / #127b)', () => {
  describe('the required-kind vocabulary is NOT a second one', () => {
    it('is byte-identical, by reference, to the #110a location-resource vocabulary', () => {
      expect(REQUIRED_RESOURCE_KINDS).toBe(LOCATION_RESOURCE_KINDS);
      expect([...REQUIRED_RESOURCE_KINDS]).toEqual(['room', 'device', 'station']);
    });
  });

  describe('the entity', () => {
    it('declares exactly the ratified columns -- no lifecycle, no version, no owner/actor column', () => {
      const columns = getMetadataArgsStorage()
        .filterColumns(ServiceResourceRequirementEntity)
        .map((c) => c.propertyName)
        .sort();
      expect(columns).toEqual(['businessId', 'createdAt', 'id', 'requiredKind', 'serviceId', 'updatedAt']);
      for (const forbidden of ['lifecycle', 'version', 'ownerId', 'actorId', 'userId', 'createdBy', 'updatedBy', 'deletedAt', 'quantity', 'resourceRef']) {
        expect(columns).not.toContain(forbidden);
      }
    });

    it('is named service_resource_requirements', () => {
      const table = getMetadataArgsStorage().tables.find((t) => t.target === ServiceResourceRequirementEntity);
      expect(table?.name).toBe('service_resource_requirements');
    });
  });

  describe('the write DTO', () => {
    it('accepts a valid vocabulary member', async () => {
      for (const kind of REQUIRED_RESOURCE_KINDS) {
        const instance = plainToInstance(SetServiceResourceRequirementDto, { requiredKind: kind });
        expect(await validate(instance)).toHaveLength(0);
      }
    });

    it('accepts null -- clearing is a real value, not a missing one', async () => {
      const instance = plainToInstance(SetServiceResourceRequirementDto, { requiredKind: null });
      expect(await validate(instance)).toHaveLength(0);
    });

    it('rejects an unknown kind', async () => {
      const instance = plainToInstance(SetServiceResourceRequirementDto, { requiredKind: 'chair' });
      expect(await validate(instance)).not.toHaveLength(0);
    });

    it('rejects a missing field -- distinct from an explicit null', async () => {
      const instance = plainToInstance(SetServiceResourceRequirementDto, {});
      expect(await validate(instance)).not.toHaveLength(0);
    });

    it('declares exactly one property -- no businessId, serviceId, ownerId or reason can ever reach it', () => {
      const instance = plainToInstance(SetServiceResourceRequirementDto, { requiredKind: 'room' });
      expect(Object.keys(instance)).toEqual(['requiredKind']);
    });

    it('the read query DTO declares no property, so the whitelist pipe rejects any query parameter', () => {
      expect(Object.keys(plainToInstance(ReadServiceResourceRequirementQueryDto, {}))).toEqual([]);
      expect(Object.getOwnPropertyNames(ReadServiceResourceRequirementQueryDto.prototype)).not.toContain('lifecycle');
    });
  });

  describe('the audit vocabulary', () => {
    it('is exactly set | changed | cleared', () => {
      expect(Object.values(SERVICE_RESOURCE_REQUIREMENT_AUDIT_ACTIONS).sort()).toEqual(
        [
          'business.service_resource_requirement_set',
          'business.service_resource_requirement_changed',
          'business.service_resource_requirement_cleared',
        ].sort(),
      );
    });

    it('every action has a matching closed reason, and none is empty', () => {
      for (const reason of Object.values(SERVICE_RESOURCE_REQUIREMENT_AUDIT_REASONS)) {
        expect(typeof reason).toBe('string');
        expect(reason.length).toBeGreaterThan(0);
      }
    });

    it('the target type names this table, not a shared or generic one', () => {
      expect(AUDIT_TARGET_SERVICE_RESOURCE_REQUIREMENT).toBe('business.service_resource_requirement');
    });
  });

  describe('the controller', () => {
    it('declares exactly two handlers -- read and set, no restore/delete route', () => {
      const declared = Object.getOwnPropertyNames(ServiceResourceRequirementController.prototype).filter(
        (name) => name !== 'constructor',
      );
      expect(declared.sort()).toEqual(['read', 'set']);
    });

    it('both handlers carry BusinessOwnerResolver -- owner-only, no scoped-staff role', () => {
      for (const handler of ['read', 'set'] as const) {
        const resolver = Reflect.getMetadata(
          OWNER_RESOLVER_KEY,
          ServiceResourceRequirementController.prototype[handler] as (...args: never[]) => unknown,
        );
        expect(resolver).toBe(BusinessOwnerResolver);
      }
    });

    it('the CLASS carries no ownership metadata -- OwnershipGuard reads handler metadata only', () => {
      expect(Reflect.getMetadata(OWNER_RESOLVER_KEY, ServiceResourceRequirementController)).toBeUndefined();
    });
  });

  describe('SERVICE_OWNERSHIP_DIRECTORY is declared and unbound by default', () => {
    it('is a distinct symbol from every other business port token', () => {
      expect(typeof SERVICE_OWNERSHIP_DIRECTORY).toBe('symbol');
      expect(SERVICE_OWNERSHIP_DIRECTORY.toString()).toContain('SERVICE_OWNERSHIP_DIRECTORY');
    });
  });
});
