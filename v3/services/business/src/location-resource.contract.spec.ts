import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { getMetadataArgsStorage } from 'typeorm';
import { OWNER_RESOLVER_KEY } from '@beauclick/ownership';

import {
  LOCATION_RESOURCE_KINDS,
  LOCATION_RESOURCE_LIFECYCLES,
  LocationResourceEntity,
} from './entities/location-resource.entity';
import { BUSINESS_LOCATION_LIFECYCLES } from './entities/business-location.entity';
import { SCOPED_STAFF_ROLES } from './entities/staff-role-grant.entity';
import {
  CreateLocationResourceDto,
  EmptyLocationResourceCommandDto,
  ListLocationResourcesQueryDto,
  RenameLocationResourceDto,
} from './dto/location-resource.dto';
import {
  AUDIT_TARGET_LOCATION_RESOURCE,
  LOCATION_RESOURCE_AUDIT_ACTIONS,
  LOCATION_RESOURCE_AUDIT_REASONS,
} from './location-resource.audit';
import { LocationResourceController } from './location-resource.controller';
import { BusinessOwnerResolver } from './business-membership.resolver';

/**
 * V3.3 Story #110 (`#110a`) -- the closed contract, pinned.
 *
 * Everything here is a shape `V33-DEC-034` ratified and code must not widen on
 * its own: a fourth resource kind, a restore transition, a caller-supplied
 * lifecycle or reason, a class-level ownership decorator, a second scoped-staff
 * role. Each would be a silent security or product change, so each has an
 * assertion rather than a reviewer.
 *
 * The transactional, concurrency, constraint and integrity behaviour lives in
 * `apps/api/test/location-resources.pg-spec.ts` -- it needs a real server
 * (ADR-049 section 2.4).
 */
