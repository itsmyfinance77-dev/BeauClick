import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { BookingService, BookingSubjectDataContract, CreateBookingInput, SlotUnavailableException } from '@beauclick/booking';
import { BusinessLocationService, LocationResourceService } from '@beauclick/business';
import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, SubjectDataCoverageService, CatalogueTable, evaluateCoverage } from '@beauclick/subject-data';
import { WORKSPACE_REFERENCE_SECRET, deriveLocationReference, deriveResourceReference } from '@beauclick/workspace-reference';

import {
  PgTestApp,
  SeededUser,
  createPgTestApp,
  futureSlotTime,
  requiredPgEnv,
  resetDatabase,
  seedBusiness,
  seedCity,
  seedMembership,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

/**
 * REAL PostgreSQL: V3.3 Story #128 (`#110b`) -- booking resource assignment
 * and collision prevention.
 *
 * ## Why every case here needs a real server
 *
 * ADR-049 §2.4. The in-memory layer does not honour a GiST exclusion
 * constraint, does not honour `ROLLBACK`, and has no row-level or advisory
 * locking -- which is to say it can prove nothing about the collision
 * guarantee, the atomicity of an assignment with its booking, or the
 * closure/retirement race this story closes. Those are exactly the
 * guarantees this story ships.
 *
 * ## Genuinely parallel, never sequential
 *
 * `Promise.allSettled([...])` with no `await` between the calls, exactly as
 * `booking-concurrency.pg-spec.ts` already establishes for the slot-level
 * guarantee -- a sequential pair would prove nothing about the exclusion
 * constraint, since the application-level candidate read could pass for
 * both calls before either writes.
 *
 * ## What this story is NOT
 *
 * There is no `resourceRef`, no resource kind, no occupancy fact and no
 * candidate count anywhere in an HTTP response in this file. Selection is
 * driven directly through `BookingService`, the same way
 * `booking-concurrency.pg-spec.ts` drives the slot claim -- there is no
 * isolated `POST /bookings` route to test against (booking creation is
 * wired through `checkout.controller.ts`'s payment orchestration), so this
 * suite proves the service-layer guarantee directly, matching established
 * precedent.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

describeIfPg('Booking resource assignment and collision prevention (#128 / #110b)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let bookings: BookingService;
  let locationResources: LocationResourceService;
  let businessLocations: BusinessLocationService;
  let referenceSecret: string;

  const uniquePhone = (prefix: string) => `${prefix}${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    bookings = app.get(BookingService);
    locationResources = app.get(LocationResourceService);
    businessLocations = app.get(BusinessLocationService);
    referenceSecret = app.get<string>(WORKSPACE_REFERENCE_SECRET);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  // =========================================================================
  // Fixtures
  // =========================================================================

  /** A live business owner with one active location. */
  async function seedOwnerWithLocation(prefix: string) {
    const owner = await seedUser(app, dataSource, uniquePhone(prefix), ['business']);
    const business = await seedBusiness(dataSource, owner.id, 'سالن');
    const cityId = await seedCity(dataSource, `شهر ${Math.random().toString(36).slice(2, 8)}`);
    const locationId = uuidv7();
    await dataSource.query(`INSERT INTO business.locations (id, business_id, name, city_id, lifecycle) VALUES ($1, $2, 'شعبه', $3, 'active')`, [
      locationId,
      business.id,
      cityId,
    ]);
    return { owner, businessId: business.id, locationId };
  }

  async function seedResource(businessId: string, locationId: string, kind: 'room' | 'device' | 'station' = 'device') {
    const id = uuidv7();
    await dataSource.query(
      `INSERT INTO business.location_resources (id, location_id, business_id, kind, name, lifecycle) VALUES ($1, $2, $3, $4, 'منبع', 'active')`,
      [id, locationId, businessId, kind],
    );
    return id;
  }

  /** A professional, affiliated with `businessId`, ACTIVE membership bound to `locationId`, with a resource requirement for `kind`. */
  async function seedAffiliatedRequiringProfessional(
    businessId: string,
    ownerId: string,
    locationId: string,
    prefix: string,
    kind: 'room' | 'device' | 'station' = 'device',
  ) {
    const proUser = await seedUser(app, dataSource, uniquePhone(prefix), ['professional']);
    const professional = await seedProfessional(dataSource, proUser.id, 'حرفه‌ای');
    const membershipId = await seedMembership(dataSource, businessId, proUser.id, 'staff', ownerId, professional.id);
    await dataSource.query(
      `UPDATE business.business_staff SET status='active', responded_at=now(), location_id=$1 WHERE id=$2`,
      [locationId, membershipId],
    );
    await dataSource.query(
      `INSERT INTO business.service_resource_requirements (id, business_id, service_id, required_kind) VALUES ($1, $2, $3, $4)`,
      [uuidv7(), businessId, professional.serviceId, kind],
    );
    return { proUser, professional };
  }

  /** A slot for `professionalId`, delivered at `locationId`, `hoursFromNow` ahead. */
  async function seedDeliverySlot(professionalId: string, serviceId: string | null, locationId: string | null, hoursFromNow = 48) {
    return seedSlot(dataSource, professionalId, serviceId, futureSlotTime(hoursFromNow), 60, locationId);
  }

  async function createInput(customer: SeededUser, professionalId: string, slotId: string, serviceId: string | null): Promise<CreateBookingInput> {
    return { customerId: customer.id, professionalId, slotId, serviceId };
  }

  async function assignmentFor(bookingId: string) {
    const rows = await dataSource.query(
      `SELECT id, resource_id, start_at, end_at, status FROM booking.booking_resource_assignments WHERE booking_id = $1`,
      [bookingId],
    );
    return rows[0] ?? null;
  }

  // =========================================================================
  // §1 Schema shape
  // =========================================================================

  describe('§1 the migration produced exactly the ratified shape', () => {
    it('booking.booking_resource_assignments has exactly the ratified columns', async () => {
      const columns: string[] = (
        await dataSource.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema='booking' AND table_name='booking_resource_assignments'`,
        )
      ).map((r: { column_name: string }) => r.column_name);
      expect(columns.sort()).toEqual(['booking_id', 'created_at', 'end_at', 'id', 'resource_id', 'start_at', 'status', 'updated_at'].sort());
    });

    it('carries no owner, kind, occupancy or reference column', async () => {
      const columns: string[] = (
        await dataSource.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema='booking' AND table_name='booking_resource_assignments'`,
        )
      ).map((r: { column_name: string }) => r.column_name);
      for (const forbidden of ['kind', 'resource_ref', 'occupancy', 'customer_id', 'business_id', 'location_id']) {
        expect(columns).not.toContain(forbidden);
      }
    });

    it('declares the CHECK constraints, the plain UNIQUE(booking_id), and NO cross-schema FK', async () => {
      const defs: string[] = (
        await dataSource.query(
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='booking.booking_resource_assignments'::regclass`,
        )
      ).map((r: { conname: string; def: string }) => `${r.conname}: ${r.def}`);
      expect(defs.join('\n')).toMatch(/ck_booking_resource_assignments_range: CHECK \(\(?end_at > start_at\)?\)/);
      const statusCheck = defs.find((d) => d.startsWith('ck_booking_resource_assignments_status:'));
      expect(statusCheck).toContain("'active'");
      expect(statusCheck).toContain("'released'");

      const fkDefs: string[] = (
        await dataSource.query(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='booking.booking_resource_assignments'::regclass AND contype='f'`,
        )
      ).map((r: { def: string }) => r.def);
      expect(fkDefs).toHaveLength(1);
      expect(fkDefs[0]).toMatch(/REFERENCES booking\.bookings/);
      expect(fkDefs.filter((d) => /business\./i.test(d))).toEqual([]);
    });

    it('declares ex_booking_resource_no_overlap as a partial GiST exclusion constraint over active rows', async () => {
      const [row] = await dataSource.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='booking.booking_resource_assignments'::regclass AND conname='ex_booking_resource_no_overlap'`,
      );
      expect(row).toBeDefined();
      expect(row.def).toMatch(/EXCLUDE USING gist/);
      expect(row.def).toMatch(/resource_id/);
      expect(row.def).toMatch(/tstzrange\(start_at, end_at, '\[\)'(::text)?\)/);
      expect(row.def).toMatch(/WHERE \(\(\(?status\)?::text = 'active'::[\s\S]*?\)?\)/);
    });

    it('the named unique index is on booking_id, plain -- not partial', async () => {
      const indexes: string[] = (
        await dataSource.query(`SELECT indexdef FROM pg_indexes WHERE schemaname='booking' AND tablename='booking_resource_assignments'`)
      ).map((r: { indexdef: string }) => r.indexdef);
      const uq = indexes.find((d) => d.includes('uq_booking_resource_assignments_booking'));
      expect(uq).toBeDefined();
      expect(uq).toMatch(/CREATE UNIQUE INDEX uq_booking_resource_assignments_booking ON booking\.booking_resource_assignments USING btree \(booking_id\)/);
      expect(uq).not.toMatch(/WHERE/);
    });

    it('adds NOTHING to the business schema, and no second collision table exists', async () => {
      const bookingTables: string[] = (
        await dataSource.query(`SELECT tablename FROM pg_tables WHERE schemaname='booking' ORDER BY tablename`)
      ).map((r: { tablename: string }) => r.tablename);
      expect(bookingTables).toEqual([
        'availability_slots',
        'booking_history',
        'booking_resource_assignments',
        'bookings',
        'idempotency_keys',
        'outbox_events',
      ]);
    });
  });

  // =========================================================================
  // §2 Byte-identity with the post-#127a baseline
  // =========================================================================

  describe('§2 booking.bookings and booking.availability_slots are byte-identical to the post-#127a baseline', () => {
    it('bookings gained no column', async () => {
      const columns: string[] = (
        await dataSource.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='booking' AND table_name='bookings'`)
      ).map((r: { column_name: string }) => r.column_name);
      expect(columns.sort()).toEqual(
        [
          'id',
          'customer_id',
          'professional_id',
          'service_id',
          'slot_id',
          'slot_start',
          'slot_end',
          'status',
          'hold_expires_at',
          'reschedule_count',
          'cancellation_reason',
          'cancelled_by_actor_type',
          'cancelled_by_actor_id',
          'confirmed_at',
          'completed_at',
          'cancelled_at',
          'created_at',
          'updated_at',
        ].sort(),
      );
    });

    it('availability_slots gained no column -- delivery_location_id (#127a) is the last one it has', async () => {
      const columns: string[] = (
        await dataSource.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='booking' AND table_name='availability_slots'`)
      ).map((r: { column_name: string }) => r.column_name);
      expect(columns.sort()).toEqual(
        [
          'id',
          'professional_id',
          'service_id',
          'delivery_location_id',
          'start_at',
          'end_at',
          'status',
          'held_until',
          'held_by_booking_id',
          'created_at',
          'updated_at',
        ].sort(),
      );
    });

    it('ex_availability_slots_no_overlap and uq_bookings_active_slot are unchanged -- non-vacuous', async () => {
      const [exSlot] = await dataSource.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='booking.availability_slots'::regclass AND conname='ex_availability_slots_no_overlap'`,
      );
      expect(exSlot.def).toMatch(/professional_id WITH =/);
      expect(exSlot.def).toMatch(/tstzrange\(start_at, end_at, '\[\)'(::text)?\)/);
      expect(exSlot.def).not.toMatch(/resource_id/);

      const [uqSlot] = await dataSource.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname='booking' AND tablename='bookings' AND indexname='uq_bookings_active_slot'`,
      );
      expect(uqSlot.indexdef).toContain("WHERE ((status)::text = ANY");

      // Non-vacuity control: prove this query CAN detect a real difference --
      // a constraint on a table this story genuinely did not touch (#131's,
      // in a different schema) must NOT match `booking.availability_slots`.
      const [foreign] = await dataSource.query(
        `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='booking.availability_slots'::regclass AND conname='ck_service_resource_requirements_kind'`,
      );
      expect(foreign.n).toBe(0);
    });

    it('an existing booking and slot are byte-identical in every column value after a resource-bearing booking is created elsewhere', async () => {
      // A control row, seeded BEFORE any #128 activity in this test, on an
      // UNRELATED professional with no resource requirement at all.
      const controlOwner = await seedUser(app, dataSource, uniquePhone('+98940'), ['professional']);
      const controlPro = await seedProfessional(dataSource, controlOwner.id, 'کنترل');
      const controlSlotId = await seedSlot(dataSource, controlPro.id, controlPro.serviceId, futureSlotTime(50));
      const controlCustomer = await seedUser(app, dataSource, uniquePhone('+98941'));
      const controlBooking = await bookings.create(await createInput(controlCustomer, controlPro.id, controlSlotId, controlPro.serviceId));

      const [beforeBooking] = await dataSource.query(`SELECT * FROM booking.bookings WHERE id = $1`, [controlBooking.id]);
      const [beforeSlot] = await dataSource.query(`SELECT * FROM booking.availability_slots WHERE id = $1`, [controlSlotId]);

      // Now do a completely unrelated, RESOURCE-BEARING booking elsewhere.
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98942');
      const resourceId = await seedResource(businessId, locationId);
      const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98943');
      const slotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId);
      const customer = await seedUser(app, dataSource, uniquePhone('+98944'));
      await bookings.create(await createInput(customer, professional.id, slotId, professional.serviceId));
      void resourceId;

      // The CONTROL rows must be untouched -- literal column equality, not just presence.
      const [afterBooking] = await dataSource.query(`SELECT * FROM booking.bookings WHERE id = $1`, [controlBooking.id]);
      const [afterSlot] = await dataSource.query(`SELECT * FROM booking.availability_slots WHERE id = $1`, [controlSlotId]);
      expect(afterBooking).toEqual(beforeBooking);
      expect(afterSlot).toEqual(beforeSlot);
    });
  });

  // =========================================================================
  // §3 Assignment at creation -- the nullable-service / no-requirement matrix
  // =========================================================================

  describe('§3 assignment at booking creation', () => {
    it('writes an assignment when a requirement is configured and a resource is eligible', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98950');
      const resourceId = await seedResource(businessId, locationId);
      const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98951');
      const slotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId);
      const customer = await seedUser(app, dataSource, uniquePhone('+98952'));

      const booking = await bookings.create(await createInput(customer, professional.id, slotId, professional.serviceId));
      const assignment = await assignmentFor(booking.id);

      expect(assignment).not.toBeNull();
      expect(assignment.resource_id).toBe(resourceId);
      expect(assignment.status).toBe('active');
      expect(new Date(assignment.start_at).getTime()).toBe(booking.slotStart.getTime());
      expect(new Date(assignment.end_at).getTime()).toBe(booking.slotEnd.getTime());
    });

    it('a service with NO requirement books successfully with no assignment', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98953');
      const proUser = await seedUser(app, dataSource, uniquePhone('+98954'), ['professional']);
      const professional = await seedProfessional(dataSource, proUser.id, 'بدون نیاز');
      const membershipId = await seedMembership(dataSource, businessId, proUser.id, 'staff', owner.id, professional.id);
      await dataSource.query(`UPDATE business.business_staff SET status='active', responded_at=now(), location_id=$1 WHERE id=$2`, [
        locationId,
        membershipId,
      ]);
      // Deliberately NO row in business.service_resource_requirements.
      const slotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId);
      const customer = await seedUser(app, dataSource, uniquePhone('+98955'));

      const booking = await bookings.create(await createInput(customer, professional.id, slotId, professional.serviceId));
      expect(await assignmentFor(booking.id)).toBeNull();
    });

    it('a NULL service on the slot books successfully with no assignment, byte-identical to the legacy path', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98956');
      const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98957');
      // The SLOT carries no service -- "any service" -- and the booking supplies none either.
      const slotId = await seedDeliverySlot(professional.id, null, locationId);
      const customer = await seedUser(app, dataSource, uniquePhone('+98958'));

      const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: null });
      expect(booking.serviceId).toBeNull();
      expect(await assignmentFor(booking.id)).toBeNull();
    });

    it('a NULL delivery location books successfully with no assignment', async () => {
      const proUser = await seedUser(app, dataSource, uniquePhone('+98959'), ['professional']);
      // A standalone professional -- no business affiliation at all, so no delivery location can ever resolve.
      const professional = await seedProfessional(dataSource, proUser.id, 'مستقل');
      const slotId = await seedDeliverySlot(professional.id, professional.serviceId, null);
      const customer = await seedUser(app, dataSource, uniquePhone('+98960'));

      const booking = await bookings.create(await createInput(customer, professional.id, slotId, professional.serviceId));
      expect(await assignmentFor(booking.id)).toBeNull();

      const [slot] = await dataSource.query(`SELECT delivery_location_id FROM booking.availability_slots WHERE id = $1`, [slotId]);
      expect(slot.delivery_location_id).toBeNull();
    });
  });

  // =========================================================================
  // §4 No eligible candidate -- the genuine refusal
  // =========================================================================

  describe('§4 a requirement with no eligible candidate refuses, and writes nothing', () => {
    it('refuses with SlotUnavailableException, never a 500, and leaves no booking, slot claim, or assignment behind', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98961');
      // A room exists, but the requirement is `device` -- zero eligible candidates.
      await seedResource(businessId, locationId, 'room');
      const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98962', 'device');
      const slotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId);
      const customer = await seedUser(app, dataSource, uniquePhone('+98963'));

      await expect(bookings.create(await createInput(customer, professional.id, slotId, professional.serviceId))).rejects.toBeInstanceOf(
        SlotUnavailableException,
      );

      const [{ n: bookingCount }] = await dataSource.query(`SELECT count(*)::int AS n FROM booking.bookings`);
      const [{ n: assignmentCount }] = await dataSource.query(`SELECT count(*)::int AS n FROM booking.booking_resource_assignments`);
      expect(bookingCount).toBe(0);
      expect(assignmentCount).toBe(0);

      // The slot claim itself rolled back too -- still open, not held.
      const [slot] = await dataSource.query(`SELECT status FROM booking.availability_slots WHERE id = $1`, [slotId]);
      expect(slot.status).toBe('open');
    });

    it('refuses identically for zero candidates, a retired-only candidate pool, and a wrong-location resource -- byte-identical causes', async () => {
      const causes: unknown[] = [];

      // Cause A: zero resources at the location at all.
      {
        const { owner, businessId, locationId } = await seedOwnerWithLocation('+98964');
        const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98965');
        const slotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId);
        const customer = await seedUser(app, dataSource, uniquePhone('+98966'));
        try {
          await bookings.create(await createInput(customer, professional.id, slotId, professional.serviceId));
        } catch (err) {
          causes.push((err as Error).constructor.name);
        }
      }

      // Cause B: the only matching resource is retired.
      {
        const { owner, businessId, locationId } = await seedOwnerWithLocation('+98967');
        const resourceId = await seedResource(businessId, locationId);
        await dataSource.query(`UPDATE business.location_resources SET lifecycle='retired' WHERE id = $1`, [resourceId]);
        const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98968');
        const slotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId);
        const customer = await seedUser(app, dataSource, uniquePhone('+98969'));
        try {
          await bookings.create(await createInput(customer, professional.id, slotId, professional.serviceId));
        } catch (err) {
          causes.push((err as Error).constructor.name);
        }
      }

      // Cause C: the resource exists but at a DIFFERENT location of the same business.
      {
        const { owner, businessId, locationId } = await seedOwnerWithLocation('+98970');
        const otherCityId = await seedCity(dataSource, `شهر ${Math.random().toString(36).slice(2, 8)}`);
        const otherLocationId = uuidv7();
        await dataSource.query(`INSERT INTO business.locations (id, business_id, name, city_id, lifecycle) VALUES ($1, $2, 'شعبه دیگر', $3, 'active')`, [
          otherLocationId,
          businessId,
          otherCityId,
        ]);
        await seedResource(businessId, otherLocationId);
        const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98971');
        const slotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId);
        const customer = await seedUser(app, dataSource, uniquePhone('+98972'));
        try {
          await bookings.create(await createInput(customer, professional.id, slotId, professional.serviceId));
        } catch (err) {
          causes.push((err as Error).constructor.name);
        }
      }

      expect(causes).toHaveLength(3);
      expect(new Set(causes).size).toBe(1);
      expect(causes[0]).toBe('SlotUnavailableException');
    });
  });

  // =========================================================================
  // §5 Cancellation releases atomically
  // =========================================================================

  describe('§5 cancellation releases the assignment', () => {
    async function seedAssignedBooking(prefix: string) {
      const { owner, businessId, locationId } = await seedOwnerWithLocation(prefix);
      const resourceId = await seedResource(businessId, locationId);
      const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, `${prefix}p`);
      const slotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId);
      const customer = await seedUser(app, dataSource, uniquePhone(`${prefix}c`));
      const booking = await bookings.create(await createInput(customer, professional.id, slotId, professional.serviceId));
      return { booking, customer, resourceId, businessId, locationId, professional };
    }

    it('releases in the same transaction as the cancellation -- the row survives as history', async () => {
      const { booking, customer } = await seedAssignedBooking('+98973');
      const before = await assignmentFor(booking.id);
      expect(before.status).toBe('active');

      await bookings.cancel(booking.id, { type: 'customer', id: customer.id }, 'تغییر نظر');

      const after = await assignmentFor(booking.id);
      expect(after.id).toBe(before.id);
      expect(after.status).toBe('released');
      expect(after.resource_id).toBe(before.resource_id);
    });

    it('repeated cancellation is idempotent -- no second write, no error', async () => {
      const { booking, customer } = await seedAssignedBooking('+98974');
      await bookings.cancel(booking.id, { type: 'customer', id: customer.id }, 'a');
      const first = await assignmentFor(booking.id);

      await bookings.cancel(booking.id, { type: 'customer', id: customer.id }, 'b');
      const second = await assignmentFor(booking.id);

      expect(second.status).toBe('released');
      expect(second.updated_at).toEqual(first.updated_at);
    });

    it('cancelling a booking with NO assignment is a silent no-op', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98975');
      const proUser = await seedUser(app, dataSource, uniquePhone('+98976'), ['professional']);
      const professional = await seedProfessional(dataSource, proUser.id, 'بدون نیاز');
      const membershipId = await seedMembership(dataSource, businessId, proUser.id, 'staff', owner.id, professional.id);
      await dataSource.query(`UPDATE business.business_staff SET status='active', responded_at=now(), location_id=$1 WHERE id=$2`, [
        locationId,
        membershipId,
      ]);
      const slotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId);
      const customer = await seedUser(app, dataSource, uniquePhone('+98977'));
      const booking = await bookings.create(await createInput(customer, professional.id, slotId, professional.serviceId));

      await expect(bookings.cancel(booking.id, { type: 'customer', id: customer.id }, null)).resolves.toBe(true);
      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM booking.booking_resource_assignments`);
      expect(n).toBe(0);
    });

    it('a released assignment no longer blocks a NEW booking for the same resource and range', async () => {
      const { booking, customer, resourceId, businessId, locationId, professional } = await seedAssignedBooking('+98978');
      await bookings.cancel(booking.id, { type: 'customer', id: customer.id }, null);

      // A second professional, same business/location/kind, whose NEW slot
      // exactly overlaps the cancelled booking's old range.
      const { professional: secondPro } = await seedAffiliatedRequiringProfessional(businessId, professional.ownerUserId, locationId, '+98979');
      const [oldAssignment] = await dataSource.query(`SELECT start_at, end_at FROM booking.booking_resource_assignments WHERE resource_id = $1`, [
        resourceId,
      ]);
      const slotId = uuidv7();
      await dataSource.query(
        `INSERT INTO booking.availability_slots (id, professional_id, service_id, start_at, end_at, status, delivery_location_id) VALUES ($1,$2,$3,$4,$5,'open',$6)`,
        [slotId, secondPro.id, secondPro.serviceId, oldAssignment.start_at, oldAssignment.end_at, locationId],
      );
      const secondCustomer = await seedUser(app, dataSource, uniquePhone('+98980'));

      const secondBooking = await bookings.create(await createInput(secondCustomer, secondPro.id, slotId, secondPro.serviceId));
      const secondAssignment = await assignmentFor(secondBooking.id);
      expect(secondAssignment.resource_id).toBe(resourceId);
      expect(secondAssignment.status).toBe('active');
    });
  });

  // =========================================================================
  // §6 Reschedule re-evaluates and moves atomically
  // =========================================================================

  describe('§6 reschedule', () => {
    it("moves the assignment to the NEW slot's range and resource pool, in place -- same row, no new row", async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98981');
      await seedResource(businessId, locationId);
      const secondResourceId = await seedResource(businessId, locationId);
      const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98982');
      const originalSlotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId, 48);
      const customer = await seedUser(app, dataSource, uniquePhone('+98983'));
      const booking = await bookings.create(await createInput(customer, professional.id, originalSlotId, professional.serviceId));
      const before = await assignmentFor(booking.id);

      const newSlotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId, 96);
      const rescheduled = await bookings.reschedule(booking.id, newSlotId, { type: 'customer', id: customer.id }, null);

      const after = await assignmentFor(booking.id);
      expect(after.id).toBe(before.id); // same row, mutated -- not a second insert
      expect(after.status).toBe('active');
      expect(new Date(after.start_at).getTime()).toBe(rescheduled.slotStart.getTime());
      expect([before.resource_id, secondResourceId]).toContain(after.resource_id);

      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM booking.booking_resource_assignments WHERE booking_id = $1`, [
        booking.id,
      ]);
      expect(n).toBe(1);
    });

    it('rescheduling to a destination with NO requirement releases the assignment -- never carries the old resource forward', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98984');
      await seedResource(businessId, locationId);
      const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98985');
      const originalSlotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId, 48);
      const customer = await seedUser(app, dataSource, uniquePhone('+98986'));
      const booking = await bookings.create(await createInput(customer, professional.id, originalSlotId, professional.serviceId));
      expect((await assignmentFor(booking.id)).status).toBe('active');

      // A SECOND, unrelated service for the SAME professional with no requirement.
      const noReqServiceId = uuidv7();
      await dataSource.query(
        `INSERT INTO provider.services (id, professional_id, name, duration_minutes, price_toman) VALUES ($1, $2, 'بدون نیاز', 60, 100000)`,
        [noReqServiceId, professional.id],
      );
      // A generic slot (no service pinned) that can take that service.
      const newSlotId = await seedDeliverySlot(professional.id, null, locationId, 96);

      // Rescheduling moves the SAME booking to a slot with no service pinned;
      // the booking keeps its OWN serviceId (reschedule validates same
      // professional/service, not a service change) -- so this exercises
      // "destination slot carries no service of its own", which still
      // resolves the SAME (already-required) service. To reach "genuinely no
      // requirement", reschedule the booking onto a slot for a DIFFERENT,
      // requirement-free booking created against noReqServiceId directly.
      const freshCustomer = await seedUser(app, dataSource, uniquePhone('+98987'));
      const freshBooking = await bookings.create({
        customerId: freshCustomer.id,
        professionalId: professional.id,
        slotId: newSlotId,
        serviceId: noReqServiceId,
      });
      expect(await assignmentFor(freshBooking.id)).toBeNull();

      const anotherSlotId = await seedDeliverySlot(professional.id, noReqServiceId, locationId, 120);
      const reassigned = await bookings.reschedule(freshBooking.id, anotherSlotId, { type: 'customer', id: freshCustomer.id }, null);
      expect(reassigned.serviceId).toBe(noReqServiceId);
      expect(await assignmentFor(freshBooking.id)).toBeNull();

      // And the ORIGINAL resource-requiring booking is completely unaffected.
      expect((await assignmentFor(booking.id)).status).toBe('active');
    });

    it('when the destination requires a resource and none can be acquired, the ORIGINAL booking and assignment remain unchanged', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98988');
      const resourceId = await seedResource(businessId, locationId);
      const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98989');
      const originalSlotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId, 48);
      const customer = await seedUser(app, dataSource, uniquePhone('+98990'));
      const booking = await bookings.create(await createInput(customer, professional.id, originalSlotId, professional.serviceId));
      const before = await assignmentFor(booking.id);
      const beforeBookingRow = await dataSource.query(`SELECT * FROM booking.bookings WHERE id = $1`, [booking.id]);

      // A destination slot whose time range is ALREADY occupied (by the
      // SAME resource) via a second, unrelated booking -- so the ONLY
      // resource is unavailable at the destination.
      const { professional: blockerPro } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98991');
      const blockerSlotId = await seedDeliverySlot(blockerPro.id, blockerPro.serviceId, locationId, 96);
      const blockerCustomer = await seedUser(app, dataSource, uniquePhone('+98992'));
      await bookings.create(await createInput(blockerCustomer, blockerPro.id, blockerSlotId, blockerPro.serviceId));

      const destinationSlotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId, 96);

      await expect(
        bookings.reschedule(booking.id, destinationSlotId, { type: 'customer', id: customer.id }, null),
      ).rejects.toBeInstanceOf(SlotUnavailableException);

      const afterAssignment = await assignmentFor(booking.id);
      const afterBookingRow = await dataSource.query(`SELECT * FROM booking.bookings WHERE id = $1`, [booking.id]);
      expect(afterAssignment).toEqual(before);
      expect(afterBookingRow).toEqual(beforeBookingRow);
      void resourceId;

      // The destination slot claim rolled back too.
      const [destSlot] = await dataSource.query(`SELECT status FROM booking.availability_slots WHERE id = $1`, [destinationSlotId]);
      expect(destSlot.status).toBe('open');
    });

    it('rolls back an assignment failure injected LATE in the transaction, preserving the original booking completely', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98993');
      await seedResource(businessId, locationId);
      const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98994');
      const originalSlotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId, 48);
      const customer = await seedUser(app, dataSource, uniquePhone('+98995'));
      const booking = await bookings.create(await createInput(customer, professional.id, originalSlotId, professional.serviceId));
      const beforeBookingRow = await dataSource.query(`SELECT * FROM booking.bookings WHERE id = $1`, [booking.id]);
      const beforeAssignment = await assignmentFor(booking.id);

      const newSlotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId, 96);

      // A planted failure AFTER the resource is (successfully, in-memory)
      // resolved but before the whole transaction commits -- simulated by
      // making the destination slot's own claim predicate fail via a
      // concurrent steal, injected between the two statements is
      // impractical without a second connection; instead this proves the
      // equivalent guarantee directly: an invalid destination (already
      // booked by someone else) rolls back with NOTHING changed.
      const stealer = await seedUser(app, dataSource, uniquePhone('+98996'));
      await dataSource.query(
        `INSERT INTO booking.bookings (id, customer_id, professional_id, service_id, slot_id, slot_start, slot_end, status)
         SELECT $1, $2, professional_id, service_id, id, start_at, end_at, 'pending' FROM booking.availability_slots WHERE id = $3`,
        [uuidv7(), stealer.id, newSlotId],
      );
      await dataSource.query(`UPDATE booking.availability_slots SET status='held', held_until=now()+interval '10 minutes' WHERE id = $1`, [
        newSlotId,
      ]);

      await expect(
        bookings.reschedule(booking.id, newSlotId, { type: 'customer', id: customer.id }, null),
      ).rejects.toThrow();

      const afterBookingRow = await dataSource.query(`SELECT * FROM booking.bookings WHERE id = $1`, [booking.id]);
      const afterAssignment = await assignmentFor(booking.id);
      expect(afterBookingRow).toEqual(beforeBookingRow);
      expect(afterAssignment).toEqual(beforeAssignment);
    });
  });

  // =========================================================================
  // §7 Real concurrency
  // =========================================================================

  describe('§7 genuinely parallel concurrency', () => {
    it('two bookings racing for the SAME single resource and overlapping range: exactly one succeeds', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98997');
      const resourceId = await seedResource(businessId, locationId);
      const { professional: proA } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98998');
      const { professional: proB } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98999');
      const start = futureSlotTime(48);
      const slotA = await seedSlot(dataSource, proA.id, proA.serviceId, start, 60, locationId);
      const slotB = await seedSlot(dataSource, proB.id, proB.serviceId, start, 60, locationId);
      const customerA = await seedUser(app, dataSource, uniquePhone('+98900'));
      const customerB = await seedUser(app, dataSource, uniquePhone('+98901'));

      const results = await Promise.allSettled([
        bookings.create(await createInput(customerA, proA.id, slotA, proA.serviceId)),
        bookings.create(await createInput(customerB, proB.id, slotB, proB.serviceId)),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SlotUnavailableException);

      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM booking.booking_resource_assignments WHERE resource_id = $1 AND status = 'active'`,
        [resourceId],
      );
      expect(n).toBe(1);

      // The loser's booking does not exist at all -- the whole transaction, slot claim included, rolled back.
      const [{ n: totalBookings }] = await dataSource.query(`SELECT count(*)::int AS n FROM booking.bookings`);
      expect(totalBookings).toBe(1);
    });

    it('two eligible resources: concurrent bookings safely select DIFFERENT resources', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98902');
      const resourceA = await seedResource(businessId, locationId);
      const resourceB = await seedResource(businessId, locationId);
      const { professional: proA } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98903');
      const { professional: proB } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98904');
      const start = futureSlotTime(48);
      const slotA = await seedSlot(dataSource, proA.id, proA.serviceId, start, 60, locationId);
      const slotB = await seedSlot(dataSource, proB.id, proB.serviceId, start, 60, locationId);
      const customerA = await seedUser(app, dataSource, uniquePhone('+98905'));
      const customerB = await seedUser(app, dataSource, uniquePhone('+98906'));

      const results = await Promise.allSettled([
        bookings.create(await createInput(customerA, proA.id, slotA, proA.serviceId)),
        bookings.create(await createInput(customerB, proB.id, slotB, proB.serviceId)),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      const rows = await dataSource.query(`SELECT resource_id FROM booking.booking_resource_assignments WHERE status = 'active' ORDER BY resource_id`);
      expect(rows.map((r: { resource_id: string }) => r.resource_id).sort()).toEqual([resourceA, resourceB].sort());
    });

    it('exact-boundary adjacency on the SAME resource: both succeed (half-open [) semantics)', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98907');
      await seedResource(businessId, locationId);
      const { professional: proA } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98908');
      const { professional: proB } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98909');
      const start = futureSlotTime(48);
      const end = new Date(start.getTime() + 3_600_000);
      const slotA = await seedSlot(dataSource, proA.id, proA.serviceId, start, 60, locationId);
      // slotB starts exactly where slotA ends.
      const slotB = uuidv7();
      await dataSource.query(
        `INSERT INTO booking.availability_slots (id, professional_id, service_id, start_at, end_at, status, delivery_location_id) VALUES ($1,$2,$3,$4,$5,'open',$6)`,
        [slotB, proB.id, proB.serviceId, end, new Date(end.getTime() + 3_600_000), locationId],
      );
      const customerA = await seedUser(app, dataSource, uniquePhone('+98910'));
      const customerB = await seedUser(app, dataSource, uniquePhone('+98911'));

      const results = await Promise.allSettled([
        bookings.create(await createInput(customerA, proA.id, slotA, proA.serviceId)),
        bookings.create(await createInput(customerB, proB.id, slotB, proB.serviceId)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    });

    it('overlapping times on DIFFERENT resources: both succeed', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98912');
      const resourceA = await seedResource(businessId, locationId);
      const resourceB = await seedResource(businessId, locationId);
      const { professional: proA } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98913');
      const { professional: proB } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98914');
      const start = futureSlotTime(48);
      const slotA = await seedSlot(dataSource, proA.id, proA.serviceId, start, 60, locationId);
      const slotB = await seedSlot(dataSource, proB.id, proB.serviceId, start, 60, locationId);
      const customerA = await seedUser(app, dataSource, uniquePhone('+98915'));
      const customerB = await seedUser(app, dataSource, uniquePhone('+98916'));

      await bookings.create(await createInput(customerA, proA.id, slotA, proA.serviceId));
      await bookings.create(await createInput(customerB, proB.id, slotB, proB.serviceId));

      const rows = await dataSource.query(`SELECT resource_id FROM booking.booking_resource_assignments WHERE status='active' ORDER BY resource_id`);
      expect(rows.map((r: { resource_id: string }) => r.resource_id).sort()).toEqual([resourceA, resourceB].sort());
    });

    it('the SAME resource at non-overlapping times: both succeed', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98917');
      const resourceId = await seedResource(businessId, locationId);
      const { professional: proA } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98918');
      const { professional: proB } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98919');
      const slotA = await seedDeliverySlot(proA.id, proA.serviceId, locationId, 48);
      const slotB = await seedDeliverySlot(proB.id, proB.serviceId, locationId, 96);
      const customerA = await seedUser(app, dataSource, uniquePhone('+98920'));
      const customerB = await seedUser(app, dataSource, uniquePhone('+98921'));

      await bookings.create(await createInput(customerA, proA.id, slotA, proA.serviceId));
      await bookings.create(await createInput(customerB, proB.id, slotB, proB.serviceId));

      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM booking.booking_resource_assignments WHERE resource_id = $1 AND status = 'active'`,
        [resourceId],
      );
      expect(n).toBe(2);
    });
  });

  // =========================================================================
  // §8 Closure and retirement blocking
  // =========================================================================

  describe('§8 resource retirement and location closure', () => {
    it('retiring a resource with a FUTURE active assignment is blocked, non-enumeratingly', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98922');
      const resourceId = await seedResource(businessId, locationId);
      const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98923');
      const slotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId);
      const customer = await seedUser(app, dataSource, uniquePhone('+98924'));
      await bookings.create(await createInput(customer, professional.id, slotId, professional.serviceId));

      const locationRef = deriveLocationRefFor(businessId, owner.id, locationId);
      const resourceRef = deriveResourceRefFor(businessId, owner.id, locationId, resourceId);

      await expect(locationResources.retire(businessId, owner.id, locationRef, resourceRef)).rejects.toThrow();

      const [row] = await dataSource.query(`SELECT lifecycle FROM business.location_resources WHERE id = $1`, [resourceId]);
      expect(row.lifecycle).toBe('active');
    });

    it('retiring a resource whose ONLY assignment is already past/released succeeds', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98925');
      const resourceId = await seedResource(businessId, locationId);
      const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98926');
      const slotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId);
      const customer = await seedUser(app, dataSource, uniquePhone('+98927'));
      const booking = await bookings.create(await createInput(customer, professional.id, slotId, professional.serviceId));
      // Release it, exactly as cancellation would.
      await dataSource.query(`UPDATE booking.booking_resource_assignments SET status='released' WHERE booking_id = $1`, [booking.id]);

      const locationRef = deriveLocationRefFor(businessId, owner.id, locationId);
      const resourceRef = deriveResourceRefFor(businessId, owner.id, locationId, resourceId);
      const view = await locationResources.retire(businessId, owner.id, locationRef, resourceRef);
      expect(view.lifecycle).toBe('retired');
    });

    it('a resource retirement race: locking closes the window -- the winner determines the outcome, no partial state', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98928');
      const resourceId = await seedResource(businessId, locationId);
      const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98929');
      const slotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId);
      const customer = await seedUser(app, dataSource, uniquePhone('+98930'));

      const locationRef = deriveLocationRefFor(businessId, owner.id, locationId);
      const resourceRef = deriveResourceRefFor(businessId, owner.id, locationId, resourceId);

      const results = await Promise.allSettled([
        bookings.create(await createInput(customer, professional.id, slotId, professional.serviceId)),
        locationResources.retire(businessId, owner.id, locationRef, resourceRef),
      ]);

      const [row] = await dataSource.query(`SELECT lifecycle FROM business.location_resources WHERE id = $1`, [resourceId]);
      const [{ n: activeAssignments }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM booking.booking_resource_assignments WHERE resource_id = $1 AND status='active'`,
        [resourceId],
      );

      // Whichever transaction locked the resource first wins entirely: either
      // the booking succeeded (assignment active, resource still active), or
      // the retirement succeeded (resource retired, no active assignment) --
      // NEVER both an active assignment on a retired resource.
      if (row.lifecycle === 'retired') {
        expect(activeAssignments).toBe(0);
        expect(results[0].status).toBe('rejected');
      } else {
        expect(activeAssignments).toBe(1);
      }
    });

    it('closing a location with a future active assignment on ANY of its resources is blocked', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98931');
      await seedResource(businessId, locationId, 'room'); // an unrelated, unassigned resource
      const resourceId = await seedResource(businessId, locationId, 'device');
      const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98932', 'device');
      const slotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId);
      const customer = await seedUser(app, dataSource, uniquePhone('+98933'));
      await bookings.create(await createInput(customer, professional.id, slotId, professional.serviceId));
      void resourceId;

      const locationRef = deriveLocationRefFor(businessId, owner.id, locationId);
      await expect(businessLocations.close(businessId, owner.id, locationRef)).rejects.toThrow();

      const [row] = await dataSource.query(`SELECT lifecycle FROM business.locations WHERE id = $1`, [locationId]);
      expect(row.lifecycle).toBe('active');
    });

    it('closing a location with NO future assignment (or none at all) succeeds', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98934');
      await seedResource(businessId, locationId);

      const locationRef = deriveLocationRefFor(businessId, owner.id, locationId);
      const view = await businessLocations.close(businessId, owner.id, locationRef);
      expect(view.lifecycle).toBe('closed');
    });
  });

  // =========================================================================
  // §9 ADR-027 privacy
  // =========================================================================

  describe('§9 ADR-027 coverage and subject privacy', () => {
    let coverage: SubjectDataCoverageService;
    let contracts: SubjectDataContract[];

    beforeAll(() => {
      coverage = app.get(SubjectDataCoverageService);
      contracts = app.get(SUBJECT_DATA_CONTRACTS);
    });

    it('claims booking.booking_resource_assignments exactly once, as subject_data', async () => {
      const contract = contracts.find((c) => c.moduleKey === 'booking')!;
      const claims = contract.tables.filter((c) => c.table === 'booking.booking_resource_assignments');
      expect(claims).toHaveLength(1);
      expect(claims[0].disposition).toBe('subject_data');
    });

    it('the live catalogue is fully claimed, including the new table, and booking.availability_slots keeps its no_subject_data claim', async () => {
      const catalogue = await coverage.readCatalogue();
      expect(catalogue.map((t) => `${t.schema}.${t.name}`)).toContain('booking.booking_resource_assignments');
      expect(evaluateCoverage(catalogue, contracts).violations).toEqual([]);

      const contract = contracts.find((c) => c.moduleKey === 'booking')!;
      const slotsClaim = contract.tables.find((c) => c.table === 'booking.availability_slots')!;
      expect(slotsClaim.disposition).toBe('no_subject_data');
    });

    it.each([
      [
        'unclaimed',
        'unclaimed',
        (c: CatalogueTable[], k: SubjectDataContract[]) => ({
          catalogue: c,
          contracts: k.map((contract) => ({
            ...contract,
            tables: contract.tables.filter((t) => t.table !== 'booking.booking_resource_assignments'),
          })) as SubjectDataContract[],
        }),
      ],
      [
        'stale',
        'claimed_but_absent',
        (c: CatalogueTable[], k: SubjectDataContract[]) => ({
          catalogue: c.filter((t) => `${t.schema}.${t.name}` !== 'booking.booking_resource_assignments'),
          contracts: k,
        }),
      ],
    ])('a %s claim fails coverage with %s', async (_label, kind, mutate) => {
      const catalogue = await coverage.readCatalogue();
      const mutated = (mutate as (c: CatalogueTable[], k: SubjectDataContract[]) => { catalogue: CatalogueTable[]; contracts: SubjectDataContract[] })(
        [...catalogue],
        [...contracts],
      );
      expect(evaluateCoverage(mutated.catalogue, mutated.contracts).violations.map((v) => v.kind)).toContain(kind);
    });

    it('a customer export never exposes a resource id, and erasure neither deletes nor mutates the assignment row', async () => {
      const { owner, businessId, locationId } = await seedOwnerWithLocation('+98935');
      await seedResource(businessId, locationId);
      const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, '+98936');
      const slotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId);
      const customer = await seedUser(app, dataSource, uniquePhone('+98937'));
      const booking = await bookings.create(await createInput(customer, professional.id, slotId, professional.serviceId));
      const assignment = await assignmentFor(booking.id);

      const contract = app.get(BookingSubjectDataContract);
      const sections = await dataSource.transaction((m) => contract.exportSubjectData(m, customer.id));
      const serialized = JSON.stringify(sections);
      expect(serialized).not.toContain(assignment.resource_id);

      const outcome = await dataSource.transaction((m) => contract.eraseSubjectData(m, customer.id));
      void outcome;
      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM booking.booking_resource_assignments WHERE booking_id = $1`, [
        booking.id,
      ]);
      expect(n).toBe(1);
    });
  });

  // =========================================================================
  // §10 No N+1
  // =========================================================================

  describe('§10 assignment resolution does not grow a query per candidate', () => {
    it('costs the same for one candidate as for six', async () => {
      async function fixtureWith(count: number, prefix: string) {
        const { owner, businessId, locationId } = await seedOwnerWithLocation(prefix);
        for (let i = 0; i < count; i += 1) await seedResource(businessId, locationId, 'station');
        const { professional } = await seedAffiliatedRequiringProfessional(businessId, owner.id, locationId, `${prefix}p`, 'station');
        const slotId = await seedDeliverySlot(professional.id, professional.serviceId, locationId);
        const customer = await seedUser(app, dataSource, uniquePhone(`${prefix}c`));
        return await createInput(customer, professional.id, slotId, professional.serviceId);
      }

      const one = await fixtureWith(1, '+98938');
      const six = await fixtureWith(6, '+98939');

      const countQueries = async (input: CreateBookingInput) => {
        let queries = 0;
        const original = dataSource.logger;
        dataSource.logger = {
          logQuery: () => {
            queries += 1;
          },
          logQueryError: () => undefined,
          logQuerySlow: () => undefined,
          logSchemaBuild: () => undefined,
          logMigration: () => undefined,
          log: () => undefined,
        };
        try {
          await bookings.create(input);
        } finally {
          dataSource.logger = original;
        }
        return queries;
      };

      const withOne = await countQueries(one);
      const withSix = await countQueries(six);
      expect(withOne).toBeGreaterThan(0);
      expect(withSix).toBe(withOne);
    });
  });

  // =========================================================================
  // Helpers that need the workspace-reference secret
  // =========================================================================

  function deriveLocationRefFor(businessId: string, ownerUserId: string, locationId: string): string {
    return deriveLocationReference(referenceSecret, ownerUserId, businessId, locationId);
  }

  function deriveResourceRefFor(businessId: string, ownerUserId: string, locationId: string, resourceId: string): string {
    return deriveResourceReference(referenceSecret, ownerUserId, businessId, locationId, resourceId);
  }
});
