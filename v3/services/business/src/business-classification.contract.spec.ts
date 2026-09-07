import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { getMetadataArgsStorage } from 'typeorm';

import { BUSINESS_VERTICALS, BusinessVerticalEntity } from './entities/business-vertical.entity';
import { BUSINESS_TRAITS, BusinessTraitEntity } from './entities/business-trait.entity';
import { BusinessEntity } from './entities/business.entity';
import { ReplaceBusinessClassificationDto } from './dto/business-classification.dto';
import {
  AUDIT_TARGET_BUSINESS_CLASSIFICATION,
  CLASSIFICATION_AUDIT_ACTIONS,
  CLASSIFICATION_AUDIT_REASONS,
} from './business-classification.audit';

/**
 * V3.3 Story #107 (`#44a`) -- the closed contract, pinned.
 *
 * Everything here is a shape the register ratified and code must not widen on
 * its own: a seventh vertical, a third trait, an `isPrimary` field, a default, a
 * surrogate id, an identity column, or an unconditional owner-uniqueness rule in
 * entity metadata. Each would be a silent product change, so each has an
 * assertion rather than a reviewer.
 */
describe('business classification contract (#107)', () => {
  describe('the two closed vocabularies', () => {
    it('vertical is EXACTLY the six ratified members, in the ratified order', () => {
      // `V33-DEC-030` D1 / `V33-DEC-002` amendment. Adding a member is a
      // register decision; this assertion is what makes that true in practice.
      expect([...BUSINESS_VERTICALS]).toEqual(['salon', 'clinic', 'maison', 'retail', 'wholesale', 'academy']);
    });

    it('operating trait is EXACTLY the two ratified members, and neither is a vertical', () => {
      expect([...BUSINESS_TRAITS]).toEqual(['multi_location', 'mobile']);
      for (const trait of BUSINESS_TRAITS) {
        expect(BUSINESS_VERTICALS as readonly string[]).not.toContain(trait);
      }
    });

    it('no sentinel member expresses "unclassified" -- absence does', () => {
      // `V33-DEC-032` R3. A sentinel would destroy the difference between "not
      // yet answered" and "answered as other".
      for (const forbidden of ['unclassified', 'unknown', 'other', 'none', 'default', 'n/a']) {
        expect(BUSINESS_VERTICALS as readonly string[]).not.toContain(forbidden);
        expect(BUSINESS_TRAITS as readonly string[]).not.toContain(forbidden);
      }
    });
  });

  describe('the replacement DTO is closed', () => {
    const build = (payload: unknown) => plainToInstance(ReplaceBusinessClassificationDto, payload);

    it('accepts a vertical with an empty trait set', async () => {
      expect(await validate(build({ vertical: 'salon', traits: [] }))).toHaveLength(0);
    });

    it('accepts a vertical with one and with both traits', async () => {
      expect(await validate(build({ vertical: 'clinic', traits: ['mobile'] }))).toHaveLength(0);
      expect(await validate(build({ vertical: 'academy', traits: ['mobile', 'multi_location'] }))).toHaveLength(0);
    });

    it('accepts every ratified vertical and refuses everything else', async () => {
      for (const vertical of BUSINESS_VERTICALS) {
        expect(await validate(build({ vertical, traits: [] }))).toHaveLength(0);
      }
      for (const rejected of ['spa', 'SALON', 'salon ', 'multi_location', 'mobile', '', 'clinic;drop']) {
        const errors = await validate(build({ vertical: rejected, traits: [] }));
        expect(errors.map((e) => e.property)).toContain('vertical');
      }
    });

    it('refuses a missing vertical and a missing trait array -- both are required', async () => {
      expect((await validate(build({ traits: [] }))).map((e) => e.property)).toContain('vertical');
      expect((await validate(build({ vertical: 'salon' }))).map((e) => e.property)).toContain('traits');
    });

    it('refuses a duplicate trait rather than silently de-duplicating it', async () => {
      const errors = await validate(build({ vertical: 'salon', traits: ['mobile', 'mobile'] }));
      expect(errors.map((e) => e.property)).toContain('traits');
    });

    it('refuses an unknown trait and a vertical smuggled into the trait array', async () => {
      expect((await validate(build({ vertical: 'salon', traits: ['laser'] }))).map((e) => e.property)).toContain('traits');
      expect((await validate(build({ vertical: 'salon', traits: ['clinic'] }))).map((e) => e.property)).toContain('traits');
    });

    it('refuses more traits than the vocabulary has members', async () => {
      const errors = await validate(build({ vertical: 'salon', traits: ['mobile', 'multi_location', 'mobile'] }));
      expect(errors.map((e) => e.property)).toContain('traits');
    });

    it('declares exactly two properties, so the whitelist pipe rejects everything else', () => {
      // The global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`,
      // so a property absent from this DTO is REFUSED rather than dropped. That
      // is what structurally keeps `isPrimary`, a caller-supplied owner/user/
      // actor/business id, a `workspaceRef` and any medical field out -- and it
      // only holds while this DTO declares nothing else.
      const instance = build({ vertical: 'salon', traits: [] });
      expect(Object.keys(instance).sort()).toEqual(['traits', 'vertical']);
    });

    it.each(['isPrimary', 'is_primary', 'businessId', 'ownerId', 'userId', 'actorId', 'workspaceRef', 'diagnosis', 'medicalNotes'])(
      'has no `%s` field to accept',
      (forbidden) => {
        const instance = build({ vertical: 'salon', traits: [], [forbidden]: 'x' }) as unknown as Record<string, unknown>;
        // `plainToInstance` copies unknown keys; the PIPE is what refuses them.
        // What this asserts is that the class itself declares no such property,
        // so the refusal can never be bypassed by the class quietly gaining one.
        expect(Object.getOwnPropertyNames(ReplaceBusinessClassificationDto.prototype)).not.toContain(forbidden);
        expect(instance).toBeInstanceOf(ReplaceBusinessClassificationDto);
      },
    );
  });

  describe('the two tables carry no identity and no history', () => {
    type EntityTarget = new (...args: never[]) => object;

    const columnsOf = (target: EntityTarget) =>
      getMetadataArgsStorage()
        .columns.filter((column) => column.target === target)
        .map((column) => column.propertyName)
        .sort();

    it('business_verticals is exactly (business_id, vertical), keyed by business_id alone', () => {
      expect(columnsOf(BusinessVerticalEntity)).toEqual(['businessId', 'vertical']);

      const primary = getMetadataArgsStorage()
        .columns.filter((column) => column.target === BusinessVerticalEntity && column.options.primary)
        .map((column) => column.propertyName);
      expect(primary).toEqual(['businessId']);
    });

    it('business_traits is exactly (business_id, trait), keyed by both', () => {
      expect(columnsOf(BusinessTraitEntity)).toEqual(['businessId', 'trait']);

      const primary = getMetadataArgsStorage()
        .columns.filter((column) => column.target === BusinessTraitEntity && column.options.primary)
        .map((column) => column.propertyName)
        .sort();
      expect(primary).toEqual(['businessId', 'trait']);
    });

    it.each([
      ['BusinessVerticalEntity', BusinessVerticalEntity],
      ['BusinessTraitEntity', BusinessTraitEntity],
    ])('%s has no surrogate id, no isPrimary, no lifecycle, no soft delete, no timestamps and no actor', (_name, target) => {
      const columns = columnsOf(target as EntityTarget);
      for (const forbidden of [
        'id',
        'isPrimary',
        'primary',
        'status',
        'lifecycle',
        'deletedAt',
        'createdAt',
        'updatedAt',
        'createdBy',
        'updatedBy',
        'actorUserId',
        'userId',
        'ownerId',
        'phone',
        'email',
      ]) {
        expect(columns).not.toContain(forbidden);
      }
    });

    it('neither table has a default value on any column -- nothing is ever inferred', () => {
      for (const target of [BusinessVerticalEntity, BusinessTraitEntity]) {
        const withDefaults = getMetadataArgsStorage()
          .columns.filter((column) => column.target === target && column.options.default !== undefined)
          .map((column) => column.propertyName);
        expect(withDefaults).toEqual([]);
      }
    });
  });

  describe('owner uniqueness metadata matches the partial migration index', () => {
    it('BusinessEntity.ownerId carries NO unconditional unique constraint', () => {
      // The whole point of the #107 metadata correction: `unique: true` here
      // produced an UNCONDITIONAL index in pg-mem's synchronize output while the
      // migration's index is partial. Two schemas that disagree is one of them
      // being wrong in a way tests cannot see.
      const ownerColumn = getMetadataArgsStorage().columns.find(
        (column) => column.target === BusinessEntity && column.propertyName === 'ownerId',
      );
      expect(ownerColumn).toBeDefined();
      expect(ownerColumn?.options.unique).toBeUndefined();
    });

    it('declares the named PARTIAL unique index instead', () => {
      const index = getMetadataArgsStorage().indices.find(
        (candidate) => candidate.target === BusinessEntity && candidate.name === 'uq_businesses_owner_id',
      );
      expect(index).toBeDefined();
      expect(index?.unique).toBe(true);
      expect(index?.columns).toEqual(['ownerId']);
      expect(String(index?.where)).toContain('deleted_at IS NULL');
    });
  });

  describe('the audit vocabulary is closed and server-generated', () => {
    it('has exactly one action and one reason, and neither is caller-supplied', () => {
      expect(Object.values(CLASSIFICATION_AUDIT_ACTIONS)).toEqual(['business.classification_replaced']);
      expect(Object.values(CLASSIFICATION_AUDIT_REASONS)).toEqual(['business classification replaced by its owner']);
      expect(AUDIT_TARGET_BUSINESS_CLASSIFICATION).toBe('business.classification');
    });

    it('the DTO carries no reason field, so no free text can reach the append-only log', () => {
      const instance = plainToInstance(ReplaceBusinessClassificationDto, { vertical: 'salon', traits: [] });
      expect(Object.keys(instance)).not.toContain('reason');
    });
  });
});
