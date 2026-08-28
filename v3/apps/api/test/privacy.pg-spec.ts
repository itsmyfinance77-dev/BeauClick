import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { RoleService } from '@beauclick/identity';
import { BookingService } from '@beauclick/booking';
import { OutboxRelay } from '@beauclick/events';
import { PrivacyService, PrivacySweepService } from '@beauclick/privacy';
import {
  SUBJECT_DATA_CONTRACTS,
  SubjectDataContract,
  SubjectDataCoverageService,
  evaluateCoverage,
} from '@beauclick/subject-data';

import {
  PgTestApp,
  SeededProfessional,
  createPgTestApp,
  futureSlotTime,
  requiredPgEnv,
  resetDatabase,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

const describePg = requiredPgEnv() ? describe : describe.skip;

/**
 * V3.1 Phase E — privacy export, erasure, and the grace window, against real
 * PostgreSQL.
 *
 * FOUR THINGS ARE UNDER TEST, and only the first is what most privacy suites
 * check.
 *
 * **1. The export contains the subject's data and nobody else's.** Easy to
 * assert, easy to pass, and not where the risk is.
 *
 * **2. Coverage is structural.** `V3.1_PRODUCT_ROADMAP.md` §15-E asks for
 * "**asserted structurally** rather than by a hand-maintained list — a new
 * module that owns user data and does not register must fail the suite. That
 * property is the whole point of the design." So the cases below do not check
 * a list of expected sections. They read the REAL `pg_tables` catalogue and
 * assert every table in it is claimed — and then prove the check can fail, by
 * feeding it a table nobody claims. A coverage assertion that has never been
 * seen to fail is not evidence of coverage.
 *
 * **3. Erasure reaches the search index.** Anonymizing `professionals.
 * display_name` in PostgreSQL leaves the name in `search.provider_documents`,
 * which is the one surface the public actually reads. An erasure that passes
 * every database assertion and still serves the erased name is the failure
 * mode worth writing a test for.
 *
 * **4. Cancellation inside the grace window restores everything** — which it
 * does by construction, because nothing was destroyed. The test proves the
 * construction rather than the intention: it cancels, then executes the sweep,
 * and asserts the account is untouched.
 */
describePg('V3.1 Phase E — privacy (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let relay: OutboxRelay;
  let roles: RoleService;
  let privacy: PrivacyService;
  let sweep: PrivacySweepService;
  let coverage: SubjectDataCoverageService;
  let contracts: SubjectDataContract[];
  let bookings: BookingService;
  let slotHour = 0;

  async function drainUntilQuiet(maxPasses = 8): Promise<void> {
    for (let i = 0; i < maxPasses; i += 1) {
      const { dispatched } = await relay.drain();
      if (dispatched === 0) return;
    }
  }

  async function bootstrapRole(userId: string, roleSlug: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO identity.user_roles (user_id, role_slug, granted_by, reason)
       VALUES ($1, $2, NULL, 'test bootstrap') ON CONFLICT DO NOTHING`,
      [userId, roleSlug],
    );
  }

  async function tokenFor(userId: string): Promise<string> {
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = app.get(JwtService);
    const access = await roles.resolveAccess(userId);
    return jwt.sign({ sub: userId, roles: access.roles, capabilities: access.capabilities });
  }

  /** Completes a real booking through the real route, so every downstream projection is written by its real consumer. */
  async function completedBookingFor(customerId: string, professional: SeededProfessional): Promise<string> {
    slotHour += 3;
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(24 + slotHour));
    const booking = await bookings.create({
      customerId,
      professionalId: professional.id,
      serviceId: professional.serviceId,
      slotId,
      idempotencyKey: uuidv7(),
    });
    // A hold becomes a confirmation on payment; this suite is about what
    // happens after delivery, so the paid leg is set directly -- the same
    // shortcut `reviews.pg-spec` and `professional-surface.pg-spec` take.
    await dataSource.query(`UPDATE booking.bookings SET status = 'confirmed', hold_expires_at = NULL WHERE id = $1`, [
      booking.id,
    ]);
    await request(app.getHttpServer())
      .post(`/api/v1/bookings/${booking.id}/complete`)
      .set('Authorization', `Bearer ${await tokenFor(professional.ownerUserId)}`)
      .expect(201);
    await drainUntilQuiet();
    return booking.id;
  }

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    relay = ctx.relay;
    roles = app.get(RoleService);
    privacy = app.get(PrivacyService);
    sweep = app.get(PrivacySweepService);
    coverage = app.get(SubjectDataCoverageService);
    contracts = app.get(SUBJECT_DATA_CONTRACTS);
    bookings = app.get(BookingService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  // =====================================================================
  // Structural coverage — the property the whole design rests on
  // =====================================================================

  describe('subject-data coverage is structural', () => {
    it('sees a REAL catalogue, not an empty one', async () => {
      // The guard against a check that silently passes. An empty catalogue
      // produces zero violations and reads exactly like complete coverage,
      // which is why the assertion is that specific known tables ARE present
      // rather than that the violation list is short.
      const catalogue = await coverage.readCatalogue();
      const names = catalogue.map((t) => `${t.schema}.${t.name}`);

      expect(catalogue.length).toBeGreaterThan(40);
      expect(names).toContain('identity.users');
      expect(names).toContain('booking.bookings');
      // The one the application role has NO privilege on. It is in the
      // catalogue only because the check reads `pg_tables` rather than
      // `information_schema` — see coverage.ts.
      expect(names).toContain('financial.ledger_entries');
      expect(names).toContain('privacy.data_requests');
    });

    it('every table in the database is claimed by exactly one module', async () => {
      const report = await coverage.evaluate(contracts);
      expect(report.violations).toEqual([]);
      expect(report.tablesClaimed).toBe(report.tablesInDatabase);
    });

    it('the ledger and the audit log are claimed as RETAINED, with a stated reason', async () => {
      const report = await coverage.evaluate(contracts);
      expect(report.byDisposition.retained).toBeGreaterThan(0);

      // Read through the export document, because that is where a subject
      // actually learns what was kept about them.
      const user = await seedUser(app, dataSource, '+989125010001');
      const document = await privacy.assembleDocument(user.id);
      const retainedTables = document.retained.map((r) => r.table);

      expect(retainedTables).toContain('financial.ledger_entries');
      expect(retainedTables).toContain('admin.admin_audit_log');
      for (const entry of document.retained) {
        expect(entry.reason).not.toBe('unstated');
        expect(entry.reason.length).toBeGreaterThan(10);
      }
    });

    it('FAILS when a table exists that no module claims — proved against the real contract list', async () => {
      // The case that makes every other coverage assertion mean something.
      // A future migration adds a table and nobody registers it; this is what
      // must happen. The catalogue is the real one plus one invented row, so
      // the contracts under test are the application's actual sixteen.
      const catalogue = await coverage.readCatalogue();

      const report = evaluateCoverage(
        [...catalogue, { schema: 'referral', name: 'referrals', columns: ['id', 'user_id'] }],
        contracts,
      );

      expect(report.violations).toHaveLength(1);
      expect(report.violations[0]).toMatchObject({ kind: 'unclaimed', table: 'referral.referrals' });
    });
  });

  // =====================================================================
  // Export
  // =====================================================================

  describe('export', () => {
    it('assembles the subject’s own data across every module, and generates on the sweep', async () => {
      const customer = await seedUser(app, dataSource, '+989125010010');
      const proOwner = await seedUser(app, dataSource, '+989125010011', ['professional']);
      const professional = await seedProfessional(dataSource, proOwner.id, 'سالن آزمایشی');
      await completedBookingFor(customer.id, professional);

      const requested = await request(app.getHttpServer())
        .post('/api/v1/privacy/export')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(202);

      const requestId = requested.body.data.id;
      expect(requested.body.data.status).toBe('pending');
      // 202 and `pending`, not 201 and a downloadable id: the document does
      // not exist yet, and saying otherwise is how a client ends up polling a
      // resource it believes already exists.
      expect(requested.body.data.expiresAt).toBeNull();

      const before = await request(app.getHttpServer())
        .get(`/api/v1/privacy/export/${requestId}/download`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(404);
      expect(before.body.error.code).toBe('NOT_FOUND_OR_NOT_YOURS');

      await sweep.runOnce();

      const ready = await request(app.getHttpServer())
        .get(`/api/v1/privacy/export/${requestId}`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(200);
      expect(ready.body.data.status).toBe('ready');
      expect(ready.body.data.expiresAt).not.toBeNull();

      const download = await request(app.getHttpServer())
        .get(`/api/v1/privacy/export/${requestId}/download`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(200);

      const sections = download.body.data.document.sections;
      // Every registered module contributes a namespaced key, so the document
      // says which module answered for what.
      expect(Object.keys(sections)).toEqual(expect.arrayContaining(['identity.account', 'booking.bookings']));
      expect(sections['identity.account'].rows[0].phone).toBe(customer.phone);
      expect(sections['booking.bookings'].rows).toHaveLength(1);
      expect(download.body.data.checksumSha256).toHaveLength(64);
      expect(download.body.data.byteSize).toBeGreaterThan(0);
    });

    it('never contains another user’s data', async () => {
      const alice = await seedUser(app, dataSource, '+989125010020');
      const bob = await seedUser(app, dataSource, '+989125010021');
      const proOwner = await seedUser(app, dataSource, '+989125010022', ['professional']);
      const professional = await seedProfessional(dataSource, proOwner.id, 'سالن دو');
      await completedBookingFor(bob.id, professional);

      const document = await privacy.assembleDocument(alice.id);
      const serialized = JSON.stringify(document);

      expect(serialized).not.toContain(bob.phone);
      expect(serialized).not.toContain(bob.id);
      expect(document.sections['booking.bookings'].rows).toHaveLength(0);
    });

    it('never contains a credential — no token hash, ever', async () => {
      const user = await seedUser(app, dataSource, '+989125010030');
      await dataSource.query(
        `INSERT INTO identity.refresh_tokens (id, user_id, token_hash, device_label, expires_at)
         VALUES ($1, $2, 'a-secret-hash-value', 'گوشی تست', now() + interval '30 days')`,
        [uuidv7(), user.id],
      );

      const document = await privacy.assembleDocument(user.id);
      const serialized = JSON.stringify(document);

      expect(serialized).not.toContain('a-secret-hash-value');
      expect(serialized).not.toContain('tokenHash');
      // The session is still listed — the subject is entitled to know which
      // devices hold a session. What is withheld is the credential itself.
      expect(document.sections['identity.sessions'].rows[0].deviceLabel).toBe('گوشی تست');
    });

    it('refuses another user’s request id exactly as it refuses one that does not exist', async () => {
      const alice = await seedUser(app, dataSource, '+989125010040');
      const bob = await seedUser(app, dataSource, '+989125010041');

      const hers = await request(app.getHttpServer())
        .post('/api/v1/privacy/export')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .expect(202);

      const notYours = await request(app.getHttpServer())
        .get(`/api/v1/privacy/export/${hers.body.data.id}`)
        .set('Authorization', `Bearer ${bob.accessToken}`)
        .expect(404);

      const nonexistent = await request(app.getHttpServer())
        .get(`/api/v1/privacy/export/${uuidv7()}`)
        .set('Authorization', `Bearer ${bob.accessToken}`)
        .expect(404);

      // Byte-identical, so the route is not an oracle for which request ids
      // exist (V3_SECURITY_MODEL.md §3).
      expect(notYours.body).toEqual(nonexistent.body);
    });

    it('admits one open request per subject per kind, under concurrency', async () => {
      const user = await seedUser(app, dataSource, '+989125010050');

      const [first, second] = await Promise.all([
        request(app.getHttpServer()).post('/api/v1/privacy/export').set('Authorization', `Bearer ${user.accessToken}`),
        request(app.getHttpServer()).post('/api/v1/privacy/export').set('Authorization', `Bearer ${user.accessToken}`),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([202, 409]);

      const rows = await dataSource.query(
        `SELECT count(*)::int AS n FROM privacy.data_requests WHERE subject_user_id = $1 AND kind = 'export'`,
        [user.id],
      );
      expect(rows[0].n).toBe(1);
    });

    it('stops serving an expired export AND destroys the payload', async () => {
      const user = await seedUser(app, dataSource, '+989125010060');
      const created = await request(app.getHttpServer())
        .post('/api/v1/privacy/export')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(202);
      const requestId = created.body.data.id;

      await sweep.runOnce();
      await request(app.getHttpServer())
        .get(`/api/v1/privacy/export/${requestId}/download`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      // Wind the clock back on the row rather than waiting 72 hours.
      await dataSource.query(`UPDATE privacy.data_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
        requestId,
      ]);

      // Refused BEFORE the sweep runs: the route checks the clock as well as
      // the status, so the TTL is not "72 hours plus however long the sweep
      // takes to notice".
      await request(app.getHttpServer())
        .get(`/api/v1/privacy/export/${requestId}/download`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(404);

      await sweep.runOnce();

      const payloads = await dataSource.query('SELECT count(*)::int AS n FROM privacy.export_payloads WHERE request_id = $1', [
        requestId,
      ]);
      const status = await dataSource.query('SELECT status FROM privacy.data_requests WHERE id = $1', [requestId]);
      // The document is GONE, not merely unreachable. An expired export that
      // sits in the database forever is a standing breach liability whose only
      // justification was convenience.
      expect(payloads[0].n).toBe(0);
      expect(status[0].status).toBe('expired');
    });
  });

  // =====================================================================
  // Erasure and the grace window
  // =====================================================================

  describe('erasure', () => {
    it('does nothing until the grace window closes', async () => {
      const user = await seedUser(app, dataSource, '+989125010070');

      await request(app.getHttpServer())
        .post('/api/v1/privacy/deletion')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ confirm: 'DELETE' })
        .expect(202);

      await sweep.runOnce();

      const row = await dataSource.query('SELECT phone, deleted_at FROM identity.users WHERE id = $1', [user.id]);
      expect(row[0].phone).toBe(user.phone);
      expect(row[0].deleted_at).toBeNull();
    });

    it('cancelling inside the window leaves the account completely intact', async () => {
      const user = await seedUser(app, dataSource, '+989125010080');
      const created = await request(app.getHttpServer())
        .post('/api/v1/privacy/deletion')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ confirm: 'DELETE' })
        .expect(202);

      await request(app.getHttpServer())
        .post(`/api/v1/privacy/deletion/${created.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      // Due now, and still must not execute: the request is cancelled.
      await dataSource.query(`UPDATE privacy.data_requests SET execute_after = now() - interval '1 hour' WHERE id = $1`, [
        created.body.data.id,
      ]);
      await sweep.runOnce();

      const row = await dataSource.query(
        'SELECT phone, display_name, deleted_at FROM identity.users WHERE id = $1',
        [user.id],
      );
      expect(row[0].phone).toBe(user.phone);
      expect(row[0].deleted_at).toBeNull();

      const requestRow = await dataSource.query('SELECT status, cancelled_by FROM privacy.data_requests WHERE id = $1', [
        created.body.data.id,
      ]);
      expect(requestRow[0].status).toBe('cancelled');
      expect(requestRow[0].cancelled_by).toBe(user.id);
    });

    it('a second cancel is refused, and does not produce a second event', async () => {
      const user = await seedUser(app, dataSource, '+989125010090');
      const created = await request(app.getHttpServer())
        .post('/api/v1/privacy/deletion')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ confirm: 'DELETE' })
        .expect(202);

      await request(app.getHttpServer())
        .post(`/api/v1/privacy/deletion/${created.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/privacy/deletion/${created.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(404);

      const events = await dataSource.query(
        `SELECT count(*)::int AS n FROM privacy.outbox_events WHERE event_type = 'DataErasureCancelled' AND aggregate_id = $1`,
        [created.body.data.id],
      );
      expect(events[0].n).toBe(1);
    });

    it('nobody else can cancel — including the same request id from another session', async () => {
      const alice = await seedUser(app, dataSource, '+989125010100');
      const bob = await seedUser(app, dataSource, '+989125010101');
      const created = await request(app.getHttpServer())
        .post('/api/v1/privacy/deletion')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({ confirm: 'DELETE' })
        .expect(202);

      await request(app.getHttpServer())
        .post(`/api/v1/privacy/deletion/${created.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${bob.accessToken}`)
        .expect(404);

      const row = await dataSource.query('SELECT status FROM privacy.data_requests WHERE id = $1', [
        created.body.data.id,
      ]);
      expect(row[0].status).toBe('pending');
    });

    it('destroys the identity and the free text, and keeps the transaction records', async () => {
      const customer = await seedUser(app, dataSource, '+989125010110');
      const proOwner = await seedUser(app, dataSource, '+989125010111', ['professional']);
      const professional = await seedProfessional(dataSource, proOwner.id, 'سالن سه');
      const bookingId = await completedBookingFor(customer.id, professional);

      await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/review`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rating: 5, comment: 'یک نظر بسیار شخصی و قابل شناسایی' })
        .expect(201);

      await dataSource.query(
        `INSERT INTO journey.beauty_profiles (user_id, notes) VALUES ($1, 'یادداشت خصوصی')
         ON CONFLICT (user_id) DO UPDATE SET notes = EXCLUDED.notes`,
        [customer.id],
      );

      const created = await request(app.getHttpServer())
        .post('/api/v1/privacy/deletion')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ confirm: 'DELETE' })
        .expect(202);
      await dataSource.query(`UPDATE privacy.data_requests SET execute_after = now() - interval '1 hour' WHERE id = $1`, [
        created.body.data.id,
      ]);

      await sweep.runOnce();

      const user = await dataSource.query(
        'SELECT phone, display_name, roles, deleted_at FROM identity.users WHERE id = $1',
        [customer.id],
      );
      expect(user[0].phone).not.toBe(customer.phone);
      expect(user[0].phone.startsWith('del:')).toBe(true);
      expect(user[0].display_name).toBeNull();
      expect(user[0].roles).toEqual([]);
      expect(user[0].deleted_at).not.toBeNull();

      // Sessions and one-time codes are gone entirely. `otp_requests` is keyed
      // by PHONE, so it can only be cleared while the number is still known —
      // which is why identity erases it before rewriting the column.
      const sessions = await dataSource.query('SELECT count(*)::int AS n FROM identity.refresh_tokens WHERE user_id = $1', [
        customer.id,
      ]);
      const otps = await dataSource.query('SELECT count(*)::int AS n FROM identity.otp_requests WHERE phone = $1', [
        customer.phone,
      ]);
      expect(sessions[0].n).toBe(0);
      expect(otps[0].n).toBe(0);

      // The rating survives; the prose does not. A rating is a fact about the
      // professional that other customers and the ranking formula rely on.
      const review = await dataSource.query('SELECT rating, comment FROM provider.reviews WHERE customer_id = $1', [
        customer.id,
      ]);
      expect(review[0].rating).toBe(5);
      expect(review[0].comment).toBeNull();

      // Purely personal, single-party rows are DELETED rather than anonymized.
      const journey = await dataSource.query('SELECT count(*)::int AS n FROM journey.beauty_profiles WHERE user_id = $1', [
        customer.id,
      ]);
      expect(journey[0].n).toBe(0);

      // The booking survives: it is the professional's business record and the
      // ledger's referential ground, and it now describes an appointment
      // rather than a person.
      const booking = await dataSource.query('SELECT count(*)::int AS n FROM booking.bookings WHERE id = $1', [bookingId]);
      expect(booking[0].n).toBe(1);
    });

    it('removes an erased professional from the search projection, not only from PostgreSQL', async () => {
      // The failure mode worth a test: every database assertion passes while
      // `/v1/search` still serves the erased name.
      const proOwner = await seedUser(app, dataSource, '+989125010120', ['professional']);
      const professional = await seedProfessional(dataSource, proOwner.id, 'نام قابل شناسایی');

      await dataSource.query('UPDATE provider.professionals SET bio = $2 WHERE id = $1', [
        professional.id,
        'زندگی‌نامه شخصی',
      ]);
      await dataSource.query(
        `INSERT INTO search.provider_documents (professional_id, revision, display_name, bio, specialty_ids,
            specialty_names, verification_status, is_deleted, services, source_updated_at)
         VALUES ($1, 1, 'نام قابل شناسایی', 'زندگی‌نامه شخصی', '{}', '{}', 'unverified', false, '[]'::jsonb, now())
         ON CONFLICT (professional_id) DO NOTHING`,
        [professional.id],
      );

      const created = await request(app.getHttpServer())
        .post('/api/v1/privacy/deletion')
        .set('Authorization', `Bearer ${await tokenFor(proOwner.id)}`)
        .send({ confirm: 'DELETE' })
        .expect(202);
      await dataSource.query(`UPDATE privacy.data_requests SET execute_after = now() - interval '1 hour' WHERE id = $1`, [
        created.body.data.id,
      ]);

      await sweep.runOnce();
      // The projection is updated by the ProfessionalUpdated consumer, so the
      // outbox has to be drained — which is the point: erasure emits the event
      // its own domain already publishes rather than writing to another
      // module's table.
      await drainUntilQuiet();

      const doc = await dataSource.query(
        'SELECT display_name, bio, is_deleted FROM search.provider_documents WHERE professional_id = $1',
        [professional.id],
      );
      expect(doc[0].display_name).not.toBe('نام قابل شناسایی');
      expect(doc[0].bio).toBeNull();
      expect(doc[0].is_deleted).toBe(true);
    });

    it('leaves the append-only ledger untouched, and says so in the compliance record', async () => {
      const user = await seedUser(app, dataSource, '+989125010130');
      const created = await request(app.getHttpServer())
        .post('/api/v1/privacy/deletion')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ confirm: 'DELETE' })
        .expect(202);
      await dataSource.query(`UPDATE privacy.data_requests SET execute_after = now() - interval '1 hour' WHERE id = $1`, [
        created.body.data.id,
      ]);

      await sweep.runOnce();

      const row = await dataSource.query('SELECT status, outcome FROM privacy.data_requests WHERE id = $1', [
        created.body.data.id,
      ]);
      expect(row[0].status).toBe('completed');

      const financial = row[0].outcome.modules.find((m: { module: string }) => m.module === 'financial');
      expect(financial.anonymized).toBe(0);
      expect(financial.deleted).toBe(0);
      expect(financial.retained.map((r: { table: string }) => r.table)).toContain('financial.ledger_entries');
    });

    it('the compliance record survives the erasure and carries no content', async () => {
      const user = await seedUser(app, dataSource, '+989125010140');
      const created = await request(app.getHttpServer())
        .post('/api/v1/privacy/deletion')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ confirm: 'DELETE' })
        .expect(202);
      await dataSource.query(`UPDATE privacy.data_requests SET execute_after = now() - interval '1 hour' WHERE id = $1`, [
        created.body.data.id,
      ]);
      await sweep.runOnce();

      const rows = await dataSource.query('SELECT * FROM privacy.data_requests WHERE id = $1', [created.body.data.id]);
      // The row proving the platform honoured the request must not itself be a
      // surviving copy of what the request destroyed.
      expect(JSON.stringify(rows[0])).not.toContain(user.phone);
    });

    it('a stored export is destroyed by the subject’s own erasure', async () => {
      const user = await seedUser(app, dataSource, '+989125010150');
      const exportRequest = await request(app.getHttpServer())
        .post('/api/v1/privacy/export')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(202);
      await sweep.runOnce();

      const before = await dataSource.query('SELECT count(*)::int AS n FROM privacy.export_payloads WHERE request_id = $1', [
        exportRequest.body.data.id,
      ]);
      expect(before[0].n).toBe(1);

      const deletion = await request(app.getHttpServer())
        .post('/api/v1/privacy/deletion')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ confirm: 'DELETE' })
        .expect(202);
      await dataSource.query(`UPDATE privacy.data_requests SET execute_after = now() - interval '1 hour' WHERE id = $1`, [
        deletion.body.data.id,
      ]);
      await sweep.runOnce();

      // A subject who asked to be forgotten must not leave a complete,
      // downloadable copy of their data behind because they exported it last
      // week.
      const after = await dataSource.query('SELECT count(*)::int AS n FROM privacy.export_payloads WHERE request_id = $1', [
        exportRequest.body.data.id,
      ]);
      expect(after[0].n).toBe(0);
    });

    it('two sweeps racing execute one erasure', async () => {
      const user = await seedUser(app, dataSource, '+989125010160');
      const created = await request(app.getHttpServer())
        .post('/api/v1/privacy/deletion')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ confirm: 'DELETE' })
        .expect(202);
      await dataSource.query(`UPDATE privacy.data_requests SET execute_after = now() - interval '1 hour' WHERE id = $1`, [
        created.body.data.id,
      ]);

      // A multi-instance deployment is two of these running at once. The status
      // CAS is what makes the loser a no-op rather than a second erasure.
      const results = await Promise.all([
        privacy.executeErasure(created.body.data.id),
        privacy.executeErasure(created.body.data.id),
      ]);
      expect(results.filter((r) => r !== null)).toHaveLength(1);

      const events = await dataSource.query(
        `SELECT count(*)::int AS n FROM privacy.outbox_events WHERE event_type = 'DataErasureCompleted' AND aggregate_id = $1`,
        [created.body.data.id],
      );
      expect(events[0].n).toBe(1);
    });

    it('reclaims a request abandoned mid-flight instead of stranding it forever', async () => {
      const user = await seedUser(app, dataSource, '+989125010170');
      const created = await request(app.getHttpServer())
        .post('/api/v1/privacy/export')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(202);

      // What a process that died between the claim and the work leaves behind.
      await dataSource.query(
        `UPDATE privacy.data_requests SET status = 'processing', updated_at = now() - interval '1 hour' WHERE id = $1`,
        [created.body.data.id],
      );

      const result = await sweep.runOnce();
      expect(result.reclaimed).toBe(1);
      // Reclaimed AND completed in the same pass: the sweep reclaims before it
      // looks for pending work, which is the whole reason for that ordering.
      expect(result.exportsGenerated).toBe(1);
    });
  });

  // =====================================================================
  // Events, notifications, and the administrative surface
  // =====================================================================

  describe('events and notifications', () => {
    it('tells the subject the deletion date while the window is still open', async () => {
      const user = await seedUser(app, dataSource, '+989125010180');
      await request(app.getHttpServer())
        .post('/api/v1/privacy/deletion')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ confirm: 'DELETE' })
        .expect(202);

      await drainUntilQuiet();

      const notifications = await dataSource.query(
        `SELECT template_key, category, payload FROM notification.notifications WHERE user_id = $1`,
        [user.id],
      );
      expect(notifications).toHaveLength(1);
      expect(notifications[0].template_key).toBe('privacy_erasure_requested');
      expect(notifications[0].category).toBe('privacy');
      // The message has to carry the deadline, or the grace window exists and
      // nobody knows about it.
      expect(notifications[0].payload.executeAfterDate).toBeTruthy();
    });

    it('a user cannot switch privacy notifications off', async () => {
      const user = await seedUser(app, dataSource, '+989125010190');
      // Enforced by a CHECK constraint rather than by the preference service,
      // so a bug in the update path cannot suppress the one message the grace
      // window depends on.
      await expect(
        dataSource.query(
          `INSERT INTO notification.preferences (id, user_id, category, enabled) VALUES ($1, $2, 'privacy', false)`,
          [uuidv7(), user.id],
        ),
      ).rejects.toThrow(/ck_preferences_mandatory_always_enabled/);
    });

    it('the erasure events carry no phone number and no document', async () => {
      const user = await seedUser(app, dataSource, '+989125010200');
      const created = await request(app.getHttpServer())
        .post('/api/v1/privacy/deletion')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ confirm: 'DELETE' })
        .expect(202);
      await dataSource.query(`UPDATE privacy.data_requests SET execute_after = now() - interval '1 hour' WHERE id = $1`, [
        created.body.data.id,
      ]);
      await sweep.runOnce();

      const events = await dataSource.query(
        `SELECT event_type, payload FROM privacy.outbox_events WHERE aggregate_id = $1`,
        [created.body.data.id],
      );
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(user.phone);
      expect(events.map((e: { event_type: string }) => e.event_type).sort()).toEqual([
        'DataErasureCompleted',
        'DataErasureRequested',
      ]);
    });

    it('records the request and the execution in the administrative audit log', async () => {
      const user = await seedUser(app, dataSource, '+989125010210');
      const created = await request(app.getHttpServer())
        .post('/api/v1/privacy/deletion')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ confirm: 'DELETE' })
        .expect(202);
      await dataSource.query(`UPDATE privacy.data_requests SET execute_after = now() - interval '1 hour' WHERE id = $1`, [
        created.body.data.id,
      ]);
      await sweep.runOnce();

      // Filtered by actor rather than counted: `admin.admin_audit_log` is
      // append-only under its own role and the suite cannot truncate it.
      const rows = await dataSource.query(
        `SELECT action FROM admin.admin_audit_log WHERE actor_user_id = $1 ORDER BY created_at`,
        [user.id],
      );
      expect(rows.map((r: { action: string }) => r.action)).toEqual([
        'privacy.erasure_requested',
        'privacy.erasure_executed',
      ]);
    });
  });

  describe('the administrative surface', () => {
    it('lists requests for an operator, and never a payload', async () => {
      const user = await seedUser(app, dataSource, '+989125010220');
      const operator = await seedUser(app, dataSource, '+989125010221');
      await bootstrapRole(operator.id, 'platform_operator');

      await request(app.getHttpServer())
        .post('/api/v1/privacy/export')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(202);
      await sweep.runOnce();

      const listed = await request(app.getHttpServer())
        .get('/api/v1/admin/privacy/requests')
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .expect(200);

      expect(listed.body.data).toHaveLength(1);
      expect(listed.body.data[0].status).toBe('ready');
      // Status and timing only. The payload is not on the row this route
      // reads, which is why it is in a separate table.
      const serialized = JSON.stringify(listed.body.data);
      expect(serialized).not.toContain('document');
      expect(serialized).not.toContain(user.phone);
    });

    it('a customer reaches no admin privacy route', async () => {
      const user = await seedUser(app, dataSource, '+989125010230');
      await request(app.getHttpServer())
        .get('/api/v1/admin/privacy/requests')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(403);
    });

    it('an operator cannot download somebody else’s export', async () => {
      // Phase E's security note, unqualified: "no admin route may ever
      // download another user's export file". Asserted from an authenticated
      // PRIVILEGED session, because that is the caller who could plausibly
      // have been given the ability.
      const user = await seedUser(app, dataSource, '+989125010240');
      const operator = await seedUser(app, dataSource, '+989125010241');
      await bootstrapRole(operator.id, 'platform_operator');

      const created = await request(app.getHttpServer())
        .post('/api/v1/privacy/export')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(202);
      await sweep.runOnce();

      await request(app.getHttpServer())
        .get(`/api/v1/privacy/export/${created.body.data.id}/download`)
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .expect(404);
    });

    it('there is no administrative route that cancels somebody’s erasure', async () => {
      const user = await seedUser(app, dataSource, '+989125010250');
      const operator = await seedUser(app, dataSource, '+989125010251');
      await bootstrapRole(operator.id, 'platform_operator');

      const created = await request(app.getHttpServer())
        .post('/api/v1/privacy/deletion')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ confirm: 'DELETE' })
        .expect(202);

      // The subject's own route, reached with a privileged session. It is
      // scoped by subject, so the operator's own id finds nothing — an
      // operator who can cancel a deletion can silently keep an account its
      // owner asked to be rid of.
      await request(app.getHttpServer())
        .post(`/api/v1/privacy/deletion/${created.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .expect(404);

      const row = await dataSource.query('SELECT status FROM privacy.data_requests WHERE id = $1', [
        created.body.data.id,
      ]);
      expect(row[0].status).toBe('pending');
    });

    it('an unauthenticated caller reaches nothing', async () => {
      await request(app.getHttpServer()).post('/api/v1/privacy/export').expect(401);
      await request(app.getHttpServer()).get('/api/v1/privacy/requests').expect(401);
      await request(app.getHttpServer()).post('/api/v1/privacy/deletion').send({ confirm: 'DELETE' }).expect(401);
    });

    it('requires an exact typed confirmation to open a deletion', async () => {
      const user = await seedUser(app, dataSource, '+989125010260');
      await request(app.getHttpServer())
        .post('/api/v1/privacy/deletion')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({})
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/privacy/deletion')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ confirm: 'delete' })
        .expect(400);

      const rows = await dataSource.query('SELECT count(*)::int AS n FROM privacy.data_requests WHERE subject_user_id = $1', [
        user.id,
      ]);
      expect(rows[0].n).toBe(0);
    });
  });
});
