import { INestApplication } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, evaluateCoverage } from '@beauclick/subject-data';
import { OrderService } from '@beauclick/commerce';
import {
  BookingCollectionPolicyService,
  BookingOutcomePolicyResolutionService,
  BookingOutcomePolicyService,
  CustomerPolicyCopyService,
  LegalEvidenceService,
  OutcomePolicyAssignmentService,
  OutcomePolicyAssignmentUnavailableException,
} from '@beauclick/commercial-policy';
import {
  BookingOutcomeAcceptanceV1,
  BookingOutcomePolicyVersionTermsV1,
  BookingOutcomeSelectionV1,
} from '@beauclick/commercial-policy-contract';

import {
  PgTestApp,
  SeededUser,
  createPgTestApp,
  futureSlotTime,
  requiredPgEnv,
  resetDatabase,
  seedBusiness,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

const describePg = requiredPgEnv() !== null ? describe : describe.skip;

const SELECTIONS = 'commercial.seller_outcome_policy_assignments';
const TERMS = 'commerce.order_outcome_terms';
const SCHEDULES = 'commerce.order_payment_schedules';
const AUDIT_TARGET = 'commercial_outcome_policy_assignment';
const UNSELLABLE = 'SERVICE_UNAVAILABLE_FOR_SALE';
const SELECTION_REFUSED = 'outcome_policy_assignment_unavailable';

/**
 * Seller outcome selection, the order-level outcome snapshot and the
 * customer's acceptance against a real PostgreSQL server — V3.3 Story #159
 * (`#42b`), ADR-051 §2–§4, §10.
 *
 * ## Why the evidence is here
 *
 * Every guarantee this story makes lives in what pg-mem cannot run: the
 * membership trigger on the selection, the partial unique index, deferred
 * self-references, `FOR SHARE` locks, the two DEFERRABLE constraint triggers
 * that tie acceptance to terms at COMMIT, the transaction clock, and a real
 * ROLLBACK of a booking, an order and an audit row. So they are proved here,
 * with raw SQL attacking the invariants and the real HTTP surface exercising
 * the behaviour. The contract validators are proved fast, in
 * `booking-outcome-contract.spec.ts`; the scope boundary in
 * `story-159-boundary.spec.ts`.
 *
 * ## Values in this file are TEST values
 *
 * Every hour, minute, basis point and toman below is a suite fixture chosen to
 * exercise a rule. None is a product value, none is the owner-endorsed initial
 * publication value, and the Persian copy is a fixture, not approved text.
 */
describePg('booking outcome selection, snapshot and acceptance (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let orders: OrderService;
  let outcomes: BookingOutcomePolicyService;
  let copies: CustomerPolicyCopyService;
  let evidence: LegalEvidenceService;
  let collections: BookingCollectionPolicyService;
  let assignments: OutcomePolicyAssignmentService;
  let resolution: BookingOutcomePolicyResolutionService;
  let admin: SeededUser;
  let activeCopy: { copyKey: string; copyVersion: number } | null;

  let sequence = 0;
  let slotHour = 0;
  const nextKey = (prefix: string): string => `${prefix}-${(sequence += 1)}-${Date.now() % 100000}`;
  const nextPhone = (): string => `+98912${String(1000000 + (sequence += 1)).slice(-7)}`;
  const server = () => app.getHttpServer();
  const auth = (user: SeededUser) => ({ Authorization: `Bearer ${user.accessToken}` });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    orders = app.get(OrderService);
    outcomes = app.get(BookingOutcomePolicyService);
    copies = app.get(CustomerPolicyCopyService);
    evidence = app.get(LegalEvidenceService);
    collections = app.get(BookingCollectionPolicyService);
    assignments = app.get(OutcomePolicyAssignmentService);
    resolution = app.get(BookingOutcomePolicyResolutionService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    admin = await seedUser(app, dataSource, nextPhone(), ['administrator']);
    activeCopy = null;
  });

  // =========================================================================
  // Builders — the publication plane through #42a's real services
  // =========================================================================

  /** Suite fixture terms. Not product values. */
  const terms = (overrides: Partial<BookingOutcomePolicyVersionTermsV1> = {}): BookingOutcomePolicyVersionTermsV1 => ({
    contractVersion: 1,
    cutoffHoursAllowed: [6, 12, 48],
    lateRetentionOptions: [{ kind: 'none' }, { kind: 'percentage_of_collected', basisPoints: 2_500 }, { kind: 'full_collected' }],
    noShowGraceMinutesAllowed: [5, 10, 30],
    noShowRetentionOptions: [{ kind: 'none' }, { kind: 'fixed_toman', amountToman: 40_000 }],
    rescheduleFreeCountBeforeCutoff: 1,
    disputeWindowHours: 36,
    bodilyHarmWindowHours: 96,
    appealWindowHours: 48,
    caseFileRetentionDays: null,
    legalCap: null,
    ...overrides,
  });

  const SELECTION: BookingOutcomeSelectionV1 = {
    cutoffHours: 12,
    lateCancellationRetention: { kind: 'percentage_of_collected', basisPoints: 2_500 },
    noShowGraceMinutes: 10,
    noShowRetention: { kind: 'fixed_toman', amountToman: 40_000 },
  };

  async function publishedOutcome(
    t = terms(),
    options: { key?: string; legalEvidenceKey?: string | null; activationEndsAt?: Date | null } = {},
  ): Promise<{ key: string; version: number }> {
    const key = options.key ?? nextKey('op');
    await outcomes.createPolicy(admin.id, key, `${key} display`, 'suite setup');
    return publishNextVersion(key, t, options.legalEvidenceKey ?? null, options.activationEndsAt ?? null);
  }

  async function publishNextVersion(
    key: string,
    t = terms(),
    legalEvidenceKey: string | null = null,
    activationEndsAt: Date | null = null,
  ): Promise<{ key: string; version: number }> {
    const drafted = await outcomes.createVersionDraft(
      admin.id,
      { policyKey: key, terms: t, legalEvidenceKey, activationEndsAt },
      'suite setup',
    );
    await outcomes.publishVersion(admin.id, key, drafted.version.version, 'suite setup');
    return { key, version: drafted.version.version };
  }

  async function publishedCopy(body = 'متن نمونهٔ سوئیت — نه متن حقوقی تأییدشده'): Promise<{ copyKey: string; copyVersion: number }> {
    const copyKey = nextKey('cc');
    await copies.createCopy(admin.id, copyKey, 'suite copy', 'suite setup');
    const drafted = await copies.createVersionDraft(
      admin.id,
      { copyKey, terms: { contractVersion: 1, locale: 'fa-IR', body }, activationEndsAt: null },
      'suite setup',
    );
    await copies.publishVersion(admin.id, copyKey, drafted.version, 'suite setup');
    return { copyKey, copyVersion: drafted.version };
  }

  async function ensureCopy(): Promise<{ copyKey: string; copyVersion: number }> {
    if (!activeCopy) activeCopy = await publishedCopy();
    return activeCopy;
  }

  // =========================================================================
  // Sellers, owners and workspace references
  // =========================================================================

  interface Seller {
    owner: SeededUser;
    workspaceRef: string;
    partyType: 'professional' | 'business';
    partyId: string;
    professionalId: string;
    serviceId: string;
  }

  /** The references a client can hold, obtained the only way a client can: from #69's surface. */
  async function workspaceRefsFor(user: SeededUser): Promise<string[]> {
    const response = await request(server()).get('/api/v1/me/subscriptions').set(auth(user)).expect(200);
    return (response.body.data.items as Array<{ workspaceRef: string }>).map((item) => item.workspaceRef);
  }

  async function professionalSeller(priceToman = 200_000): Promise<Seller> {
    const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'متخصص آزمون', priceToman);
    return {
      owner,
      workspaceRef: (await workspaceRefsFor(owner))[0],
      partyType: 'professional',
      partyId: professional.id,
      professionalId: professional.id,
      serviceId: professional.serviceId,
    };
  }

  /** A business whose selling professional is active staff: the BUSINESS is the seller party. */
  async function businessSeller(): Promise<Seller & { staff: SeededUser }> {
    const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'business']);
    const business = await seedBusiness(dataSource, owner.id, 'کسب‌وکار آزمون');
    const staff = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
    const professional = await seedProfessional(dataSource, staff.id, 'متخصص وابسته', 200_000);
    await dataSource.query(
      `INSERT INTO business.business_staff (id, business_id, user_id, professional_id, role, status, invited_by)
       VALUES ($1, $2, $3, $4, 'staff', 'active', $5)`,
      [uuidv7(), business.id, staff.id, professional.id, owner.id],
    );
    return {
      owner,
      staff,
      workspaceRef: (await workspaceRefsFor(owner))[0],
      partyType: 'business',
      partyId: business.id,
      professionalId: professional.id,
      serviceId: professional.serviceId,
    };
  }

  const select = (seller: Seller, policyKey: string, selection: BookingOutcomeSelectionV1 = SELECTION, reason = 'suite choice') =>
    assignments.assign(seller.owner.id, { workspaceRef: seller.workspaceRef, policyKey, selection, reason });

  const putSelection = (user: SeededUser, workspaceRef: string, body: Record<string, unknown>) =>
    request(server()).put(`/api/v1/me/outcome-policy-assignments/${encodeURIComponent(workspaceRef)}`).set(auth(user)).send(body);

  /** A seller fully governed: a published policy, the platform copy, and a selection inside it. */
  async function governed(seller: Seller, t = terms(), selection = SELECTION): Promise<BookingOutcomeAcceptanceV1> {
    const policy = await publishedOutcome(t);
    const copy = await ensureCopy();
    await select(seller, policy.key, selection);
    return { policyKey: policy.key, policyVersion: policy.version, copyKey: copy.copyKey, copyVersion: copy.copyVersion };
  }

  // =========================================================================
  // Checkout and disclosure through the real HTTP surface
  // =========================================================================

  interface Prepared {
    customer: SeededUser;
    slotId: string;
    startsAt: Date;
  }

  async function prepareBooking(seller: Seller): Promise<Prepared> {
    const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const startsAt = futureSlotTime(24 + (slotHour += 1));
    const slotId = await seedSlot(dataSource, seller.professionalId, seller.serviceId, startsAt);
    return { customer, slotId, startsAt };
  }

  function postCheckout(seller: Seller, prepared: Prepared, acceptedPolicy?: unknown, idempotencyKey?: string): request.Test {
    const req = request(server()).post('/api/v1/bookings').set(auth(prepared.customer));
    if (idempotencyKey) req.set('Idempotency-Key', idempotencyKey);
    return req.send({
      professionalId: seller.professionalId,
      slotId: prepared.slotId,
      serviceId: seller.serviceId,
      ...(acceptedPolicy === undefined ? {} : { acceptedPolicy }),
    });
  }

  /** A checkout on a fresh slot. Awaitable, with supertest's `.expect(status)` for the common case. */
  function checkout(
    seller: Seller,
    acceptedPolicy?: unknown,
  ): Promise<request.Response> & { expect(status: number): Promise<request.Response> } {
    const pending = (async () => postCheckout(seller, await prepareBooking(seller), acceptedPolicy))();
    return Object.assign(pending, {
      expect: async (status: number) => {
        const response = await pending;
        expect({ status: response.status, body: response.status === status ? undefined : response.body }).toEqual({ status, body: undefined });
        return response;
      },
    });
  }

  function disclose(seller: Seller, prepared: Prepared, extra: Record<string, string> = {}): request.Test {
    return request(server())
      .get('/api/v1/checkout/disclosure')
      .query({ professionalId: seller.professionalId, slotId: prepared.slotId, serviceId: seller.serviceId, ...extra })
      .set(auth(prepared.customer));
  }

  const refusal = (response: request.Response) => ({
    status: response.status,
    code: response.body?.error?.code,
    message: response.body?.error?.message,
  });

  const counts = async (): Promise<Record<string, number>> =>
    (
      await dataSource.query(
        `SELECT (SELECT count(*) FROM booking.bookings)::int AS bookings,
                (SELECT count(*) FROM commerce.orders)::int AS orders,
                (SELECT count(*) FROM ${TERMS})::int AS terms,
                (SELECT count(*) FROM ${SCHEDULES} WHERE policy_accepted_at IS NOT NULL)::int AS accepted,
                (SELECT count(*) FROM commerce.outbox_events)::int AS outbox,
                (SELECT count(*) FROM ${SELECTIONS})::int AS selections`,
      )
    )[0];

  const termsRow = async (orderId: string): Promise<Record<string, unknown> | undefined> =>
    (await dataSource.query(`SELECT * FROM ${TERMS} WHERE order_id = $1`, [orderId]))[0];

  const scheduleRow = async (orderId: string): Promise<Record<string, unknown>> =>
    (await dataSource.query(`SELECT * FROM ${SCHEDULES} WHERE order_id = $1`, [orderId]))[0];

  const selectionRows = (partyId: string): Promise<Array<Record<string, unknown>>> =>
    dataSource.query(`SELECT * FROM ${SELECTIONS} WHERE seller_party_id = $1 ORDER BY assigned_at, id`, [partyId]);

  const auditFor = (partyId: string): Promise<Array<Record<string, unknown>>> =>
    dataSource.query(
      `SELECT l.* FROM admin.admin_audit_log l
         JOIN ${SELECTIONS} a ON a.id::text = l.target_id
        WHERE l.target_type = $1 AND a.seller_party_id = $2
        ORDER BY l.created_at, l.id`,
      [AUDIT_TARGET, partyId],
    );

  const auditWithReason = (reason: string): Promise<Array<{ action: string }>> =>
    dataSource.query(`SELECT action FROM admin.admin_audit_log WHERE reason = $1`, [reason]);

  /** Enrols a party in a pay-at-venue COLLECTION policy (#104's table, placed directly as #115's suite does). */
  async function payAtVenue(seller: Seller): Promise<void> {
    const key = nextKey('pv');
    await collections.createPolicy(admin.id, key, `${key} display`, 'suite setup');
    const drafted = await collections.createVersionDraft(
      admin.id,
      { policyKey: key, terms: { contractVersion: 1, collectionMode: 'pay_at_venue', deposit: { kind: 'none' } }, activationEndsAt: null },
      'suite setup',
    );
    await collections.publishVersion(admin.id, key, drafted.version, 'suite setup');
    await dataSource.query(
      `INSERT INTO commercial.seller_collection_policy_assignments (id, seller_party_type, seller_party_id, policy_key, assigned_by_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv7(), seller.partyType, seller.partyId, key, seller.owner.id],
    );
  }

  /** Runs `operation` while another connection holds `FOR UPDATE` on one row, and proves it WAITED. */
  async function provesWaitOn(lockSql: string, params: unknown[], operation: () => Promise<unknown>): Promise<unknown> {
    const runner: QueryRunner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const locked = await runner.query(lockSql, params);
      expect(locked.length).toBe(1);
      let settled = false;
      const pending = operation().finally(() => {
        settled = true;
      });
      pending.catch(() => undefined);
      await sleep(600);
      expect(settled).toBe(false);
      await runner.rollbackTransaction();
      return await pending;
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
  }

  // =========================================================================
  // §1. Schema and ADR-027 dispositions
  // =========================================================================

  describe('§1 schema and dispositions', () => {
    it('creates the selection and terms tables, with the deferred acceptance ⇔ terms triggers', async () => {
      const tables = await dataSource.query(
        `SELECT schemaname || '.' || tablename AS t FROM pg_tables
          WHERE (schemaname, tablename) IN (('commercial','seller_outcome_policy_assignments'),('commerce','order_outcome_terms'))
          ORDER BY 1`,
      );
      expect(tables.map((r: { t: string }) => r.t)).toEqual([TERMS, SELECTIONS]);

      const triggers: Array<{ tgname: string; tgdeferrable: boolean; tginitdeferred: boolean }> = await dataSource.query(
        `SELECT t.tgname, t.tgdeferrable, t.tginitdeferred FROM pg_trigger t
          WHERE NOT t.tgisinternal AND t.tgname IN
            ('tg_oot_integrity','tg_oot_append_only','tg_oot_requires_acceptance','tg_ops_acceptance_requires_outcome_terms',
             'tg_sopa_immutable','tg_sopa_selection_within_active_version')
          ORDER BY t.tgname`,
      );
      expect(triggers).toEqual([
        { tgname: 'tg_oot_append_only', tgdeferrable: false, tginitdeferred: false },
        { tgname: 'tg_oot_integrity', tgdeferrable: false, tginitdeferred: false },
        { tgname: 'tg_oot_requires_acceptance', tgdeferrable: true, tginitdeferred: true },
        { tgname: 'tg_ops_acceptance_requires_outcome_terms', tgdeferrable: true, tginitdeferred: true },
        { tgname: 'tg_sopa_immutable', tgdeferrable: false, tginitdeferred: false },
        { tgname: 'tg_sopa_selection_within_active_version', tgdeferrable: false, tginitdeferred: false },
      ]);
    });

    it('leaves the schedule untouched: same columns, same immutability trigger', async () => {
      const columns = await dataSource.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'commerce' AND table_name = 'order_payment_schedules' ORDER BY ordinal_position`,
      );
      expect(columns.map((c: { column_name: string }) => c.column_name)).toEqual([
        'order_id',
        'collection_mode',
        'service_total_toman',
        'platform_collectible_toman',
        'venue_balance_toman',
        'policy_key',
        'policy_version',
        'policy_accepted_at',
        'contract_version',
        'created_at',
      ]);
      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'tg_order_payment_schedules_immutable' AND NOT tgisinternal`,
      );
      expect(n).toBe(1);
    });

    it('claims the selection `retained` and the terms `subject_data`, and the coverage check agrees', async () => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const claims = contracts.flatMap((contract) => contract.tables);
      expect(claims.find((c) => c.table === SELECTIONS)?.disposition).toBe('retained');
      // Pinned explicitly: the terms carry no `_user_id` column, so the
      // heuristic cannot see the subject; the subject is reached through the order.
      expect(claims.find((c) => c.table === TERMS)?.disposition).toBe('subject_data');

      const rows = await dataSource.query(
        `SELECT t.schemaname AS schema, t.tablename AS name,
                array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
           FROM pg_tables t
           JOIN information_schema.columns c ON c.table_schema = t.schemaname AND c.table_name = t.tablename
          WHERE (t.schemaname, t.tablename) IN (('commercial','seller_outcome_policy_assignments'),('commerce','order_outcome_terms'))
          GROUP BY t.schemaname, t.tablename`,
      );
      expect(rows).toHaveLength(2);
      // Only these two tables are offered to the check, so every other
      // module's claim reads as absent here; the verdict that matters is the
      // one about #159's own tables.
      const ours = evaluateCoverage(rows, contracts).violations.filter((v) => v.table === SELECTIONS || v.table === TERMS);
      expect(ours).toEqual([]);
    });
  });

  // =========================================================================
  // §2. Seller selection inside the published ranges
  // =========================================================================

  describe('§2 selection', () => {
    it('lists each assignable key with its allowed members only, in two statements however many keys exist', async () => {
      const live = await publishedOutcome();
      const drafted = nextKey('dr');
      await outcomes.createPolicy(admin.id, drafted, 'draft only', 'suite setup');
      await outcomes.createVersionDraft(admin.id, { policyKey: drafted, terms: terms(), legalEvidenceKey: null, activationEndsAt: null }, 'suite setup');
      const retired = await publishedOutcome();
      await outcomes.retireVersion(admin.id, retired.key, retired.version, 'suite setup');

      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const listed = await request(server()).get('/api/v1/me/outcome-policies').set(auth(customer)).expect(200);
      expect(listed.body.data).toEqual({
        items: [
          {
            policyKey: live.key,
            displayName: `${live.key} display`,
            allowed: {
              cutoffHours: [6, 12, 48],
              lateCancellationRetention: [{ kind: 'none' }, { kind: 'percentage_of_collected', basisPoints: 2_500 }, { kind: 'full_collected' }],
              noShowGraceMinutes: [5, 10, 30],
              noShowRetention: [{ kind: 'none' }, { kind: 'fixed_toman', amountToman: 40_000 }],
            },
          },
        ],
      });

      const one = await countStatements(() => assignments.assignablePolicies());
      await publishedOutcome();
      await publishedOutcome();
      const three = await countStatements(() => assignments.assignablePolicies());
      expect({ one, three }).toEqual({ one: 2, three: 2 });

      await request(server()).get('/api/v1/me/outcome-policies').query({ page: '1' }).set(auth(customer)).expect(400);
    });

    it('records an owner selection with one audit row carrying no reference or party id', async () => {
      const seller = await professionalSeller();
      const policy = await publishedOutcome();

      const response = await putSelection(seller.owner, seller.workspaceRef, { policyKey: policy.key, ...SELECTION, reason: 'مالک انتخاب کرد' }).expect(200);
      expect(response.body.data.assignment).toMatchObject({ policyKey: policy.key, selection: SELECTION, resolvable: true });

      const rows = await selectionRows(seller.partyId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        policy_key: policy.key,
        cutoff_hours: 12,
        late_retention_kind: 'percentage_of_collected',
        late_retention_basis_points: 2_500,
        grace_minutes: 10,
        no_show_retention_kind: 'fixed_toman',
        assigned_by_user_id: seller.owner.id,
        superseded_at: null,
      });

      const audit = await auditFor(seller.partyId);
      expect(audit.map((a) => a.action)).toEqual(['commercial.outcome_policy_assigned']);
      const serialised = JSON.stringify(audit[0]);
      expect(serialised).not.toContain(seller.workspaceRef);
      expect(serialised).not.toContain(seller.partyId);
      expect(serialised).toContain('"cutoffHours":12');

      const current = await request(server())
        .get(`/api/v1/me/outcome-policy-assignments/${encodeURIComponent(seller.workspaceRef)}`)
        .set(auth(seller.owner))
        .expect(200);
      expect(current.body.data.assignment.selection).toEqual(SELECTION);

      const unenrolled = await professionalSeller();
      const none = await request(server())
        .get(`/api/v1/me/outcome-policy-assignments/${encodeURIComponent(unenrolled.workspaceRef)}`)
        .set(auth(unenrolled.owner))
        .expect(200);
      expect(none.body.data).toEqual({ assignment: null });
    });

    it('accepts every published member at both ends of each set, and refuses everything outside with one body', async () => {
      const seller = await professionalSeller();
      const policy = await publishedOutcome();

      const accepted: BookingOutcomeSelectionV1[] = [
        { ...SELECTION, cutoffHours: 6 },
        { ...SELECTION, cutoffHours: 48 },
        { ...SELECTION, noShowGraceMinutes: 5 },
        { ...SELECTION, noShowGraceMinutes: 30 },
        { ...SELECTION, lateCancellationRetention: { kind: 'none' } },
        { ...SELECTION, lateCancellationRetention: { kind: 'full_collected' } },
        { ...SELECTION, noShowRetention: { kind: 'none' } },
      ];
      for (const selection of accepted) {
        await putSelection(seller.owner, seller.workspaceRef, { policyKey: policy.key, ...selection, reason: 'boundary' }).expect(200);
      }
      expect((await selectionRows(seller.partyId)).filter((r) => r.superseded_at === null)).toHaveLength(1);

      const before = await selectionRows(seller.partyId);
      const refused: Array<Record<string, unknown>> = [
        { ...SELECTION, cutoffHours: 7 },
        { ...SELECTION, cutoffHours: 0 },
        { ...SELECTION, noShowGraceMinutes: 11 },
        { ...SELECTION, lateCancellationRetention: { kind: 'fixed_toman', amountToman: 40_000 } },
        { ...SELECTION, lateCancellationRetention: { kind: 'percentage_of_collected', basisPoints: 2_501 } },
        { ...SELECTION, noShowRetention: { kind: 'percentage_of_collected', basisPoints: 2_500 } },
        { ...SELECTION, noShowRetention: { kind: 'none', amountToman: 40_000 } },
      ];
      const bodies = [];
      for (const selection of refused) {
        bodies.push(refusal(await putSelection(seller.owner, seller.workspaceRef, { policyKey: policy.key, ...selection, reason: 'outside' })));
      }
      bodies.push(refusal(await putSelection(seller.owner, seller.workspaceRef, { policyKey: 'noSuchKey', ...SELECTION, reason: 'outside' })));
      for (const body of bodies) expect(body).toEqual(bodies[0]);
      expect(bodies[0]).toMatchObject({ status: 409, code: SELECTION_REFUSED });
      expect(await selectionRows(seller.partyId)).toEqual(before);
      expect(await auditWithReason('outside')).toEqual([]);

      await putSelection(seller.owner, seller.workspaceRef, { policyKey: policy.key, ...SELECTION, reason: 'x', partyId: seller.partyId }).expect(400);
    });

    it('keeps a dual owner`s two workspaces isolated', async () => {
      const user = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional', 'business']);
      const professional = await seedProfessional(dataSource, user.id, 'متخصص دوگانه', 200_000);
      const business = await seedBusiness(dataSource, user.id, 'کسب‌وکار دوگانه');
      const refs = await workspaceRefsFor(user);
      expect(refs).toHaveLength(2);
      const policy = await publishedOutcome();

      await putSelection(user, refs[0], { policyKey: policy.key, ...SELECTION, reason: 'first' }).expect(200);
      const partyRows = await dataSource.query(`SELECT seller_party_type, seller_party_id FROM ${SELECTIONS}`);
      expect(partyRows).toHaveLength(1);
      expect([professional.id, business.id]).toContain(partyRows[0].seller_party_id);

      const other = await request(server())
        .get(`/api/v1/me/outcome-policy-assignments/${encodeURIComponent(refs[1])}`)
        .set(auth(user))
        .expect(200);
      expect(other.body.data).toEqual({ assignment: null });
    });

    it('refuses staff affiliation and every forged, stale, malformed or cross-user reference identically', async () => {
      const seller = await businessSeller();
      const policy = await publishedOutcome();
      const body = { policyKey: policy.key, ...SELECTION, reason: 'unauthorised' };

      // The affiliated professional owns only their own party: affiliation grants no business workspace.
      const staffRefs = await workspaceRefsFor(seller.staff);
      expect(staffRefs).toHaveLength(1);
      expect(staffRefs).not.toContain(seller.workspaceRef);

      const stale = await professionalSeller();
      await dataSource.query(`UPDATE provider.professionals SET deleted_at = now() WHERE id = $1`, [stale.partyId]);

      const cases = [
        await putSelection(seller.staff, seller.workspaceRef, body),
        await putSelection(seller.owner, `${seller.workspaceRef.slice(0, -2)}xx`, body),
        await putSelection(seller.owner, 'not-a-reference', body),
        await putSelection(stale.owner, stale.workspaceRef, body),
        await putSelection(seller.owner, staffRefs[0], body),
      ].map(refusal);
      for (const outcome of cases) expect(outcome).toEqual({ status: 409, code: SELECTION_REFUSED, message: cases[0].message });
      expect((await counts()).selections).toBe(0);
      expect(await auditWithReason('unauthorised')).toEqual([]);
    });

    it('pins the routes: 401 anonymous, 403 without the capability, the list open to any session', async () => {
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      for (const [method, path] of [
        ['get', '/api/v1/me/outcome-policies'],
        ['get', '/api/v1/me/outcome-policy-assignments/x'],
        ['put', '/api/v1/me/outcome-policy-assignments/x'],
        ['get', '/api/v1/checkout/disclosure'],
      ] as const) {
        await request(server())[method](path).expect(401);
      }
      await request(server()).get('/api/v1/me/outcome-policies').set(auth(customer)).expect(200);
      await putSelection(customer, 'x', { policyKey: 'k', ...SELECTION, reason: 'no capability' }).expect(403);
    });

    it('replays the same key and members without a row or an audit, and supersedes by compare-and-swap otherwise', async () => {
      const seller = await professionalSeller();
      const policy = await publishedOutcome();
      await select(seller, policy.key);
      await select(seller, policy.key, SELECTION, 'replay');
      expect(await selectionRows(seller.partyId)).toHaveLength(1);
      expect(await auditWithReason('replay')).toEqual([]);

      await select(seller, policy.key, { ...SELECTION, cutoffHours: 48 }, 'changed');
      const rows = await selectionRows(seller.partyId);
      expect(rows).toHaveLength(2);
      expect(rows[0].superseded_by_assignment_id).toBe(rows[1].id);
      expect(rows[1].superseded_at).toBeNull();
      expect((await auditFor(seller.partyId)).map((a) => a.action)).toEqual([
        'commercial.outcome_policy_assigned',
        'commercial.outcome_policy_assignment_superseded',
      ]);
    });

    it('treats the activation window as half-open: a version is not selectable at or after its end', async () => {
      const seller = await professionalSeller();
      const policy = await publishedOutcome(terms(), { activationEndsAt: new Date(Date.now() + 2_500) });
      await ensureCopy();
      await select(seller, policy.key);
      expect((await resolution.resolveForParty(dataSource.manager, 'professional', seller.partyId)).outcome).toBe('resolved');

      await sleep(3_000);
      await expect(select(seller, policy.key, { ...SELECTION, cutoffHours: 6 })).rejects.toBeInstanceOf(OutcomePolicyAssignmentUnavailableException);
      expect(await resolution.resolveForParty(dataSource.manager, 'professional', seller.partyId)).toEqual({
        outcome: 'unavailable',
        cause: 'no_active_version',
      });
    });

    it('makes the history immutable against raw SQL, and out-of-range selections unwritable', async () => {
      const seller = await professionalSeller();
      const policy = await publishedOutcome();
      await select(seller, policy.key);
      const [row] = await selectionRows(seller.partyId);

      const insert = (cutoff: number, assignedAt = 'now()') =>
        dataSource.query(
          `INSERT INTO ${SELECTIONS} (id, seller_party_type, seller_party_id, policy_key, cutoff_hours, late_retention_kind,
             grace_minutes, no_show_retention_kind, assigned_by_user_id, assigned_at)
           VALUES ($1, 'professional', $2, $3, $4, 'none', 5, 'none', $5, ${assignedAt})`,
          [uuidv7(), uuidv7(), policy.key, cutoff, seller.owner.id],
        );
      await expect(insert(7)).rejects.toThrow(/cutoff_hours is not a member of the active version/);
      await expect(
        dataSource.query(
          `INSERT INTO ${SELECTIONS} (id, seller_party_type, seller_party_id, policy_key, cutoff_hours, late_retention_kind,
             late_retention_amount_toman, grace_minutes, no_show_retention_kind, assigned_by_user_id)
           VALUES ($1, 'professional', $2, $3, 6, 'fixed_toman', 999, 5, 'none', $4)`,
          [uuidv7(), uuidv7(), policy.key, seller.owner.id],
        ),
      ).rejects.toThrow(/late-cancellation retention rule is not an option/);
      await expect(
        dataSource.query(
          `INSERT INTO ${SELECTIONS} (id, seller_party_type, seller_party_id, policy_key, cutoff_hours, late_retention_kind,
             grace_minutes, no_show_retention_kind, no_show_retention_basis_points, assigned_by_user_id)
           VALUES ($1, 'professional', $2, $3, 6, 'none', 5, 'percentage_of_collected', 2500, $4)`,
          [uuidv7(), uuidv7(), policy.key, seller.owner.id],
        ),
      ).rejects.toThrow(/no-show retention rule is not an option/);
      await expect(insert(6, "'2020-01-01'")).rejects.toThrow(/must be the database clock/);
      await expect(
        dataSource.query(
          `INSERT INTO ${SELECTIONS} (id, seller_party_type, seller_party_id, policy_key, cutoff_hours, late_retention_kind,
             grace_minutes, no_show_retention_kind, assigned_by_user_id)
           VALUES ($1, 'professional', $2, $3, 6, 'none', 5, 'none', $4)`,
          [uuidv7(), seller.partyId, policy.key, seller.owner.id],
        ),
      ).rejects.toThrow(/uq_sopa_one_current_per_party/);
      await expect(dataSource.query(`DELETE FROM ${SELECTIONS} WHERE id = $1`, [row.id])).rejects.toThrow(/superseded, never removed/);
      await expect(dataSource.query(`UPDATE ${SELECTIONS} SET cutoff_hours = 48 WHERE id = $1`, [row.id])).rejects.toThrow(/is immutable/);
      await expect(
        dataSource.query(`UPDATE ${SELECTIONS} SET late_retention_kind = 'percentage_of_collected', late_retention_basis_points = NULL WHERE id = $1`, [row.id]),
      ).rejects.toThrow(/ck_sopa_late_retention_shape|is immutable/);
    });

    it('lets two concurrent selections produce exactly one current row, and refuses the loser readably', async () => {
      const seller = await professionalSeller();
      const policy = await publishedOutcome();
      const results = await Promise.allSettled([
        select(seller, policy.key, { ...SELECTION, cutoffHours: 6 }, 'race a'),
        select(seller, policy.key, { ...SELECTION, cutoffHours: 48 }, 'race b'),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(OutcomePolicyAssignmentUnavailableException);
      }
      const rows = await selectionRows(seller.partyId);
      expect(rows.filter((r) => r.superseded_at === null)).toHaveLength(1);
      expect((await auditFor(seller.partyId)).length).toBe(rows.length);
    });

    it('holds FOR SHARE on the active version: a selection waits for a conflicting lock on it', async () => {
      const seller = await professionalSeller();
      const policy = await publishedOutcome();
      await provesWaitOn(
        `SELECT id FROM commercial.booking_outcome_policy_versions WHERE policy_key = $1 AND lifecycle_state = 'published' FOR UPDATE`,
        [policy.key],
        () => select(seller, policy.key),
      );
      expect(await selectionRows(seller.partyId)).toHaveLength(1);
    });

    it('rolls the audit row back with the selection when the transaction fails at commit', async () => {
      const seller = await professionalSeller();
      const policy = await publishedOutcome();
      await dataSource.query(
        `CREATE FUNCTION commercial.s159_planted_failure() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 's159 planted commit failure'; END $$`,
      );
      await dataSource.query(
        `CREATE CONSTRAINT TRIGGER tg_s159_planted AFTER INSERT ON ${SELECTIONS}
           DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commercial.s159_planted_failure()`,
      );
      try {
        await expect(select(seller, policy.key, SELECTION, 'planted rollback')).rejects.toThrow(/s159 planted commit failure/);
      } finally {
        await dataSource.query(`DROP TRIGGER tg_s159_planted ON ${SELECTIONS}`);
        await dataSource.query(`DROP FUNCTION commercial.s159_planted_failure()`);
      }
      expect(await selectionRows(seller.partyId)).toEqual([]);
      expect(await auditWithReason('planted rollback')).toEqual([]);
    });
  });

  // =========================================================================
  // §3. Resolution, re-ranging and the order reader's locks
  // =========================================================================

  describe('§3 resolution', () => {
    it('binds the key: a forward re-ranging fails governed checkouts closed until re-selection, and old snapshots stand', async () => {
      const seller = await professionalSeller();
      const acceptance = await governed(seller, terms(), { ...SELECTION, cutoffHours: 48 });
      const before = await checkout(seller, acceptance).expect(201);
      const oldOrderId = before.body.data.order.id;
      const oldTerms = await termsRow(oldOrderId);

      await outcomes.retireVersion(admin.id, acceptance.policyKey, acceptance.policyVersion, 'suite re-range');
      const next = await publishNextVersion(acceptance.policyKey, terms({ cutoffHoursAllowed: [6, 12] }));

      expect(await resolution.resolveForParty(dataSource.manager, 'professional', seller.partyId)).toEqual({
        outcome: 'unavailable',
        cause: 'member_not_allowed',
      });
      const view = await request(server())
        .get(`/api/v1/me/outcome-policy-assignments/${encodeURIComponent(seller.workspaceRef)}`)
        .set(auth(seller.owner))
        .expect(200);
      expect(view.body.data.assignment.resolvable).toBe(false);
      expect(refusal(await checkout(seller, { ...acceptance, policyVersion: next.version }))).toMatchObject({ status: 409, code: UNSELLABLE });

      await select(seller, acceptance.policyKey, { ...SELECTION, cutoffHours: 12 });
      const after = await checkout(seller, { ...acceptance, policyVersion: next.version }).expect(201);
      expect((await termsRow(after.body.data.order.id))?.policy_version).toBe(next.version);
      expect(await termsRow(oldOrderId)).toEqual(oldTerms);
      expect(oldTerms?.cutoff_hours).toBe(48);
    });

    it('is unavailable with no active copy, or with more than one, and never picks', async () => {
      const seller = await professionalSeller();
      const policy = await publishedOutcome();
      await select(seller, policy.key);
      expect(await resolution.resolveForParty(dataSource.manager, 'professional', seller.partyId)).toEqual({
        outcome: 'unavailable',
        cause: 'no_active_copy',
      });
      await publishedCopy('متن اول');
      await publishedCopy('متن دوم');
      expect(await resolution.resolveForParty(dataSource.manager, 'professional', seller.partyId)).toEqual({
        outcome: 'unavailable',
        cause: 'ambiguous_copy',
      });
      expect(refusal(await checkout(seller))).toMatchObject({ status: 409, code: UNSELLABLE });
    });

    it('holds FOR SHARE on the active outcome version: checkout waits for a conflicting lock on it', async () => {
      const seller = await professionalSeller();
      const acceptance = await governed(seller);
      const prepared = await prepareBooking(seller);
      const viaVersion = (await provesWaitOn(
        `SELECT id FROM commercial.booking_outcome_policy_versions WHERE policy_key = $1 AND version = $2 FOR UPDATE`,
        [acceptance.policyKey, acceptance.policyVersion],
        () => postCheckout(seller, prepared, acceptance).then((r) => r),
      )) as request.Response;
      expect(viaVersion.status).toBe(201);
    });

    it('holds FOR SHARE on the current selection and on the copy: checkout waits for a conflicting lock on either', async () => {
      const seller = await professionalSeller();
      const acceptance = await governed(seller);

      const first = await prepareBooking(seller);
      const viaSelection = (await provesWaitOn(
        `SELECT id FROM ${SELECTIONS} WHERE seller_party_id = $1 AND superseded_at IS NULL FOR UPDATE`,
        [seller.partyId],
        () => postCheckout(seller, first, acceptance).then((r) => r),
      )) as request.Response;
      expect(viaSelection.status).toBe(201);

      const second = await prepareBooking(seller);
      const viaCopy = (await provesWaitOn(
        `SELECT id FROM commercial.customer_policy_copy_versions WHERE copy_key = $1 AND version = $2 FOR UPDATE`,
        [acceptance.copyKey, acceptance.copyVersion],
        () => postCheckout(seller, second, acceptance).then((r) => r),
      )) as request.Response;
      expect(viaCopy.status).toBe(201);
    });
  });

  // =========================================================================
  // §4. The disclosure read
  // =========================================================================

  describe('§4 disclosure', () => {
    it('shows an unenrolled seller`s amounts with no outcome and no acceptance', async () => {
      const seller = await professionalSeller(180_000);
      const prepared = await prepareBooking(seller);
      const response = await disclose(seller, prepared).expect(200);
      expect(response.body.data).toEqual({
        sellerParty: { kind: 'professional', displayName: 'متخصص آزمون' },
        amounts: { serviceTotalToman: 180_000, platformCollectibleNowToman: 180_000, venueBalanceToman: 0 },
        slotStartsAt: prepared.startsAt.toISOString(),
        displayTimeZone: 'Asia/Tehran',
        acceptanceRequired: false,
        outcome: null,
        acceptance: null,
      });
    });

    it('shows the resolved terms, the exact copy and the object to echo, writing nothing', async () => {
      const seller = await businessSeller();
      const acceptance = await governed(seller);
      const prepared = await prepareBooking(seller);
      const before = await counts();
      const auditBefore = (await dataSource.query(`SELECT count(*)::int AS n FROM admin.admin_audit_log`))[0].n;

      const response = await disclose(seller, prepared).expect(200);
      const [copy] = await dataSource.query(
        `SELECT body, body_sha256, published_at FROM commercial.customer_policy_copy_versions WHERE copy_key = $1`,
        [acceptance.copyKey],
      );
      expect(response.body.data).toEqual({
        sellerParty: { kind: 'business', displayName: 'کسب‌وکار آزمون' },
        amounts: { serviceTotalToman: 200_000, platformCollectibleNowToman: 200_000, venueBalanceToman: 0 },
        slotStartsAt: prepared.startsAt.toISOString(),
        displayTimeZone: 'Asia/Tehran',
        acceptanceRequired: true,
        outcome: {
          cutoffHours: 12,
          cutoffInstant: new Date(prepared.startsAt.getTime() - 12 * 3_600_000).toISOString(),
          lateCancellationRetention: SELECTION.lateCancellationRetention,
          noShowGraceMinutes: 10,
          noShowRetention: SELECTION.noShowRetention,
          rescheduleFreeCountBeforeCutoff: 1,
          disputeWindowHours: 36,
          bodilyHarmWindowHours: 96,
          appealWindowHours: 48,
          copy: { locale: 'fa-IR', body: copy.body, bodySha256: copy.body_sha256, publishedAt: new Date(copy.published_at).toISOString() },
        },
        acceptance,
      });
      expect(await counts()).toEqual(before);
      expect((await dataSource.query(`SELECT count(*)::int AS n FROM admin.admin_audit_log`))[0].n).toBe(auditBefore);
    });

    it('never discloses the evidence reference, the cap or the case-file period', async () => {
      const seller = await professionalSeller();
      const evidenceKey = nextKey('ev');
      await evidence.record(
        admin.id,
        evidenceKey,
        { subject: 'retention_cap', referenceKind: 'internal_ticket', reference: 'S159-EVIDENCE-REF-CANARY', summary: 'suite attestation' },
        'suite setup',
      );
      const policy = await publishedOutcome(terms({ legalCap: { kind: 'percentage_of_collected', basisPoints: 5_000 }, caseFileRetentionDays: 30 }), {
        legalEvidenceKey: evidenceKey,
      });
      await ensureCopy();
      await select(seller, policy.key);
      const response = await disclose(seller, await prepareBooking(seller)).expect(200);
      const text = JSON.stringify(response.body);
      expect(text).not.toMatch(/S159-EVIDENCE-REF-CANARY|legalCap|legalEvidence|caseFileRetention|5000/);
    });

    it('refuses exactly what the checkout would refuse, with its own body, and rejects unknown query fields', async () => {
      const seller = await professionalSeller();
      const other = await professionalSeller();
      const prepared = await prepareBooking(seller);

      await disclose(seller, prepared, { extra: 'x' }).expect(400);
      await request(server())
        .get('/api/v1/checkout/disclosure')
        .query({ professionalId: seller.professionalId, slotId: prepared.slotId })
        .set(auth(prepared.customer))
        .expect(400);

      const foreignService = await request(server())
        .get('/api/v1/checkout/disclosure')
        .query({ professionalId: seller.professionalId, slotId: prepared.slotId, serviceId: other.serviceId })
        .set(auth(prepared.customer));
      const foreignSlot = await request(server())
        .get('/api/v1/checkout/disclosure')
        .query({ professionalId: other.professionalId, slotId: prepared.slotId, serviceId: other.serviceId })
        .set(auth(prepared.customer));
      // Enrolled, unresolvable (no copy) and collecting online.
      const policy = await publishedOutcome();
      await select(seller, policy.key);
      const unavailable = await disclose(seller, prepared);
      const checkoutRefusal = await checkout(seller);

      const bodies = [foreignService, foreignSlot, unavailable, checkoutRefusal].map(refusal);
      for (const body of bodies) expect(body).toEqual({ status: 409, code: UNSELLABLE, message: bodies[0].message });
    });
  });

  // =========================================================================
  // §5. Acceptance at checkout
  // =========================================================================

  describe('§5 acceptance at checkout', () => {
    it('snapshots the terms by value and records acceptance at the database transaction instant', async () => {
      const seller = await professionalSeller();
      const acceptance = await governed(seller);
      const [{ t0 }] = await dataSource.query(`SELECT clock_timestamp() AS t0`);
      const response = await checkout(seller, acceptance).expect(201);
      const [{ t1 }] = await dataSource.query(`SELECT clock_timestamp() AS t1`);
      const orderId = response.body.data.order.id;

      const row = await termsRow(orderId);
      expect(row).toMatchObject({
        seller_party_type: 'professional',
        seller_party_id: seller.partyId,
        policy_key: acceptance.policyKey,
        policy_version: acceptance.policyVersion,
        copy_key: acceptance.copyKey,
        copy_version: acceptance.copyVersion,
        cutoff_hours: 12,
        late_retention_kind: 'percentage_of_collected',
        late_retention_basis_points: 2_500,
        late_retention_amount_toman: null,
        grace_minutes: 10,
        no_show_retention_kind: 'fixed_toman',
        no_show_retention_basis_points: null,
        reschedule_free_count: 1,
        dispute_window_hours: 36,
        bodily_harm_window_hours: 96,
        appeal_window_hours: 48,
        case_file_retention_days: null,
        legal_cap_kind: null,
        legal_evidence_id: null,
        contract_version: 1,
      });
      expect(Number(row?.no_show_retention_amount_toman)).toBe(40_000);

      const schedule = await scheduleRow(orderId);
      const accepted = schedule.policy_accepted_at as Date;
      expect(accepted).toBeInstanceOf(Date);
      expect(accepted.getTime()).toBe((row?.resolved_at as Date).getTime());
      expect(accepted.getTime()).toBeGreaterThanOrEqual(new Date(t0).getTime());
      expect(accepted.getTime()).toBeLessThanOrEqual(new Date(t1).getTime());
      // Equal to the MICROSECOND, which only the same `now()` produces.
      const [{ same }] = await dataSource.query(
        `SELECT (s.policy_accepted_at = t.resolved_at) AS same FROM ${SCHEDULES} s JOIN ${TERMS} t USING (order_id) WHERE order_id = $1`,
        [orderId],
      );
      expect(same).toBe(true);
      const [order] = await dataSource.query(`SELECT seller_party_type, seller_party_id FROM commerce.orders WHERE id = $1`, [orderId]);
      expect(order).toEqual({ seller_party_type: row?.seller_party_type, seller_party_id: row?.seller_party_id });
    });

    it('records the server-resolved legal seller and the cap`s evidence reference when there is one', async () => {
      const seller = await businessSeller();
      const evidenceKey = nextKey('ev');
      await evidence.record(
        admin.id,
        evidenceKey,
        { subject: 'retention_cap', referenceKind: 'internal_ticket', reference: 'LEGAL-S159', summary: 'suite attestation' },
        'suite setup',
      );
      const policy = await publishedOutcome(terms({ legalCap: { kind: 'fixed_toman', amountToman: 50_000 } }), { legalEvidenceKey: evidenceKey });
      const copy = await ensureCopy();
      await select(seller, policy.key);
      const response = await checkout(seller, { policyKey: policy.key, policyVersion: policy.version, ...copy }).expect(201);
      const row = await termsRow(response.body.data.order.id);
      const [{ id: evidenceId }] = await dataSource.query(`SELECT id FROM commercial.legal_evidence_records WHERE evidence_key = $1`, [evidenceKey]);
      expect(row).toMatchObject({ seller_party_type: 'business', seller_party_id: seller.partyId, legal_cap_kind: 'fixed_toman', legal_evidence_id: evidenceId });
    });

    it('refuses an omitted, stale, mismatched or fabricated acceptance, writing nothing', async () => {
      const seller = await professionalSeller();
      const acceptance = await governed(seller);
      const before = await counts();
      const outcomes = [
        await checkout(seller),
        await checkout(seller, { ...acceptance, policyVersion: acceptance.policyVersion + 1 }),
        await checkout(seller, { ...acceptance, copyVersion: acceptance.copyVersion + 1 }),
        await checkout(seller, { ...acceptance, policyKey: 'fabricatedKey' }),
        await checkout(seller, { ...acceptance, copyKey: 'fabricatedCopy' }),
      ].map(refusal);
      for (const outcome of outcomes) expect(outcome).toEqual({ status: 409, code: UNSELLABLE, message: outcomes[0].message });
      expect(await counts()).toEqual(before);

      await checkout(seller, { ...acceptance, acceptedAt: new Date().toISOString() }).expect(400);
      await checkout(seller, { policyKey: acceptance.policyKey }).expect(400);
      expect(await counts()).toEqual(before);
    });

    it('keeps an unenrolled seller on today`s path, and refuses an acceptance sent to one', async () => {
      const seller = await professionalSeller();
      await ensureCopy();
      const before = await counts();
      expect(refusal(await checkout(seller, { policyKey: 'anyKey', policyVersion: 1, copyKey: 'anyCopy', copyVersion: 1 }))).toMatchObject({
        status: 409,
        code: UNSELLABLE,
      });
      expect(await counts()).toEqual(before);

      const response = await checkout(seller).expect(201);
      const orderId = response.body.data.order.id;
      expect(await termsRow(orderId)).toBeUndefined();
      expect((await scheduleRow(orderId)).policy_accepted_at).toBeNull();
    });

    it('lets a zero-collectible booking proceed with no terms when the enrolled seller is unresolvable', async () => {
      const seller = await professionalSeller();
      await payAtVenue(seller);
      const policy = await publishedOutcome();
      await select(seller, policy.key); // no copy published: unavailable
      const response = await checkout(seller).expect(201);
      const orderId = response.body.data.order.id;
      expect(await termsRow(orderId)).toBeUndefined();
      expect((await scheduleRow(orderId))).toMatchObject({ collection_mode: 'pay_at_venue', policy_accepted_at: null });
      expect(refusal(await checkout(seller, { policyKey: policy.key, policyVersion: 1, copyKey: 'x', copyVersion: 1 }))).toMatchObject({
        status: 409,
        code: UNSELLABLE,
      });
    });

    it('replays an idempotent checkout to the same order and one terms row', async () => {
      const seller = await professionalSeller();
      const acceptance = await governed(seller);
      const prepared = await prepareBooking(seller);
      const key = uuidv7();
      const first = await postCheckout(seller, prepared, acceptance, key).expect(201);
      const second = await postCheckout(seller, prepared, acceptance, key).expect(201);
      expect(second.body.data.order.id).toBe(first.body.data.order.id);
      expect((await counts()).terms).toBe(1);
    });

    it('rolls back the booking, the order, the terms and the acceptance together on a planted late failure', async () => {
      const seller = await professionalSeller();
      const acceptance = await governed(seller);
      const before = await counts();
      await dataSource.query(
        `CREATE FUNCTION commerce.s159_planted_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 's159 planted outbox failure'; END $$`,
      );
      await dataSource.query(
        `CREATE TRIGGER tg_s159_planted_outbox BEFORE INSERT ON commerce.outbox_events
           FOR EACH ROW EXECUTE FUNCTION commerce.s159_planted_outbox_failure()`,
      );
      try {
        const response = await checkout(seller, acceptance);
        expect(response.status).toBe(500);
      } finally {
        await dataSource.query(`DROP TRIGGER tg_s159_planted_outbox ON commerce.outbox_events`);
        await dataSource.query(`DROP FUNCTION commerce.s159_planted_outbox_failure()`);
      }
      expect(await counts()).toEqual(before);
    });

    it('leaves an unenrolled seller`s request, response and rows byte-identical after outcome publication', async () => {
      const strip = (o: unknown) =>
        JSON.parse(
          JSON.stringify(o, (k, v) => {
            if (/id$|At$|Id$|^id$|token|slot/i.test(k)) return undefined;
            if (k === 'redirectUrl' && typeof v === 'string') return v.replace(/reference=[^&]+/, 'reference=<ref>');
            return v;
          }),
        );
      const legacyRun = async () => {
        const seller = await professionalSeller(150_000);
        const response = await checkout(seller).expect(201);
        const orderId = response.body.data.order.id;
        // Per-row identity and instant drop out; every other column must match.
        const schedule: Record<string, unknown> = { ...(await scheduleRow(orderId)) };
        delete schedule.order_id;
        delete schedule.created_at;
        return { response: strip(response.body.data), schedule, terms: await termsRow(orderId) };
      };

      const baseline = await legacyRun();
      const enrolled = await professionalSeller();
      await governed(enrolled);
      const after = await legacyRun();
      expect(after).toEqual(baseline);
      expect(baseline.terms).toBeUndefined();
      expect(baseline.schedule.policy_accepted_at).toBeNull();
    });

    it('costs a bounded number of statements however many options the version offers', async () => {
      const small = await professionalSeller();
      const smallAcceptance = await governed(small);
      const large = await professionalSeller();
      const many = Array.from({ length: 20 }, (_, i) => ({ kind: 'fixed_toman' as const, amountToman: 1_000 * (i + 1) }));
      const largeAcceptance = await governed(
        large,
        terms({ lateRetentionOptions: [{ kind: 'percentage_of_collected', basisPoints: 2_500 }, ...many], noShowRetentionOptions: [{ kind: 'fixed_toman', amountToman: 40_000 }, ...many.slice(0, 19)] }),
      );
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const create = (seller: Seller, acceptedPolicy: BookingOutcomeAcceptanceV1) => () =>
        orders.createForBooking({ bookingId: uuidv7(), customerId: customer.id, professionalId: seller.professionalId, serviceId: seller.serviceId, acceptedPolicy });
      const legacy = await professionalSeller();
      const legacyCount = await countStatements(() =>
        orders.createForBooking({ bookingId: uuidv7(), customerId: customer.id, professionalId: legacy.professionalId, serviceId: legacy.serviceId }),
      );
      const smallCount = await countStatements(create(small, smallAcceptance));
      const largeCount = await countStatements(create(large, largeAcceptance));
      expect(largeCount).toBe(smallCount);
      // The selection read runs on the legacy path too (it is how "unenrolled"
      // is known), so a governed order adds the version, options and copy reads
      // plus the terms insert — four statements, and nothing per option.
      expect(smallCount - legacyCount).toBe(4);
    });
  });

  // =========================================================================
  // §6. Acceptance ⇔ terms, and the terms row itself, in the database
  // =========================================================================

  describe('§6 database invariants', () => {
    async function resolvedOrder(): Promise<string> {
      const seller = await professionalSeller();
      const acceptance = await governed(seller);
      return (await checkout(seller, acceptance).expect(201)).body.data.order.id;
    }

    const cloneOrder = async (m: EntityManager, source: string): Promise<string> => {
      const id = uuidv7();
      await m.query(
        `INSERT INTO commerce.orders
         SELECT (jsonb_populate_record(NULL::commerce.orders, to_jsonb(o) || jsonb_build_object('id', $1::text, 'source_id', $2::text))).*
           FROM commerce.orders o WHERE o.id = $3`,
        [id, uuidv7(), source],
      );
      return id;
    };
    const cloneSchedule = (m: EntityManager, source: string, orderId: string, accepted: boolean) =>
      m.query(
        `INSERT INTO ${SCHEDULES}
         SELECT (jsonb_populate_record(NULL::${SCHEDULES}, to_jsonb(s) || jsonb_build_object('order_id', $1::text)
                   || jsonb_build_object('policy_accepted_at', CASE WHEN $2::boolean THEN to_jsonb(now()) ELSE 'null'::jsonb END))).*
           FROM ${SCHEDULES} s WHERE s.order_id = $3`,
        [orderId, accepted, source],
      );
    const cloneTerms = (m: EntityManager, source: string, orderId: string, overrides: Record<string, unknown> = {}) =>
      m.query(
        `INSERT INTO ${TERMS}
         SELECT (jsonb_populate_record(NULL::${TERMS}, to_jsonb(t) || jsonb_build_object('order_id', $1::text, 'resolved_at', now()) || $2::jsonb)).*
           FROM ${TERMS} t WHERE t.order_id = $3`,
        [orderId, JSON.stringify(overrides), source],
      );

    it('commits terms and acceptance only together', async () => {
      const source = await resolvedOrder();

      await expect(
        dataSource.transaction(async (m) => {
          const id = await cloneOrder(m, source);
          await cloneSchedule(m, source, id, true);
        }),
      ).rejects.toThrow(/requires the order's outcome terms/);

      await expect(
        dataSource.transaction(async (m) => {
          const id = await cloneOrder(m, source);
          await cloneTerms(m, source, id);
          await cloneSchedule(m, source, id, false);
        }),
      ).rejects.toThrow(/requires the order's schedule to record the customer's acceptance/);

      // The control: both, in one transaction, commit.
      await expect(
        dataSource.transaction(async (m) => {
          const id = await cloneOrder(m, source);
          await cloneTerms(m, source, id);
          await cloneSchedule(m, source, id, true);
        }),
      ).resolves.toBeUndefined();
    });

    it('never lets an order created without terms acquire them later', async () => {
      const source = await resolvedOrder();
      const legacySeller = await professionalSeller();
      const legacyOrder = (await checkout(legacySeller).expect(201)).body.data.order.id;
      await expect(
        dataSource.transaction((m) =>
          cloneTerms(m, source, legacyOrder, { seller_party_type: 'professional', seller_party_id: legacySeller.partyId }),
        ),
      ).rejects.toThrow(/requires the order's schedule to record the customer's acceptance/);
      await expect(dataSource.query(`UPDATE ${SCHEDULES} SET policy_accepted_at = now() WHERE order_id = $1`, [legacyOrder])).rejects.toThrow();
    });

    it('keeps the terms append-only, the legal seller the order`s, and the instant the database`s', async () => {
      const source = await resolvedOrder();
      await expect(dataSource.query(`UPDATE ${TERMS} SET cutoff_hours = cutoff_hours WHERE order_id = $1`, [source])).rejects.toThrow(/immutable/);
      await expect(dataSource.query(`DELETE FROM ${TERMS} WHERE order_id = $1`, [source])).rejects.toThrow(/immutable/);
      await expect(
        dataSource.transaction(async (m) => {
          const id = await cloneOrder(m, source);
          await cloneTerms(m, source, id, { seller_party_id: uuidv7() });
        }),
      ).rejects.toThrow(/legal seller must be the order's/);
      await expect(
        dataSource.transaction(async (m) => {
          const id = await cloneOrder(m, source);
          await cloneTerms(m, source, id, { resolved_at: '2020-01-01T00:00:00Z' });
        }),
      ).rejects.toThrow(/must be the database transaction instant/);
      await expect(
        dataSource.transaction(async (m) => {
          const id = await cloneOrder(m, source);
          await cloneTerms(m, source, id, { legal_cap_kind: 'full_collected', legal_evidence_id: null });
        }),
      ).rejects.toThrow(/ck_oot_legal_cap_requires_evidence/);
    });
  });

  // =========================================================================
  // §7. Privacy: export and erasure
  // =========================================================================

  describe('§7 privacy', () => {
    it('exports the customer`s accepted terms without evidence, cap or seller, and reports them retained', async () => {
      const seller = await professionalSeller();
      const acceptance = await governed(seller);
      const prepared = await prepareBooking(seller);
      const orderId = (await postCheckout(seller, prepared, acceptance).expect(201)).body.data.order.id;

      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const commerce = contracts.find((c) => c.moduleKey === 'commerce')!;
      const sections = await commerce.exportSubjectData(dataSource.manager, prepared.customer.id);
      const section = sections.find((s) => s.key === 'order_outcome_terms')!;
      expect(section.rows).toHaveLength(1);
      expect(section.rows[0]).toMatchObject({ order_id: orderId, policy_key: acceptance.policyKey, copy_version: acceptance.copyVersion });
      expect(Object.keys(section.rows[0])).not.toEqual(expect.arrayContaining(['legal_evidence_id']));
      for (const hidden of ['legal_evidence_id', 'legal_cap_kind', 'case_file_retention_days', 'seller_party_id']) {
        expect(section.rows[0]).not.toHaveProperty(hidden);
      }
      const erased = await commerce.eraseSubjectData(dataSource.manager, prepared.customer.id, {
        userId: prepared.customer.id,
        phoneAlias: 'del:s159',
        displayAlias: 'x',
        erasedAt: new Date(),
      });
      expect(erased.retained.map((r) => r.table)).toContain(TERMS);
      expect(await termsRow(orderId)).toBeDefined();
    });

    it('exports the selections a person authored, never another actor`s identity, and retains them', async () => {
      const seller = await professionalSeller();
      const policy = await publishedOutcome();
      await select(seller, policy.key);
      await select(seller, policy.key, { ...SELECTION, cutoffHours: 48 });

      const contract = app
        .get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS)
        .find((c) => c.moduleKey === 'commercial-outcome-policy-assignment')!;
      const [section] = await contract.exportSubjectData(dataSource.manager, seller.owner.id);
      expect(section.key).toBe('outcome_policy_selections');
      expect(section.rows.map((r) => r.cutoffHours)).toEqual([12, 48]);
      expect(JSON.stringify(section.rows)).not.toMatch(/superseded_by_user_id|supersededByUserId|assigned_by_user_id/);

      const stranger = await seedUser(app, dataSource, nextPhone(), ['customer']);
      expect((await contract.exportSubjectData(dataSource.manager, stranger.id))[0].rows).toEqual([]);

      const erased = await contract.eraseSubjectData(dataSource.manager, seller.owner.id, {
        userId: seller.owner.id,
        phoneAlias: 'del:s159b',
        displayAlias: 'x',
        erasedAt: new Date(),
      });
      expect(erased).toMatchObject({ anonymized: 0, deleted: 0 });
      expect(erased.retained.map((r) => r.table)).toEqual([SELECTIONS]);
      expect(await selectionRows(seller.partyId)).toHaveLength(2);
    });
  });

  // =========================================================================
  // §8. Comparable refusal timing (V33-DEC-033 R3's method)
  // =========================================================================

  describe('§8 refusal timing', () => {
    /*
     * The method: interleaved samples of each refusal path, compared by their
     * MEDIANS against a documented tolerance, with a planted control proving
     * the comparison can fail. Not a constant-time claim — R3 asks for measured
     * comparable timing under a stated method. These surfaces have no response
     * floor, so the tolerance is the stated bound itself.
     */
    const SAMPLES = 9;
    const TOLERANCE_MS = 60;
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const spreadOf = (samples: Record<string, number[]>) => {
      const medians = Object.values(samples).map(median);
      return Math.max(...medians) - Math.min(...medians);
    };
    const timed = async (operation: () => Promise<unknown>): Promise<number> => {
      const started = process.hrtime.bigint();
      await operation();
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    it('answers every seller-surface refusal in comparable time', async () => {
      const seller = await professionalSeller();
      const foreign = await professionalSeller();
      const policy = await publishedOutcome();
      const body = { policyKey: policy.key, ...SELECTION, reason: 'timing' };
      const paths: Record<string, () => Promise<unknown>> = {
        malformed: () => putSelection(seller.owner, 'not-a-reference', body).expect(409),
        foreign: () => putSelection(seller.owner, foreign.workspaceRef, body).expect(409),
        outsideRange: () => putSelection(seller.owner, seller.workspaceRef, { ...body, cutoffHours: 7 }).expect(409),
        unknownKey: () => putSelection(seller.owner, seller.workspaceRef, { ...body, policyKey: 'noSuchKey' }).expect(409),
      };
      const samples: Record<string, number[]> = Object.fromEntries(Object.keys(paths).map((k) => [k, []]));
      for (let i = 0; i < SAMPLES; i += 1) {
        for (const [label, run] of Object.entries(paths)) samples[label].push(await timed(run));
      }
      const spread = spreadOf(samples);
      expect({ comparable: spread < TOLERANCE_MS, ms: Math.round(spread) }).toEqual({ comparable: true, ms: Math.round(spread) });

      const planted = { ...samples, slow: samples.malformed.map((v) => v + TOLERANCE_MS * 2) };
      expect(spreadOf(planted) < TOLERANCE_MS).toBe(false);
    }, 120_000);

    it('answers every checkout refusal cause in comparable time', async () => {
      const seller = await professionalSeller();
      const other = await professionalSeller();
      const acceptance = await governed(seller);
      const paths: Record<string, (p: Prepared) => Promise<unknown>> = {
        foreignService: (p) =>
          request(server())
            .post('/api/v1/bookings')
            .set(auth(p.customer))
            .send({ professionalId: seller.professionalId, slotId: p.slotId, serviceId: other.serviceId, acceptedPolicy: acceptance })
            .expect(409),
        missing: (p) => postCheckout(seller, p).expect(409),
        mismatch: (p) => postCheckout(seller, p, { ...acceptance, copyVersion: acceptance.copyVersion + 1 }).expect(409),
      };
      const samples: Record<string, number[]> = Object.fromEntries(Object.keys(paths).map((k) => [k, []]));
      for (let i = 0; i < SAMPLES; i += 1) {
        for (const [label, run] of Object.entries(paths)) {
          const prepared = await prepareBooking(seller);
          samples[label].push(await timed(() => run(prepared)));
        }
      }
      const spread = spreadOf(samples);
      expect({ comparable: spread < TOLERANCE_MS, ms: Math.round(spread) }).toEqual({ comparable: true, ms: Math.round(spread) });
    }, 180_000);
  });

  /** Statements one operation issues, counted through TypeORM's logger. */
  async function countStatements(operation: () => Promise<unknown>): Promise<number> {
    const counter = new CountingLogger();
    const original = dataSource.logger;
    try {
      dataSource.logger = counter;
      counter.reset();
      await operation();
      return counter.count;
    } finally {
      dataSource.logger = original;
    }
  }
});

class CountingLogger {
  count = 0;

  reset(): void {
    this.count = 0;
  }

  logQuery(query: string): void {
    // Transaction control is not a statement the operation chose to issue.
    if (/^(START TRANSACTION|BEGIN|COMMIT|ROLLBACK)/i.test(query.trim())) return;
    this.count += 1;
  }

  logQueryError(): void {}
  logQuerySlow(): void {}
  logSchemaBuild(): void {}
  logMigration(): void {}
  log(): void {}
}