describe('location resource catalogue contract (#110a)', () => {
  describe('the closed kind vocabulary', () => {
    it('is EXACTLY room | device | station', () => {
      // `V33-DEC-034` R2. A fourth kind is a register decision tied to a real
      // consumer; this assertion is what makes that true in practice.
      expect([...LOCATION_RESOURCE_KINDS]).toEqual(['room', 'device', 'station']);
    });

    it('contains no `owner`, no furniture synonym and no speculative member', () => {
      for (const forbidden of [
        'owner',
        'chair',
        'bed',
        'couch',
        'desk',
        'service',
        'resource',
        'equipment',
        'staff',
        'manager',
        'inventory',
        'seat',
        '',
      ]) {
        expect(LOCATION_RESOURCE_KINDS as readonly string[]).not.toContain(forbidden);
      }
    });
  });

  describe('the closed lifecycle vocabulary', () => {
    it('is EXACTLY active | retired', () => {
      expect([...LOCATION_RESOURCE_LIFECYCLES]).toEqual(['active', 'retired']);
    });

    it('has no restore-shaped member, because `retired` is terminal', () => {
      // The owner's 2026-09-09 clarification: no restore/reactivate route,
      // service method or transition is authorized. A vocabulary member such as
      // `suspended` would imply one.
      for (const forbidden of ['suspended', 'restored', 'reactivated', 'archived', 'deleted', 'closed', 'inactive']) {
        expect(LOCATION_RESOURCE_LIFECYCLES as readonly string[]).not.toContain(forbidden);
      }
    });

    it('is DISTINCT from the location lifecycle -- two vocabularies, not one reused', () => {
      // A location is `active | suspended | closed`; a resource is
      // `active | retired`. Sharing a vocabulary would let a location transition
      // imply a resource one.
      expect([...LOCATION_RESOURCE_LIFECYCLES]).not.toEqual([...BUSINESS_LOCATION_LIFECYCLES]);
      expect(LOCATION_RESOURCE_LIFECYCLES as readonly string[]).not.toContain('suspended');
    });
  });

  describe('this story adds no scoped-staff role', () => {
    it('SCOPED_STAFF_ROLES carries no resource role -- exactly the #109 and #111 members', () => {
      // `V33-DEC-034` R3. Resource authority is owner-only; `practitioner_chat`
      // is not widened and no RESOURCE member is introduced. The second member
      // here, `finance_read`, is #111's (`V33-DEC-030` D4, ADR-049 section 5)
      // and authorizes nothing on this surface -- the pg suite proves a holder
      // is refused identically to a stranger.
      expect([...SCOPED_STAFF_ROLES]).toEqual(['practitioner_chat', 'finance_read']);
    });

    it('no resource-shaped role was smuggled into the scoped vocabulary', () => {
      for (const forbidden of ['resource_manager', 'location_manager', 'resource_admin', 'catalogue_manager']) {
        expect(SCOPED_STAFF_ROLES as readonly string[]).not.toContain(forbidden);
      }
    });
  });

  describe('CreateLocationResourceDto is closed and carries no identity', () => {
    const build = (payload: unknown) => plainToInstance(CreateLocationResourceDto, payload);

    it('accepts exactly { name, kind } for every vocabulary member', async () => {
      for (const kind of LOCATION_RESOURCE_KINDS) {
        expect(await validate(build({ name: 'اتاق ۱', kind }))).toHaveLength(0);
      }
    });

    it('refuses every kind outside the vocabulary', async () => {
      for (const rejected of ['owner', 'chair', 'bed', 'service', 'resource', 'ROOM', 'room ', '', 'unknown-kind']) {
        expect((await validate(build({ name: 'اتاق', kind: rejected }))).map((e) => e.property)).toContain('kind');
      }
    });

    it('refuses a missing, empty, whitespace-only or over-long name', async () => {
      expect((await validate(build({ kind: 'room' }))).map((e) => e.property)).toContain('name');
      expect((await validate(build({ name: '', kind: 'room' }))).map((e) => e.property)).toContain('name');
      expect((await validate(build({ name: '   ', kind: 'room' }))).map((e) => e.property)).toContain('name');
      expect((await validate(build({ name: 'x'.repeat(121), kind: 'room' }))).map((e) => e.property)).toContain('name');
    });

    it('trims the name before validation', () => {
      expect(build({ name: '  اتاق ۱  ', kind: 'room' }).name).toBe('اتاق ۱');
    });

    it('declares exactly two properties, so the whitelist pipe rejects everything else', () => {
      expect(Object.keys(build({ name: 'اتاق', kind: 'room' })).sort()).toEqual(['kind', 'name']);
    });

    it.each([
      'businessId',
      'locationId',
      'resourceId',
      'ownerId',
      'userId',
      'actorId',
      'lifecycle',
      'reason',
      'state',
      'workspaceRef',
      'locationRef',
      'resourceRef',
      'id',
    ])('has no `%s` property to accept', (forbidden) => {
      expect(Object.getOwnPropertyNames(CreateLocationResourceDto.prototype)).not.toContain(forbidden);
    });
  });

  describe('RenameLocationResourceDto accepts exactly a name', () => {
    const build = (payload: unknown) => plainToInstance(RenameLocationResourceDto, payload);

    it('accepts a name and nothing else', async () => {
      expect(await validate(build({ name: 'اتاق ۲' }))).toHaveLength(0);
      expect(Object.keys(build({ name: 'اتاق ۲' }))).toEqual(['name']);
    });

    it('does NOT accept a kind -- a room never becomes a device', () => {
      // Re-kinding would let a resource's identity drift underneath anything
      // that referenced it, which is exactly what #110b will do.
      expect(Object.getOwnPropertyNames(RenameLocationResourceDto.prototype)).not.toContain('kind');
    });

    it('does NOT accept a lifecycle -- retirement has its own route', () => {
      expect(Object.getOwnPropertyNames(RenameLocationResourceDto.prototype)).not.toContain('lifecycle');
    });
  });

  describe('the empty command and query DTOs exist so unknown fields are refused', () => {
    /*
     * These two assert the STRUCTURE, not `validate()`.
     *
     * `class-validator` refuses a class carrying no decorated property at all
     * ("an unknown value was passed to the validate function"), which is a
     * library quirk rather than a statement about the route: what actually
     * rejects an extra field is the global pipe's `forbidNonWhitelisted`, and
     * that is proved over real HTTP in
     * `apps/api/test/location-resources.pg-spec.ts`. `EmptyLocationCommandDto`
     * from #108 has exactly this shape for exactly this reason.
     */
    it('the retire command declares no property', () => {
      expect(Object.keys(plainToInstance(EmptyLocationResourceCommandDto, {}))).toEqual([]);
      for (const forbidden of ['reason', 'lifecycle', 'state', 'force', 'cascade']) {
        expect(Object.getOwnPropertyNames(EmptyLocationResourceCommandDto.prototype)).not.toContain(forbidden);
      }
    });

    it('the list query declares no property -- no filter, cursor or lifecycle selector', () => {
      expect(Object.keys(plainToInstance(ListLocationResourcesQueryDto, {}))).toEqual([]);
      for (const forbidden of ['lifecycle', 'kind', 'cursor', 'limit', 'businessId', 'locationId']) {
        expect(Object.getOwnPropertyNames(ListLocationResourcesQueryDto.prototype)).not.toContain(forbidden);
      }
    });
  });

  describe('the table carries the right columns and no more', () => {
    type EntityTarget = new (...args: never[]) => object;
    const columnsOf = (target: EntityTarget) =>
      getMetadataArgsStorage()
        .columns.filter((column) => column.target === target)
        .map((column) => column.propertyName)
        .sort();

    it('location_resources is exactly the ratified column set', () => {
      expect(columnsOf(LocationResourceEntity)).toEqual([
        'businessId',
        'createdAt',
        'id',
        'kind',
        'lifecycle',
        'locationId',
        'name',
        'updatedAt',
      ]);
    });

    it('carries NO owner, actor or user column', () => {
      // ADR-049 sections 7.2-7.4: actor identity lives in admin.admin_audit_log
      // and nowhere else. A stored actor here would also turn an organisational
      // fact into a subject-shaped row under ADR-027's column heuristic --
      // exactly what the `retained` claim says is absent.
      for (const forbidden of ['ownerId', 'ownerUserId', 'userId', 'actorId', 'createdBy', 'createdByUserId', 'updatedBy']) {
        expect(columnsOf(LocationResourceEntity)).not.toContain(forbidden);
      }
    });

    it('carries NO booking, occupancy, capacity or scheduling column', () => {
      // `V33-DEC-034` R6/R7: assignment and collision are #110b (#128), and no
      // customer-facing occupancy data exists here at all.
      for (const forbidden of [
        'bookingId',
        'occupied',
        'occupancy',
        'capacity',
        'availability',
        'schedule',
        'calendar',
        'slotId',
        'professionalId',
        'serviceId',
        'price',
        'priceToman',
      ]) {
        expect(columnsOf(LocationResourceEntity)).not.toContain(forbidden);
      }
    });

    it('carries both halves of the composite same-business key', () => {
      expect(columnsOf(LocationResourceEntity)).toContain('locationId');
      expect(columnsOf(LocationResourceEntity)).toContain('businessId');
    });

    it('declares NO application-level unique index -- two branches may both have a "Room 1"', () => {
      // `V33-DEC-034`: no binding decision requires name uniqueness, and similar
      // names may be distinct physical resources.
      const indices = getMetadataArgsStorage().indices.filter((i) => i.target === LocationResourceEntity);
      expect(indices.filter((i) => i.unique)).toEqual([]);
      const columns = getMetadataArgsStorage().columns.filter((c) => c.target === LocationResourceEntity);
      // And no `@Column({ unique: true })` either, which the migration would own.
      expect(columns.filter((c) => c.options?.unique)).toEqual([]);
    });
  });

  describe('the audit vocabulary is closed and server-generated', () => {
    it('has exactly three actions and three reasons, and one target type', () => {
      expect(Object.values(LOCATION_RESOURCE_AUDIT_ACTIONS)).toEqual([
        'business.location_resource_created',
        'business.location_resource_renamed',
        'business.location_resource_retired',
      ]);
      expect(Object.values(LOCATION_RESOURCE_AUDIT_REASONS)).toEqual([
        'location resource created by the business owner',
        'location resource renamed by the business owner',
        'location resource retired by the business owner',
      ]);
      expect(AUDIT_TARGET_LOCATION_RESOURCE).toBe('business.location_resource');
    });

    it('has NO restore action, because there is no restore', () => {
      const actions = Object.values(LOCATION_RESOURCE_AUDIT_ACTIONS) as string[];
      for (const forbidden of ['restored', 'reactivated', 'unretired', 'deleted']) {
        expect(actions.some((action) => action.includes(forbidden))).toBe(false);
      }
    });

    it('no command DTO carries a `reason`, so no free text can reach the append-only log', () => {
      for (const Dto of [CreateLocationResourceDto, RenameLocationResourceDto, EmptyLocationResourceCommandDto]) {
        expect(Object.getOwnPropertyNames(Dto.prototype)).not.toContain('reason');
      }
    });
  });

  describe('every write runs on the caller’s EntityManager', () => {
    /*
     * A structural assertion, because the consequence is not observable from
     * outside -- the same reasoning `credit-purchase.pg-spec.ts` records for
     * `priceFor`.
     *
     * An audit row written on `this.dataSource.manager` commits on a SECOND
     * pooled connection. Every runtime case still passes: the mutation succeeds
     * and the audit row exists, and when the audit throws, both are absent. The
     * defect only appears when the transaction rolls back AFTER a successful
     * audit write -- a window this service does not currently have, because the
     * audit is its last statement. Adding one statement after it would open the
     * window silently.
     *
     * So the shape a mutation would have to break is asserted instead: every
     * `audit.record` call threads the `manager` it was given, and the service
     * never reaches for `this.dataSource.manager` at all.
     */
    const source = readFileSync(join(__dirname, 'location-resource.service.ts'), 'utf8');
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

    it('the scan sees the real service', () => {
      expect(executable).toContain('export class LocationResourceService');
      expect(executable).toContain('this.audit.record(');
    });

    it('every audit.record call is handed the caller’s manager', () => {
      const calls = [...executable.matchAll(/this\.audit\.record\(\s*([A-Za-z.]+)/g)].map((m) => m[1]);
      expect(calls.length).toBeGreaterThan(0);
      for (const arg of calls) expect(arg).toBe('manager');
    });

    it('no MUTATION runs on the plain manager -- only the read path may', () => {
      /*
       * `this.dataSource.manager` appears exactly once, in `list`, and that is
       * correct: a read never writes, so it needs no transaction and no row
       * lock -- the same shape `BusinessLocationService.list` uses. Every
       * mutation instead opens `this.dataSource.transaction` and threads that
       * manager through, audit included.
       */
      expect(executable.match(/this\.dataSource\.manager/g) ?? []).toHaveLength(1);
      expect(executable).toMatch(/async list\([\s\S]*?this\.dataSource\.manager/);
      // Three mutations, three transactions.
      expect(executable.match(/this\.dataSource\.transaction/g) ?? []).toHaveLength(3);
    });

    it('the scan is non-vacuous -- the offending shape is caught when planted', () => {
      const planted = 'await this.audit.record(this.dataSource.manager, { actorUserId });';
      const args = [...planted.matchAll(/this\.audit\.record\(\s*([A-Za-z.]+)/g)].map((m) => m[1]);
      expect(args).toEqual(['this.dataSource.manager']);
      expect(planted).toContain('this.dataSource.manager');
    });
  });

  describe('the migration touches no existing row', () => {
    /*
     * The real-PostgreSQL suite proves that ADDING the uniqueness constraint
     * does not rewrite `business.locations` -- it drops and re-adds it in a
     * rolled-back transaction and compares `xmin`, with a control that shows a
     * genuine rewrite IS detected.
     *
     * What that cannot see is the migration doing something ELSE to those rows,
     * because the migration has already run by the time any test connects. A
     * single stray `UPDATE business.locations SET …` in the file would rewrite
     * every row, move every `xmin`, and no runtime assertion in this repository
     * would notice. So the file itself is the thing asserted.
     */
    const migration = readFileSync(
      join(__dirname, '..', '..', '..', 'database', 'migrations', 'business', '20260913100001_create_location_resources.sql'),
      'utf8',
    );

    /** Comments stripped: the file legitimately NAMES the statements it must not contain. */
    const executable = migration
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');

    const WRITES_EXISTING_ROWS = /\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+business\.(locations|businesses|business_staff)\b/i;

    it('the scan sees the real migration', () => {
      // Discovery: without this every refusal below could pass against an empty
      // string or a mis-resolved path.
      expect(executable).toContain('CREATE TABLE business.location_resources');
      expect(executable).toContain('uq_locations_id_business');
    });

    it('contains no UPDATE, DELETE or INSERT against an existing business table', () => {
      expect(WRITES_EXISTING_ROWS.test(executable)).toBe(false);
    });

    it('adds no cascade that could erase resource history', () => {
      expect(executable).not.toMatch(/ON\s+DELETE\s+CASCADE/i);
    });

    it('touches no booking or provider object -- those are #110b and #110c', () => {
      expect(executable).not.toMatch(/\bbooking\./i);
      expect(executable).not.toMatch(/\bprovider\./i);
    });

    it('the scan is non-vacuous -- each forbidden statement is caught when planted', () => {
      expect(WRITES_EXISTING_ROWS.test('UPDATE business.locations SET updated_at = now();')).toBe(true);
      expect(WRITES_EXISTING_ROWS.test('DELETE FROM business.locations WHERE id = 1;')).toBe(true);
      expect(WRITES_EXISTING_ROWS.test("INSERT INTO business.locations (id) VALUES ('x');")).toBe(true);
      // And it does not flag the migration's own legitimate statements.
      expect(WRITES_EXISTING_ROWS.test('CREATE TABLE business.location_resources (id UUID PRIMARY KEY);')).toBe(false);
      expect(WRITES_EXISTING_ROWS.test('ALTER TABLE business.locations ADD CONSTRAINT uq_locations_id_business UNIQUE (id, business_id);')).toBe(false);
    });
  });

  describe('every route is owner-guarded at the HANDLER, never the class', () => {
    const handlers = ['list', 'create', 'rename', 'retire'] as const;

    it.each(handlers)('%s carries handler-level @ResolveOwner(BusinessOwnerResolver)', (handler) => {
      const resolver = Reflect.getMetadata(
        OWNER_RESOLVER_KEY,
        LocationResourceController.prototype[handler] as (...args: never[]) => unknown,
      );
      expect(resolver).toBe(BusinessOwnerResolver);
    });

    it('the CLASS carries no ownership metadata', () => {
      // ADR-049 section 2.5: `OwnershipGuard` reflects handler metadata only, so
      // a class-level decorator would be silently ignored while reading as
      // protection. This story avoids the hazard by convention and does not
      // repair the guard.
      expect(Reflect.getMetadata(OWNER_RESOLVER_KEY, LocationResourceController)).toBeUndefined();
    });

    it('declares exactly four handlers -- and no restore or delete among them', () => {
      const declared = Object.getOwnPropertyNames(LocationResourceController.prototype).filter(
        (name) => name !== 'constructor',
      );
      expect(declared.sort()).toEqual(['create', 'list', 'rename', 'retire']);
      for (const forbidden of ['restore', 'reactivate', 'unretire', 'remove', 'delete', 'destroy']) {
        expect(declared).not.toContain(forbidden);
      }
    });

    it('the assertion is non-vacuous -- an undecorated method really does read as unguarded', () => {
      class Undecorated {
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        handler(): void {}
      }
      expect(Reflect.getMetadata(OWNER_RESOLVER_KEY, Undecorated.prototype.handler)).toBeUndefined();
    });
  });
});
