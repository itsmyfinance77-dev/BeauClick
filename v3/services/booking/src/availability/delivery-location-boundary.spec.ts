import 'reflect-metadata';

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { plainToInstance } from 'class-transformer';

import { BulkGenerateSlotsDto, CreateSlotDto } from '../dto/create-slot.dto';

/**
 * V3.3 Story #127 (`#127a`) -- the structural proofs that need no database.
 *
 * Three claims, and the second is the one the story turns on:
 *
 *  1. `booking` still crosses into `business` through a PORT, never an import or
 *     a raw cross-schema query -- this story is the first time `booking` has ever
 *     needed a `business` fact, so it is the first real test of that boundary;
 *  2. **the delivery location never leaves the server**. It is accepted from no
 *     DTO and appears in no response shape, and the assertions below are written
 *     so that spreading the entity into a response later FAILS rather than
 *     silently publishing it (`V33-DEC-035` R9);
 *  3. the snapshot is resolved once per command, inside the writing transaction.
 *
 * Every scan is paired with a planted-offender control, so a scan that has
 * quietly stopped matching anything fails instead of passing.
 */

const SRC = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/** Comments stripped: a docblock may legitimately name what the code must not do. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const bookingSources = walk(SRC)
  .map((path) => ({ path: relative(SRC, path).split(sep).join('/'), code: stripComments(readFileSync(path, 'utf8')) }))
  .filter((file) => !file.path.endsWith('.spec.ts'));

describe('delivery-location context — boundaries and non-exposure (#127a)', () => {
  it('the scan sees the real booking module', () => {
    expect(bookingSources.length).toBeGreaterThan(10);
    expect(bookingSources.map((f) => f.path)).toEqual(
      expect.arrayContaining(['availability/availability.service.ts', 'availability/availability.controller.ts', 'ports.ts']),
    );
  });

  describe('booking imports no business entity and issues no business query', () => {
    const FORBIDDEN_IMPORTS = ["'@beauclick/business'", '"@beauclick/business"', 'BusinessStaffEntity', 'BusinessLocationEntity', 'LocationResourceEntity'];
    const FOREIGN_SCHEMA_QUERY = /\b(from|join|into|update)\s+(business|identity|provider|commerce)\./i;

    it('no booking source imports `@beauclick/business` or names a business entity', () => {
      const offenders = bookingSources
        .map((file) => ({ path: file.path, hits: FORBIDDEN_IMPORTS.filter((t) => file.code.includes(t)) }))
        .filter((entry) => entry.hits.length > 0);
      expect(offenders).toEqual([]);
    });

    it('no booking source queries a schema it does not own', () => {
      const offenders = bookingSources.filter((file) => FOREIGN_SCHEMA_QUERY.test(file.code)).map((file) => file.path);
      expect(offenders).toEqual([]);
    });

    it('the delivery location arrives only through the declared port', () => {
      const service = bookingSources.find((f) => f.path === 'availability/availability.service.ts')!;
      expect(service.code).toContain('DELIVERY_LOCATION_DIRECTORY');
      expect(service.code).toContain('deliveryLocationFor');
    });

    it('the scans are non-vacuous', () => {
      expect(FOREIGN_SCHEMA_QUERY.test('await m.query(`SELECT 1 FROM business.business_staff`)')).toBe(true);
      expect(FORBIDDEN_IMPORTS.some((t) => "import { BusinessStaffEntity } from '@beauclick/business';".includes(t))).toBe(true);
      expect(FOREIGN_SCHEMA_QUERY.test('await m.query(`SELECT 1 FROM booking.availability_slots`)')).toBe(false);
    });
  });

  describe('the snapshot is never accepted from a caller', () => {
    it('CreateSlotDto accepts exactly the pre-#127a vocabulary', () => {
      const instance = plainToInstance(CreateSlotDto, { startAt: new Date(), endAt: new Date(), serviceId: undefined });
      expect(Object.keys(instance).sort()).toEqual(['endAt', 'serviceId', 'startAt']);
    });

    it('BulkGenerateSlotsDto accepts exactly the pre-#127a vocabulary', () => {
      const declared = Object.keys(
        plainToInstance(BulkGenerateSlotsDto, {
          weekdays: [1],
          timeStart: '09:00',
          timeEnd: '17:00',
          slotMinutes: 60,
          dateFrom: '2026-01-01',
          dateTo: '2026-01-02',
          serviceId: undefined,
        }),
      ).sort();
      expect(declared).toEqual(['dateFrom', 'dateTo', 'serviceId', 'slotMinutes', 'timeEnd', 'timeStart', 'weekdays']);
    });

    it.each([CreateSlotDto, BulkGenerateSlotsDto])('%p declares no location or resource selector', (Dto) => {
      for (const forbidden of [
        'locationId',
        'locationRef',
        'deliveryLocationId',
        'resourceId',
        'resourceRef',
        'businessId',
        'staffId',
        'ownerId',
      ]) {
        expect(Object.getOwnPropertyNames((Dto as new () => object).prototype)).not.toContain(forbidden);
      }
    });
  });

  describe('the snapshot never appears in a response shape', () => {
    const controller = () => bookingSources.find((f) => f.path === 'availability/availability.controller.ts')!;

    it('toSlotShape enumerates its fields explicitly and omits the snapshot', () => {
      const code = controller().code;
      const shape = code.slice(code.indexOf('function toSlotShape'), code.indexOf('}', code.indexOf('function toSlotShape')) + 1);
      expect(shape).toContain('professionalId');
      expect(shape).toContain('startAt');
      expect(shape).not.toContain('deliveryLocationId');
    });

    it('no controller spreads a slot entity into a response', () => {
      /*
       * The assertion that actually protects the future: `...slot` would publish
       * every column the entity ever gains, including this one and whatever #128
       * adds. Explicit field lists are what keep a new column private by default.
       */
      const offenders = bookingSources
        .filter((file) => file.path.endsWith('.controller.ts'))
        .filter((file) => /\.\.\.\s*(slot|s|entity|row)\b/.test(file.code))
        .map((file) => file.path);
      expect(offenders).toEqual([]);
    });

    it('no booking source outside the entity and service names the snapshot at all', () => {
      const allowed = new Set(['entities/availability-slot.entity.ts', 'availability/availability.service.ts', 'booking-subject-data.contract.ts']);
      const offenders = bookingSources
        .filter((file) => !allowed.has(file.path))
        .filter((file) => file.code.includes('deliveryLocationId') || file.code.includes('delivery_location_id'))
        .map((file) => file.path);
      expect(offenders).toEqual([]);
    });

    it('the spread scan is non-vacuous', () => {
      expect(/\.\.\.\s*(slot|s|entity|row)\b/.test('return { ...slot, id: slot.id };')).toBe(true);
      expect(/\.\.\.\s*(slot|s|entity|row)\b/.test('return { id: slot.id };')).toBe(false);
    });
  });

  describe('the snapshot is resolved once, inside the writing transaction', () => {
    const service = () => bookingSources.find((f) => f.path === 'availability/availability.service.ts')!.code;

    it('createSlot and bulkGenerate each open exactly one transaction', () => {
      expect(service().match(/this\.dataSource\.transaction/g) ?? []).toHaveLength(2);
    });

    it('the resolver is called exactly twice in the file — once per write command', () => {
      // Not once per candidate: a call inside the generation loop would be the
      // N+1 `bulkGenerate`'s own design notes exist to avoid, and would let one
      // submission straddle two branches.
      expect(service().match(/deliveryLocationFor\(/g) ?? []).toHaveLength(2);
    });

    it('the resolver is never called on the plain manager or a fresh connection', () => {
      expect(service()).not.toMatch(/deliveryLocationFor\(\s*this\.dataSource\.manager/);
      expect(service()).not.toMatch(/deliveryLocationFor\(\s*this\.slots/);
    });

    it('the read paths still use the injected repository — a read never writes', () => {
      expect(service()).toMatch(/async listForProfessional[\s\S]{0,400}this\.slots\.find/);
    });
  });
});
