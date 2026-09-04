import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import {
  BookingCreditGrantService,
  CommercialCatalogueService,
  SellerSubscriptionSurfaceController,
  WORKSPACE_REFERENCE_PATTERN,
  WorkspaceReferenceService,
} from '@beauclick/commercial-policy';

import {
  PgTestApp,
  SeededUser,
  createPgTestApp,
  requiredPgEnv,
  resetDatabase,
  seedBusiness,
  seedProfessional,
  seedUser,
} from './pg-test-app.factory';

const describePg = requiredPgEnv() !== null ? describe : describe.skip;

/** Well before now, so a published version is ACTIVE during the run. */
const ACTIVE_FROM = new Date('2020-01-01T00:00:00.000Z');

/**
 * The seller subscription surface against a real PostgreSQL server — V3.3-A
 * Story #69 (`#56b`), `V33-DEC-019`.
 *
 * ## Why the evidence is here and not on the fast layer
 *
 * Everything this story claims is about a REQUEST meeting real rows: that a
 * reference resolves only against live ownership, that a staff member
 * enumerates nothing, that two concurrent selections produce one successor,
 * that a refusal is byte-identical, that a replay writes nothing. pg-mem
 * honours no ROLLBACK, has no partial unique indexes and runs no PL/pgSQL, so
 * none of those can be observed there. The pure half — the HMAC construction,
 * the format contract, the constant-time comparison — is proved fast, in
 * `services/commercial-policy/src/seller-surface/workspace-reference.spec.ts`.
 *
 * ## Whole-response comparisons, not field spot-checks
 *
 * The high-value guarantees here are about what a response IS, not about one
 * field being right: "these five refusals are indistinguishable" and "mutating
 * the professional left the business untouched" are both claims about the whole
 * body. Asserting a field at a time would pass while the bodies differed
 * somewhere else, which is exactly the leak being tested for.
 */
describePg('seller subscription surface — workspaces, references, refusals (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let catalogue: CommercialCatalogueService;
  let references: WorkspaceReferenceService;
  let admin: SeededUser;

  let sequence = 0;
  const nextKey = (prefix: string): string => `${prefix}-${(sequence += 1)}-${Date.now() % 100000}`;
  const nextPhone = (): string => `+98914${String(100000 + (sequence += 1)).slice(-6)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    catalogue = app.get(CommercialCatalogueService);
    references = app.get(WorkspaceReferenceService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    admin = await seedUser(app, dataSource, nextPhone(), ['administrator']);
  });

  // =========================================================================
  // Builders — real catalogue rows through the real administrator service.
  // `resetDatabase` truncates the migration's `D-7` seed away, so every case
  // that needs a base workspace publishes one.
  // =========================================================================

  async function publishedPlanVersion(
    options: {
      autoAssignable?: boolean;
      unitPriceToman?: number;
      includedBookingCredits?: number;
      staffSeats?: number;
      includedLocations?: number;
      lifecycle?: 'draft' | 'published' | 'retired';
      activationStartsAt?: Date;
      activationEndsAt?: Date | null;
    } = {},
  ): Promise<{ planKey: string; version: number; id: string }> {
    const scheduleKey = nextKey('sched');
    await catalogue.createPriceSchedule(admin.id, scheduleKey, 'seller_plan', 'suite setup');
    const scheduleDraft = await catalogue.createScheduleVersionDraft(
      admin.id,
      {
        scheduleKey,
        displayName: `${scheduleKey} v1`,
        activationStartsAt: ACTIVE_FROM,
        activationEndsAt: null,
        terms: {
          currency: 'IRT',
          minPurchaseQuantity: 1,
          maxPurchaseQuantity: 1,
          uiPresetQuantities: [],
          tiers: [{ minQuantity: 1, maxQuantity: 1, unitPriceToman: options.unitPriceToman ?? 0 }],
        },
      },
      'suite setup',
    );
    const schedule = await catalogue.publishScheduleVersion(admin.id, scheduleKey, scheduleDraft.version, 'suite setup');

    const planKey = nextKey('plan');
    await catalogue.createPlan(admin.id, planKey, 'suite setup');
    const draft = await catalogue.createPlanVersionDraft(
      admin.id,
      {
        planKey,
        priceScheduleVersionId: schedule.id,
        autoAssignable: options.autoAssignable ?? false,
        activationStartsAt: options.activationStartsAt ?? ACTIVE_FROM,
        activationEndsAt: options.activationEndsAt === undefined ? null : options.activationEndsAt,
        terms: {
          displayName: planKey,
          billingTermDays: null,
          includedBookingCredits: options.includedBookingCredits ?? 0,
          staffSeats: options.staffSeats ?? 0,
          includedLocations: options.includedLocations ?? 0,
          capabilityKeys: [],
        },
      },
      'suite setup',
    );

    const lifecycle = options.lifecycle ?? 'published';
    if (lifecycle === 'draft') return { planKey, version: draft.version, id: draft.id };

    const published = await catalogue.publishPlanVersion(admin.id, planKey, draft.version, 'suite setup');
    if (lifecycle === 'retired') {
      await catalogue.retirePlanVersion(admin.id, planKey, published.version, 'suite setup');
    }
    return { planKey, version: published.version, id: published.id };
  }

  /** A base workspace: auto-assignable, zero-price, no entitlements. */
  const baseWorkspace = () => publishedPlanVersion({ autoAssignable: true });

  async function professionalOwner(
    roles: string[] = ['professional'],
  ): Promise<{ user: SeededUser; partyId: string }> {
    const user = await seedUser(app, dataSource, nextPhone(), roles);
    const professional = await seedProfessional(dataSource, user.id, 'متخصص آزمون');
    return { user, partyId: professional.id };
  }

  async function businessOwner(roles: string[] = ['business']): Promise<{ user: SeededUser; partyId: string }> {
    const user = await seedUser(app, dataSource, nextPhone(), roles);
    const business = await seedBusiness(dataSource, user.id, 'کسب‌وکار آزمون');
    return { user, partyId: business.id };
  }

  /** One user owning BOTH a professional and a business — the case that made this a collection. */
  async function dualOwner(): Promise<{ user: SeededUser; professionalId: string; businessId: string }> {
    const user = await seedUser(app, dataSource, nextPhone(), ['professional', 'business']);
    const professional = await seedProfessional(dataSource, user.id, 'متخصص دوگانه');
    const business = await seedBusiness(dataSource, user.id, 'کسب‌وکار دوگانه');
    return { user, professionalId: professional.id, businessId: business.id };
  }

  // ------------------------------------------------------------------ HTTP

  const get = (path: string, user?: SeededUser) => {
    const req = request(app.getHttpServer()).get(`/api/v1${path}`);
    return user ? req.set('Authorization', `Bearer ${user.accessToken}`) : req;
  };
  const post = (path: string, user?: SeededUser) => {
    const req = request(app.getHttpServer()).post(`/api/v1${path}`);
    return user ? req.set('Authorization', `Bearer ${user.accessToken}`) : req;
  };

  const initialize = (user: SeededUser) => post('/me/subscriptions/initialization', user);
  const listWorkspaces = (user: SeededUser) => get('/me/subscriptions', user);

  interface WorkspaceEntryShape {
    workspaceRef: string;
    workspaceType: string;
    baseWorkspace: boolean;
    availableActions: string[];
    subscription: { plan: { planKey: string; version: number }; state: string } | null;
  }

  const itemsOf = (body: { data: { items: WorkspaceEntryShape[] } }): WorkspaceEntryShape[] => body.data.items;

  // ------------------------------------------------------------------ rows

  const subscriptionRows = () =>
    dataSource.query(`SELECT * FROM commercial.seller_subscriptions ORDER BY created_at, id`);
  const grantRowCount = async (): Promise<number> =>
    (await dataSource.query(`SELECT count(*)::int AS n FROM commercial.booking_credit_grants`))[0].n;
  const subscriptionCount = async (): Promise<number> =>
    (await dataSource.query(`SELECT count(*)::int AS n FROM commercial.seller_subscriptions`))[0].n;
  const commercialAuditCount = async (): Promise<number> =>
    (
      await dataSource.query(
        `SELECT count(*)::int AS n FROM admin.admin_audit_log WHERE action LIKE 'commercial.%'`,
      )
    )[0].n;

  /**
   * Every write this story can produce, as one comparable value.
   *
   * Used by every "writes nothing" case. Three counts rather than one, because
   * `V33-DEC-019` names all three — a replay that wrote no subscription but did
   * write a grant would satisfy a narrower check and still be wrong.
   */
  async function writeState(): Promise<{ subscriptions: number; grants: number; audits: number }> {
    return {
      subscriptions: await subscriptionCount(),
      grants: await grantRowCount(),
      audits: await commercialAuditCount(),
    };
  }

  /** Every table this story must NOT touch. Asserted unchanged by the boundary case. */
  async function untouchedDomainState(): Promise<Record<string, number>> {
    const tables = [
      'payment.payment_intents',
      'commerce.orders',
      'notification.notifications',
      'commercial.outbox_events_absent',
    ];
    const state: Record<string, number> = {};
    for (const table of tables) {
      if (table === 'commercial.outbox_events_absent') {
        // `commercial` has no outbox table at all (ADR-042 §12), and asserting
        // its ABSENCE is stronger than counting a table that exists: a story
        // that started emitting would have to create one first.
        const rows = await dataSource.query(
          `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'commercial' AND tablename LIKE '%outbox%'`,
        );
        state[table] = rows[0].n;
        continue;
      }
      const rows = await dataSource.query(`SELECT count(*)::int AS n FROM ${table}`);
      state[table] = rows[0].n;
    }
    return state;
  }

  // =========================================================================
  // §1. Initialization
  // =========================================================================

  describe('§1 initialization', () => {
    it('creates the base workspace for every owned workspace and returns the collection', async () => {
      const base = await baseWorkspace();
      const { user } = await dualOwner();

      const res = await initialize(user).expect(201);
      const items = itemsOf(res.body);

      expect(items).toHaveLength(2);
      // Deterministic order, decided by the surface and asserted here: a client
      // rendering a list must not see it reshuffle between calls.
      expect(items.map((entry) => entry.workspaceType)).toEqual(['business', 'professional']);
      for (const entry of items) {
        expect(entry.subscription?.plan.planKey).toBe(base.planKey);
        expect(entry.subscription?.state).toBe('active');
        expect(entry.baseWorkspace).toBe(true);
        // No `cancel` while already on the base workspace: the action a client
        // renders and the outcome the server produces cannot disagree.
        expect(entry.availableActions).toEqual(['select_plan']);
      }
      expect(await subscriptionCount()).toBe(2);
    });

    it('gives a caller who owns nothing an empty collection, not a 404', async () => {
      await baseWorkspace();
      const customer = await seedUser(app, dataSource, nextPhone(), ['professional']);

      const res = await initialize(customer).expect(201);

      expect(itemsOf(res.body)).toEqual([]);
      expect(await subscriptionCount()).toBe(0);
    });

    it('adds no workspace for a business the caller merely WORKS for', async () => {
      await baseWorkspace();
      const { user: bizOwner, partyId: businessId } = await businessOwner();
      const { user: staff, partyId: staffProfessionalId } = await professionalOwner();

      await dataSource.query(
        `INSERT INTO business.business_staff (id, business_id, user_id, professional_id, role, status, invited_by)
         VALUES ($1, $2, $3, $4, 'staff', 'active', $5)`,
        [uuidv7(), businessId, staff.id, staffProfessionalId, bizOwner.id],
      );

      const res = await initialize(staff).expect(201);
      const items = itemsOf(res.body);

      // Their OWN professional workspace, and nothing else. Ownership is what
      // stops them reaching the employer's subscription — not the capability,
      // which they hold.
      expect(items).toHaveLength(1);
      expect(items[0].workspaceType).toBe('professional');
      expect(items[0].workspaceRef).toBe(
        references.referenceFor(staff.id, { partyType: 'professional', partyId: staffProfessionalId }),
      );
      expect(items[0].workspaceRef).not.toBe(
        references.referenceFor(bizOwner.id, { partyType: 'business', partyId: businessId }),
      );
    });

    it('writes nothing on replay', async () => {
      await baseWorkspace();
      const { user } = await dualOwner();

      const first = await initialize(user).expect(201);
      const before = await writeState();

      const second = await initialize(user).expect(201);

      // The whole body, not a field: a replay that returned a different
      // reference, a different order or a different action set would be a
      // different answer to the same question.
      expect(second.body).toEqual(first.body);
      expect(await writeState()).toEqual(before);
    });

    it('produces exactly one subscription per workspace under eight concurrent initializations', async () => {
      await baseWorkspace();
      const { user } = await dualOwner();

      const results = await Promise.all(Array.from({ length: 8 }, () => initialize(user)));

      for (const res of results) {
        // No untranslated 500 anywhere: the partial unique index refuses the
        // losers and `ensureBaseSubscriptionWithin` returns the winner's row.
        expect(res.status).toBe(201);
        expect(itemsOf(res.body)).toHaveLength(2);
      }
      // Exactly two, not at-least-two: `>= 2` would pass with the duplicate bug
      // present, which is the whole failure the index prevents.
      expect(await subscriptionCount()).toBe(2);
      expect(await grantRowCount()).toBe(2);
    });

    it('rolls the WHOLE command back when one workspace fails', async () => {
      await baseWorkspace();
      const { user } = await dualOwner();
      const before = await writeState();

      /*
       * Fail on the SECOND workspace, after the first has already written its
       * subscription, grant and audit row.
       *
       * That is the case worth proving: a per-workspace transaction would leave
       * the first configured and the second not, and the seller's retry would
       * then behave differently for each half. Throwing from the grant service
       * — the last write in an activation — proves everything before it in the
       * command rolls back too, across both workspaces.
       */
      const grants = app.get(BookingCreditGrantService) as unknown as {
        issueForActivation: (...args: unknown[]) => Promise<unknown>;
      };
      const original = grants.issueForActivation.bind(grants);
      let calls = 0;
      grants.issueForActivation = async (...args: unknown[]) => {
        calls += 1;
        if (calls === 2) throw new Error('planted failure on the second workspace');
        return original(...args);
      };

      try {
        await initialize(user).expect(500);
      } finally {
        grants.issueForActivation = original;
      }

      expect(calls).toBe(2);
      // Neither workspace, not just the failing one.
      expect(await writeState()).toEqual(before);

      // And the seam still works afterwards, so the probe proved a rollback
      // rather than a permanently broken service.
      const recovered = await initialize(user).expect(201);
      expect(itemsOf(recovered.body)).toHaveLength(2);
    });

    it('refuses an unknown body or query field rather than ignoring it', async () => {
      await baseWorkspace();
      const { user } = await professionalOwner();

      // Each of these is a field a caller might send believing it selects a
      // workspace. Ignoring one would look, from the client's side, exactly
      // like the server honouring it.
      await post('/me/subscriptions/initialization', user).send({ professionalId: uuidv7() }).expect(400);
      await post('/me/subscriptions/initialization', user).send({ reason: 'because' }).expect(400);
      await post('/me/subscriptions/initialization?ownerId=x', user).expect(400);

      expect(await subscriptionCount()).toBe(0);

      // The positive control: an empty body IS accepted, so the three refusals
      // above are about the fields rather than about the route being broken.
      await post('/me/subscriptions/initialization', user).send({}).expect(201);
    });
  });

  // =========================================================================
  // §2. Reads are side-effect-free
  // =========================================================================

  describe('§2 reads write nothing', () => {
    it('leaves no subscription, grant or audit row behind on any GET', async () => {
      await baseWorkspace();
      const { user } = await dualOwner();
      await initialize(user).expect(201);

      const before = await writeState();
      const ref = itemsOf((await listWorkspaces(user).expect(200)).body)[0].workspaceRef;

      await listWorkspaces(user).expect(200);
      await get(`/me/subscriptions/${ref}/history`, user).expect(200);
      await get('/me/commercial-plans', user).expect(200);

      expect(await writeState()).toEqual(before);
    });

    it('does NOT assign a base workspace to a seller who has never initialized', async () => {
      await baseWorkspace();
      const { user } = await professionalOwner();

      const res = await listWorkspaces(user).expect(200);
      const items = itemsOf(res.body);

      // The workspace is visible — the caller owns it — with no subscription
      // and no action available. Initialization is the only path that writes.
      expect(items).toHaveLength(1);
      expect(items[0].subscription).toBeNull();
      expect(items[0].baseWorkspace).toBe(false);
      expect(items[0].availableActions).toEqual([]);
      expect(await subscriptionCount()).toBe(0);
    });

    it('rejects unknown query fields on every read', async () => {
      await baseWorkspace();
      const { user } = await professionalOwner();
      const ref = itemsOf((await initialize(user).expect(201)).body)[0].workspaceRef;

      await get('/me/subscriptions?partyId=x', user).expect(400);
      await get(`/me/subscriptions/${ref}/history?businessId=x`, user).expect(400);
      await get('/me/commercial-plans?planKey=x', user).expect(400);
    });
  });

  // =========================================================================
  // §3. The workspace reference
  // =========================================================================

  describe('§3 workspaceRef', () => {
    it('is a 43-character base64url value that contains no raw identity', async () => {
      await baseWorkspace();
      const { user, professionalId, businessId } = await dualOwner();

      const items = itemsOf((await initialize(user).expect(201)).body);
      const body = JSON.stringify(items);

      for (const entry of items) {
        expect(entry.workspaceRef).toMatch(WORKSPACE_REFERENCE_PATTERN);
        expect(entry.workspaceRef).toHaveLength(43);
      }
      // The WHOLE response, not only the reference: an id leaking through any
      // other field would defeat the point of the reference entirely.
      for (const identifier of [user.id, professionalId, businessId, user.phone]) {
        expect(body).not.toContain(identifier);
      }
    });

    it('is stable across calls and different for each workspace and each owner', async () => {
      await baseWorkspace();
      const { user, professionalId } = await dualOwner();
      const other = await seedUser(app, dataSource, nextPhone(), ['professional']);

      const first = itemsOf((await listWorkspaces(user).expect(200)).body).map((entry) => entry.workspaceRef);
      const second = itemsOf((await listWorkspaces(user).expect(200)).body).map((entry) => entry.workspaceRef);

      expect(second).toEqual(first);
      expect(new Set(first).size).toBe(2);
      // The same party under a different session produces a different value —
      // which is what makes a stolen reference useless.
      expect(references.referenceFor(other.id, { partyType: 'professional', partyId: professionalId })).not.toBe(
        references.referenceFor(user.id, { partyType: 'professional', partyId: professionalId }),
      );
    });

    it('resolves by enumerating owned parties, so a party sold since issue stops working', async () => {
      await baseWorkspace();
      const { user, partyId } = await professionalOwner();
      const ref = itemsOf((await initialize(user).expect(201)).body)[0].workspaceRef;

      await get(`/me/subscriptions/${ref}/history`, user).expect(200);

      // The party is soft-deleted. The reference is unchanged and still
      // correctly signed; ownership is re-read on every request, so it stops
      // resolving without anything having expired.
      await dataSource.query(`UPDATE provider.professionals SET deleted_at = now() WHERE id = $1`, [partyId]);

      await get(`/me/subscriptions/${ref}/history`, user).expect(404);
      expect(itemsOf((await listWorkspaces(user).expect(200)).body)).toEqual([]);
    });
  });

  // =========================================================================
  // §4. One refusal, byte for byte
  // =========================================================================

  describe('§4 indistinguishable refusals', () => {
    it('answers malformed, random, foreign, stale and unknown references identically', async () => {
      await baseWorkspace();
      const { user, partyId } = await professionalOwner();
      const stranger = await professionalOwner();

      await initialize(user).expect(201);
      await initialize(stranger.user).expect(201);

      const foreign = itemsOf((await listWorkspaces(stranger.user).expect(200)).body)[0].workspaceRef;
      // Correctly signed for a party this caller owns, under a DIFFERENT owner
      // — the forged case, which no format check can catch.
      const forged = references.referenceFor(stranger.user.id, { partyType: 'professional', partyId });

      const candidates = [
        'not-a-reference',
        '',
        'A'.repeat(43),
        'A'.repeat(42),
        `${'A'.repeat(42)}+`,
        partyId,
        user.id,
        foreign,
        forged,
        references.referenceFor(user.id, { partyType: 'business', partyId: uuidv7() }),
      ];

      const responses = [];
      for (const candidate of candidates) {
        // An empty segment collapses the path, so it is exercised as an
        // encoded space — the closest a client can actually get to "missing".
        const segment = candidate === '' ? '%20' : encodeURIComponent(candidate);
        responses.push(await get(`/me/subscriptions/${segment}/history`, user));
      }

      const [first, ...rest] = responses;
      expect(first.status).toBe(404);
      for (const res of rest) {
        expect(res.status).toBe(first.status);
        // BYTE-identical, not merely the same code. A different `details`, a
        // different message or a different key order is a distinguishable
        // response, and distinguishable is all an enumeration oracle needs.
        expect(JSON.stringify(res.body)).toBe(JSON.stringify(first.body));
      }

      // The discovery half: the refusal really is the ratified one, and the
      // body carries no detail that could vary.
      expect(first.body).toEqual({
        data: null,
        meta: null,
        error: { code: 'SUBSCRIPTION_SELLER_NOT_ELIGIBLE', message: expect.any(String) },
      });

      // The positive control. Without it every assertion above would pass
      // against a route that refused EVERYTHING, including a valid reference.
      const valid = itemsOf((await listWorkspaces(user).expect(200)).body)[0].workspaceRef;
      await get(`/me/subscriptions/${valid}/history`, user).expect(200);
    });

    it('gives a caller who owns nothing the same refusal, on every mutation too', async () => {
      await baseWorkspace();
      const { user } = await professionalOwner();
      const nobody = await seedUser(app, dataSource, nextPhone(), ['professional']);
      const plan = await publishedPlanVersion();

      const ref = itemsOf((await initialize(user).expect(201)).body)[0].workspaceRef;

      const read = await get(`/me/subscriptions/${ref}/history`, nobody).expect(404);
      const select = await post(`/me/subscriptions/${ref}/selection`, nobody)
        .send({ planKey: plan.planKey, version: plan.version })
        .expect(404);
      const cancel = await post(`/me/subscriptions/${ref}/cancellation`, nobody).expect(404);

      for (const res of [select, cancel]) {
        expect(JSON.stringify(res.body)).toBe(JSON.stringify(read.body));
      }
      // Refusals write nothing — not a subscription for the stranger, and
      // nothing at all for the owner whose reference was presented.
      expect(await subscriptionCount()).toBe(1);
    });
  });

  // =========================================================================
  // §5. Authentication, ownership and capability
  // =========================================================================

  describe('§5 authorization', () => {
    it('refuses every one of the six routes without a token', async () => {
      const ref = 'A'.repeat(43);

      await post('/me/subscriptions/initialization').expect(401);
      await get('/me/subscriptions').expect(401);
      await get(`/me/subscriptions/${ref}/history`).expect(401);
      await post(`/me/subscriptions/${ref}/selection`).send({ planKey: 'x', version: 1 }).expect(401);
      await post(`/me/subscriptions/${ref}/cancellation`).expect(401);
      await get('/me/commercial-plans').expect(401);
    });

    it('lets an owner READ without the capability, and refuses every mutation', async () => {
      await baseWorkspace();
      const plan = await publishedPlanVersion();
      // Owns a professional, but holds only `customer` capabilities — the state
      // a seller is in between a role grant and their next access token.
      const { user, partyId } = await professionalOwner(['customer']);
      expect(JSON.parse(Buffer.from(user.accessToken.split('.')[1], 'base64url').toString()).capabilities).not.toContain(
        'bc_manage_own_subscription',
      );

      const ref = references.referenceFor(user.id, { partyType: 'professional', partyId });

      // Reading requires authentication and live ownership, and nothing else.
      await listWorkspaces(user).expect(200);
      await get(`/me/subscriptions/${ref}/history`, user).expect(200);
      await get('/me/commercial-plans', user).expect(200);

      // Mutating additionally requires the capability. A 403, distinct from the
      // 404 an unowned workspace gets: the caller's problem is their authority,
      // not the workspace, and telling them so reveals nothing they do not own.
      await post('/me/subscriptions/initialization', user).expect(403);
      await post(`/me/subscriptions/${ref}/selection`, user)
        .send({ planKey: plan.planKey, version: plan.version })
        .expect(403);
      await post(`/me/subscriptions/${ref}/cancellation`, user).expect(403);

      expect(await subscriptionCount()).toBe(0);
    });

    it('follows the ACCESS-TOKEN lifecycle, with no live database revocation claimed', async () => {
      /*
       * `V33-DEC-019` is explicit that this non-privileged capability carries no
       * live re-check, and this case tests exactly that rather than a stronger
       * property nobody implemented.
       *
       * The role is revoked in the DATABASE and the OLD token keeps working —
       * which is correct, documented behaviour and would be a defect for a
       * privileged capability. A newly issued token no longer carries it.
       */
      await baseWorkspace();
      const { user } = await professionalOwner();
      await initialize(user).expect(201);

      await dataSource.query(`DELETE FROM identity.user_roles WHERE user_id = $1`, [user.id]);
      await dataSource.query(`UPDATE identity.users SET roles = '{customer}' WHERE id = $1`, [user.id]);

      // Still accepted: the capability lives in the token, which is unchanged.
      await initialize(user).expect(201);

      const reissued = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const { user: withoutRole } = { user: { ...user, accessToken: reissued.accessToken } };
      await post('/me/subscriptions/initialization', withoutRole as SeededUser).expect(403);
    });

    it('refuses a staff member reading or mutating the employer subscription', async () => {
      await baseWorkspace();
      const plan = await publishedPlanVersion();
      const { user: bizOwner, partyId: businessId } = await businessOwner();
      const { user: staff, partyId: staffProfessionalId } = await professionalOwner();

      await dataSource.query(
        `INSERT INTO business.business_staff (id, business_id, user_id, professional_id, role, status, invited_by)
         VALUES ($1, $2, $3, $4, 'manager', 'active', $5)`,
        [uuidv7(), businessId, staff.id, staffProfessionalId, bizOwner.id],
      );

      await initialize(bizOwner).expect(201);
      await initialize(staff).expect(201);

      const employerRef = itemsOf((await listWorkspaces(bizOwner).expect(200)).body)[0].workspaceRef;

      // The employer's reference never appears in the staff member's own
      // collection...
      const staffRefs = itemsOf((await listWorkspaces(staff).expect(200)).body).map((e) => e.workspaceRef);
      expect(staffRefs).not.toContain(employerRef);
      expect(staffRefs).toHaveLength(1);

      // ...and presenting it explicitly is refused, for reads and mutations
      // alike, even though this staff member is an ACTIVE MANAGER and holds the
      // capability.
      await get(`/me/subscriptions/${employerRef}/history`, staff).expect(404);
      await post(`/me/subscriptions/${employerRef}/selection`, staff)
        .send({ planKey: plan.planKey, version: plan.version })
        .expect(404);
      await post(`/me/subscriptions/${employerRef}/cancellation`, staff).expect(404);

      // The employer's own workspace is untouched by all of it.
      const employer = itemsOf((await listWorkspaces(bizOwner).expect(200)).body)[0];
      expect(employer.baseWorkspace).toBe(true);
      expect(employer.subscription?.state).toBe('active');
    });
  });

  // =========================================================================
  // §6. The seller-visible plan catalogue
  // =========================================================================

  describe('§6 commercial plans', () => {
    it('returns only published versions that are effective right now', async () => {
      const base = await baseWorkspace();
      const visible = await publishedPlanVersion({ includedBookingCredits: 12 });
      const draft = await publishedPlanVersion({ lifecycle: 'draft' });
      const retired = await publishedPlanVersion({ lifecycle: 'retired' });
      const future = await publishedPlanVersion({ activationStartsAt: new Date(Date.now() + 86_400_000) });
      const expired = await publishedPlanVersion({
        activationStartsAt: ACTIVE_FROM,
        activationEndsAt: new Date(Date.now() - 86_400_000),
      });
      const { user } = await professionalOwner();

      const res = await get('/me/commercial-plans', user).expect(200);
      const keys: string[] = res.body.data.items.map((item: { planKey: string }) => item.planKey);

      expect(keys.sort()).toEqual([base.planKey, visible.planKey].sort());
      // Named individually so a failure says WHICH exclusion broke.
      expect(keys).not.toContain(draft.planKey);
      expect(keys).not.toContain(retired.planKey);
      expect(keys).not.toContain(future.planKey);
      expect(keys).not.toContain(expired.planKey);

      // Deterministic ordering, and the entitlement and price read from the
      // immutable published version.
      expect(keys).toEqual([...keys].sort());
      const entry = res.body.data.items.find((item: { planKey: string }) => item.planKey === visible.planKey);
      expect(entry.entitlements.includedBookingCredits).toBe(12);
      expect(entry.price).toEqual({ currency: 'IRT', unitPriceToman: 0 });
      expect(entry.selectable).toBe(true);
    });

    it('shows a non-zero plan as visible but NOT selectable', async () => {
      await baseWorkspace();
      const paid = await publishedPlanVersion({ unitPriceToman: 500_000 });
      const { user } = await professionalOwner();

      const res = await get('/me/commercial-plans', user).expect(200);
      const entry = res.body.data.items.find((item: { planKey: string }) => item.planKey === paid.planKey);

      expect(entry.price.unitPriceToman).toBe(500_000);
      expect(entry.selectable).toBe(false);
    });

    it('exposes no administrator identity, schedule internals or audit fields', async () => {
      await baseWorkspace();
      await publishedPlanVersion();
      const { user } = await professionalOwner();

      const res = await get('/me/commercial-plans', user).expect(200);
      const body = JSON.stringify(res.body);

      for (const forbidden of [
        admin.id,
        'createdByUserId',
        'publishedByUserId',
        'retiredByUserId',
        'publishedAt',
        'retiredAt',
        'priceScheduleVersionId',
        'lifecycleState',
        'activationStartsAt',
      ]) {
        expect(body).not.toContain(forbidden);
      }
      // The keys are pinned exactly, so a field added later has to be read by a
      // human rather than absorbed by a substring check.
      expect(Object.keys(res.body.data.items[0]).sort()).toEqual([
        'baseWorkspace',
        'billingTermDays',
        'displayName',
        'entitlements',
        'planKey',
        'price',
        'selectable',
        'version',
      ]);
    });

    it('costs the SAME number of queries for one plan and for five', async () => {
      /*
       * The N+1 control, and it is deliberately not "assert the count is 3".
       *
       * A magic number fails when an unrelated query is added and passes when
       * the catalogue is small, so it tests the constant rather than the
       * growth. Comparing one plan against five tests the growth directly: an
       * implementation that read the price schedule per plan would show four
       * extra queries here and none at all in a fixture with a single plan.
       */
      const { user } = await professionalOwner();
      await baseWorkspace();

      const counter = new CountingLogger();
      const originalLogger = dataSource.logger;
      let withOne = 0;
      let withFive = 0;
      try {
        dataSource.logger = counter;

        // The discovery half: the counter really counts. Without this the two
        // comparisons below would agree at zero and prove nothing.
        counter.reset();
        await dataSource.query('SELECT 1');
        expect(counter.count).toBe(1);

        counter.reset();
        await get('/me/commercial-plans', user).expect(200);
        withOne = counter.count;
      } finally {
        dataSource.logger = originalLogger;
      }

      for (let i = 0; i < 4; i += 1) await publishedPlanVersion();

      try {
        dataSource.logger = counter;
        counter.reset();
        const res = await get('/me/commercial-plans', user).expect(200);
        withFive = counter.count;
        // The fixture really did grow, so the comparison is between two
        // different catalogue sizes.
        expect(res.body.data.items).toHaveLength(5);
      } finally {
        dataSource.logger = originalLogger;
      }

      expect(withOne).toBeGreaterThan(0);
      expect(withFive).toBe(withOne);
    });
  });

  // =========================================================================
  // §7. Selection
  // =========================================================================

  describe('§7 selection', () => {
    it('moves the workspace onto a published version and snapshots its authoritative values', async () => {
      await baseWorkspace();
      const target = await publishedPlanVersion({ includedBookingCredits: 30, staffSeats: 4, includedLocations: 2 });
      const { user } = await professionalOwner();
      const ref = itemsOf((await initialize(user).expect(201)).body)[0].workspaceRef;

      const res = await post(`/me/subscriptions/${ref}/selection`, user)
        .send({ planKey: target.planKey, version: target.version })
        .expect(201);

      expect(res.body.data.subscription.plan).toEqual({
        planKey: target.planKey,
        version: target.version,
        billingTermDays: null,
      });
      expect(res.body.data.subscription.entitlements).toEqual({
        includedBookingCredits: 30,
        staffSeats: 4,
        includedLocations: 2,
        capabilityKeys: [],
      });
      expect(res.body.data.baseWorkspace).toBe(false);
      expect(res.body.data.availableActions).toEqual(['select_plan', 'cancel']);

      // The snapshot is copied from the authoritative catalogue row, not joined
      // to it — so retiring the version later cannot rewrite history.
      const rows = await subscriptionRows();
      const active = rows.find((row: { lifecycle_state: string }) => row.lifecycle_state === 'active');
      expect(active.snapshot_plan_key).toBe(target.planKey);
      expect(active.snapshot_included_booking_credits).toBe(30);
      expect(Number(active.snapshot_unit_price_toman)).toBe(0);
    });

    it('rejects an unknown field in the selection body', async () => {
      await baseWorkspace();
      const target = await publishedPlanVersion();
      const { user } = await professionalOwner();
      const ref = itemsOf((await initialize(user).expect(201)).body)[0].workspaceRef;
      const before = await writeState();

      await post(`/me/subscriptions/${ref}/selection`, user)
        .send({ planKey: target.planKey, version: target.version, professionalId: uuidv7() })
        .expect(400);
      await post(`/me/subscriptions/${ref}/selection`, user)
        .send({ planKey: target.planKey, version: target.version, reason: 'because' })
        .expect(400);
      await post(`/me/subscriptions/${ref}/selection?actorId=x`, user)
        .send({ planKey: target.planKey, version: target.version })
        .expect(400);

      expect(await writeState()).toEqual(before);
    });

    it('returns selection_already_applied on a replay, and writes nothing', async () => {
      await baseWorkspace();
      const target = await publishedPlanVersion({ includedBookingCredits: 9 });
      const { user } = await professionalOwner();
      const ref = itemsOf((await initialize(user).expect(201)).body)[0].workspaceRef;

      await post(`/me/subscriptions/${ref}/selection`, user)
        .send({ planKey: target.planKey, version: target.version })
        .expect(201);
      const before = await writeState();

      const replay = await post(`/me/subscriptions/${ref}/selection`, user)
        .send({ planKey: target.planKey, version: target.version })
        .expect(409);

      expect(replay.body.error.code).toBe('SUBSCRIPTION_SELECTION_ALREADY_APPLIED');
      expect(await writeState()).toEqual(before);
    });

    it('refuses a non-zero version outright, creating no subscription and no payment fact', async () => {
      await baseWorkspace();
      const paid = await publishedPlanVersion({ unitPriceToman: 500_000 });
      const { user } = await professionalOwner();
      const ref = itemsOf((await initialize(user).expect(201)).body)[0].workspaceRef;

      const before = await writeState();
      const domainBefore = await untouchedDomainState();

      const res = await post(`/me/subscriptions/${ref}/selection`, user)
        .send({ planKey: paid.planKey, version: paid.version })
        .expect(409);

      expect(res.body.error.code).toBe('SUBSCRIPTION_PAID_ACTIVATION_UNAVAILABLE');
      expect(await writeState()).toEqual(before);
      // No payment intent, no order, no notification, and still no outbox table
      // in this schema. #47 blocks paid activation and nothing here anticipates
      // it with a dormant row.
      expect(await untouchedDomainState()).toEqual(domainBefore);

      // The workspace is exactly as it was.
      const entry = itemsOf((await listWorkspaces(user).expect(200)).body)[0];
      expect(entry.baseWorkspace).toBe(true);
    });

    it('gives one indistinguishable refusal for a missing, draft, retired or out-of-window version', async () => {
      await baseWorkspace();
      const draft = await publishedPlanVersion({ lifecycle: 'draft' });
      const retired = await publishedPlanVersion({ lifecycle: 'retired' });
      const future = await publishedPlanVersion({ activationStartsAt: new Date(Date.now() + 86_400_000) });
      const { user } = await professionalOwner();
      const ref = itemsOf((await initialize(user).expect(201)).body)[0].workspaceRef;
      const before = await writeState();

      const attempts = [
        { planKey: 'no-such-plan-key', version: 1 },
        { planKey: draft.planKey, version: draft.version },
        { planKey: retired.planKey, version: retired.version },
        { planKey: future.planKey, version: future.version },
      ];

      const responses = [];
      for (const body of attempts) {
        responses.push(await post(`/me/subscriptions/${ref}/selection`, user).send(body).expect(404));
      }

      const [first, ...rest] = responses;
      expect(first.body.error.code).toBe('SUBSCRIPTION_PLAN_NOT_SELECTABLE');
      for (const res of rest) expect(JSON.stringify(res.body)).toBe(JSON.stringify(first.body));
      expect(await writeState()).toEqual(before);
    });

    it('checks eligibility BEFORE the plan lookup', async () => {
      /*
       * The ordering `V33-DEC-019` requires a test for.
       *
       * A caller who owns nothing asks for a plan that does not exist. If the
       * lookup ran first they would get `plan_version_not_selectable` — and
       * could then distinguish "this plan exists" from "it does not" without
       * owning any workspace at all, which is a catalogue oracle for the whole
       * platform.
       */
      await baseWorkspace();
      const real = await publishedPlanVersion();
      const { user } = await professionalOwner();
      const nobody = await seedUser(app, dataSource, nextPhone(), ['professional']);
      const ref = itemsOf((await initialize(user).expect(201)).body)[0].workspaceRef;

      const withRealPlan = await post(`/me/subscriptions/${ref}/selection`, nobody)
        .send({ planKey: real.planKey, version: real.version })
        .expect(404);
      const withFakePlan = await post(`/me/subscriptions/${ref}/selection`, nobody)
        .send({ planKey: 'no-such-plan-key', version: 1 })
        .expect(404);

      // Same body for an existing plan and a nonexistent one: the eligibility
      // refusal arrived first, so the plan was never looked up.
      expect(JSON.stringify(withFakePlan.body)).toBe(JSON.stringify(withRealPlan.body));
      expect(withRealPlan.body.error.code).toBe('SUBSCRIPTION_SELLER_NOT_ELIGIBLE');
    });

    it('never produces an untranslated 500 when two FIRST selections race', async () => {
      /*
       * The `#56a` defect `V33-DEC-019` records, and the case that fails before
       * the repair.
       *
       * Before the fix `selectPlanVersion` skipped the compare-and-swap when no
       * active subscription existed, so both requests inserted an active row
       * and `uq_seller_subscriptions_one_active_per_party` refused one — as a
       * raw `QueryFailedError`, i.e. a 500 with an untranslated body.
       *
       * Note there is NO initialization first. That is the whole point: the
       * race is only reachable from a party that has no subscription yet.
       */
      await baseWorkspace();
      const target = await publishedPlanVersion({ includedBookingCredits: 5 });
      const { user, partyId } = await professionalOwner();
      const ref = references.referenceFor(user.id, { partyType: 'professional', partyId });

      const results = await Promise.all([
        post(`/me/subscriptions/${ref}/selection`, user).send({ planKey: target.planKey, version: target.version }),
        post(`/me/subscriptions/${ref}/selection`, user).send({ planKey: target.planKey, version: target.version }),
      ]);

      for (const res of results) {
        expect(res.status).not.toBe(500);
        // Every outcome is from the ratified vocabulary — a success, an
        // idempotent replay, or a translated concurrency refusal.
        expect([201, 409]).toContain(res.status);
        if (res.status === 409) {
          expect(['SUBSCRIPTION_SELECTION_ALREADY_APPLIED', 'SUBSCRIPTION_CHANGED_CONCURRENTLY']).toContain(
            res.body.error.code,
          );
        }
      }
      expect(results.some((res) => res.status === 201)).toBe(true);

      // The invariant holds regardless of who won: exactly one active
      // subscription, and a linear chain with no forked successor.
      const rows = await subscriptionRows();
      expect(rows.filter((row: { lifecycle_state: string }) => row.lifecycle_state === 'active')).toHaveLength(1);
      const forked = await dataSource.query(
        `SELECT superseded_by_id FROM commercial.seller_subscriptions
          WHERE superseded_by_id IS NOT NULL GROUP BY superseded_by_id HAVING count(*) > 1`,
      );
      expect(forked).toEqual([]);
    });

    it('produces at most one successor when two DIFFERENT selections race', async () => {
      await baseWorkspace();
      const first = await publishedPlanVersion({ includedBookingCredits: 5 });
      const second = await publishedPlanVersion({ includedBookingCredits: 50 });
      const { user } = await professionalOwner();
      const ref = itemsOf((await initialize(user).expect(201)).body)[0].workspaceRef;

      const results = await Promise.all([
        post(`/me/subscriptions/${ref}/selection`, user).send({ planKey: first.planKey, version: first.version }),
        post(`/me/subscriptions/${ref}/selection`, user).send({ planKey: second.planKey, version: second.version }),
      ]);

      const statuses = results.map((res) => res.status).sort();
      // Exactly one winner. The loser's compare-and-swap matched no row and it
      // was told so, rather than overwriting the winner's transition.
      expect(statuses).toEqual([201, 409]);
      const loser = results.find((res) => res.status === 409);
      expect(loser?.body.error.code).toBe('SUBSCRIPTION_CHANGED_CONCURRENTLY');

      const rows = await subscriptionRows();
      // Base + exactly one successor.
      expect(rows).toHaveLength(2);
      expect(rows.filter((row: { lifecycle_state: string }) => row.lifecycle_state === 'active')).toHaveLength(1);
    });
  });

  // =========================================================================
  // §8. Cancellation
  // =========================================================================

  describe('§8 cancellation', () => {
    it('restores the base workspace in the same transaction and leaves earlier grants alone', async () => {
      const base = await baseWorkspace();
      const target = await publishedPlanVersion({ includedBookingCredits: 25 });
      const { user } = await professionalOwner();
      const ref = itemsOf((await initialize(user).expect(201)).body)[0].workspaceRef;

      await post(`/me/subscriptions/${ref}/selection`, user)
        .send({ planKey: target.planKey, version: target.version })
        .expect(201);

      const grantsBefore = await dataSource.query(
        `SELECT id, quantity, plan_version_id FROM commercial.booking_credit_grants ORDER BY granted_at`,
      );

      const res = await post(`/me/subscriptions/${ref}/cancellation`, user).expect(201);

      expect(res.body.data.subscription.plan.planKey).toBe(base.planKey);
      expect(res.body.data.baseWorkspace).toBe(true);
      expect(res.body.data.availableActions).toEqual(['select_plan']);

      const rows = await subscriptionRows();
      expect(rows.filter((row: { lifecycle_state: string }) => row.lifecycle_state === 'active')).toHaveLength(1);
      expect(rows.filter((row: { lifecycle_state: string }) => row.lifecycle_state === 'cancelled')).toHaveLength(1);

      // The two earlier grants are byte-identical. `V33-DEC-018`: cancellation
      // never edits or deletes a grant already issued.
      const grantsAfter = await dataSource.query(
        `SELECT id, quantity, plan_version_id FROM commercial.booking_credit_grants ORDER BY granted_at`,
      );
      expect(grantsAfter.slice(0, grantsBefore.length)).toEqual(grantsBefore);
    });

    it('is a true no-op when the base workspace is already active', async () => {
      await baseWorkspace();
      const { user } = await professionalOwner();
      const ref = itemsOf((await initialize(user).expect(201)).body)[0].workspaceRef;

      const before = await writeState();
      const rowsBefore = await subscriptionRows();
      const entryBefore = itemsOf((await listWorkspaces(user).expect(200)).body)[0];

      const res = await post(`/me/subscriptions/${ref}/cancellation`, user).expect(201);

      // Not cancel-and-recreate: the SAME row is still active, with the same
      // id and the same effective instant.
      expect(await subscriptionRows()).toEqual(rowsBefore);
      expect(await writeState()).toEqual(before);
      expect(res.body.data).toEqual(entryBefore);

      // And a second no-op is still a no-op.
      await post(`/me/subscriptions/${ref}/cancellation`, user).expect(201);
      expect(await writeState()).toEqual(before);
    });

    it('rejects a body or query field', async () => {
      await baseWorkspace();
      const { user } = await professionalOwner();
      const ref = itemsOf((await initialize(user).expect(201)).body)[0].workspaceRef;

      await post(`/me/subscriptions/${ref}/cancellation`, user).send({ reason: 'because' }).expect(400);
      await post(`/me/subscriptions/${ref}/cancellation?partyId=x`, user).expect(400);
    });
  });

  // =========================================================================
  // §9. Audit, isolation and the story's outer boundary
  // =========================================================================

  describe('§9 audit and isolation', () => {
    it('writes exactly one audit record per successful mutation and none on a refusal', async () => {
      await baseWorkspace();
      const target = await publishedPlanVersion();
      const paid = await publishedPlanVersion({ unitPriceToman: 100 });
      const { user } = await professionalOwner();

      /*
       * DELTAS, not totals.
       *
       * `admin.admin_audit_log` is owned by a role the suite cannot DELETE
       * from — that is the immutability guarantee, not an inconvenience — so
       * `resetDatabase` cannot truncate it and rows accumulate across every
       * case in the run. Counting the table would make this assertion about the
       * whole suite's history rather than about these three mutations.
       */
      const countFor = async (action: string): Promise<number> =>
        (await dataSource.query(`SELECT count(*)::int AS n FROM admin.admin_audit_log WHERE action = $1`, [action]))[0]
          .n;

      const assignedBefore = await countFor('commercial.subscription_assigned');
      const activatedBefore = await countFor('commercial.subscription_activated');
      const supersededBefore = await countFor('commercial.subscription_superseded');
      const cancelledBefore = await countFor('commercial.subscription_cancelled');

      const ref = itemsOf((await initialize(user).expect(201)).body)[0].workspaceRef;
      expect((await countFor('commercial.subscription_assigned')) - assignedBefore).toBe(1);

      await post(`/me/subscriptions/${ref}/selection`, user)
        .send({ planKey: target.planKey, version: target.version })
        .expect(201);
      expect((await countFor('commercial.subscription_activated')) - activatedBefore).toBe(1);
      expect((await countFor('commercial.subscription_superseded')) - supersededBefore).toBe(1);

      await post(`/me/subscriptions/${ref}/cancellation`, user).expect(201);
      expect((await countFor('commercial.subscription_cancelled')) - cancelledBefore).toBe(1);
      // Two assignments now: the initial one, and the base workspace restored
      // by the cancellation in the same transaction.
      expect((await countFor('commercial.subscription_assigned')) - assignedBefore).toBe(2);

      // Now every refusal shape, and none of them may add a row.
      const after = await commercialAuditCount();
      await initialize(user).expect(201);
      await post(`/me/subscriptions/${ref}/cancellation`, user).expect(201);
      await post(`/me/subscriptions/${ref}/selection`, user).send({ planKey: 'nope', version: 1 }).expect(404);
      await post(`/me/subscriptions/${ref}/selection`, user)
        .send({ planKey: paid.planKey, version: paid.version })
        .expect(409);
      await post(`/me/subscriptions/${ref}/selection`, user).send({ planKey: 'x', version: 0 }).expect(400);
      await get(`/me/subscriptions/${'A'.repeat(43)}/history`, user).expect(404);
      expect(await commercialAuditCount()).toBe(after);
    });

    it('records the authenticated actor, and no caller-supplied prose', async () => {
      await baseWorkspace();
      const target = await publishedPlanVersion();
      const { user } = await professionalOwner();
      const ref = itemsOf((await initialize(user).expect(201)).body)[0].workspaceRef;

      await post(`/me/subscriptions/${ref}/selection`, user)
        .send({ planKey: target.planKey, version: target.version })
        .expect(201);

      // Scoped to THIS actor: the audit log is append-only and untruncatable
      // between cases, so an unscoped query would return every earlier case's
      // rows too.
      const rows = await dataSource.query(
        `SELECT actor_user_id, actor_label, reason FROM admin.admin_audit_log
          WHERE action = 'commercial.subscription_activated' AND actor_user_id = $1`,
        [user.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_user_id).toBe(user.id);
      expect(rows[0].actor_label).toBeNull();
      // A fixed, server-generated constant.
      expect(rows[0].reason).toBe('seller selected a published plan version');
    });

    it('leaves the other workspace byte-identical when a dual owner mutates one', async () => {
      await baseWorkspace();
      const target = await publishedPlanVersion({ includedBookingCredits: 40 });
      const { user } = await dualOwner();

      const before = itemsOf((await initialize(user).expect(201)).body);
      const [business, professional] = before;

      await post(`/me/subscriptions/${professional.workspaceRef}/selection`, user)
        .send({ planKey: target.planKey, version: target.version })
        .expect(201);

      const afterFirst = itemsOf((await listWorkspaces(user).expect(200)).body);
      // The business entry, whole: same reference, same plan, same actions,
      // same everything. A field-by-field check would pass while some other
      // field had moved.
      expect(afterFirst[0]).toEqual(business);
      expect(afterFirst[1]).not.toEqual(professional);

      // And the reverse direction, so neither ordering is a special case.
      await post(`/me/subscriptions/${business.workspaceRef}/cancellation`, user).expect(201);
      const afterSecond = itemsOf((await listWorkspaces(user).expect(200)).body);
      expect(afterSecond[1]).toEqual(afterFirst[1]);
    });

    it('keeps one workspace history out of the other', async () => {
      await baseWorkspace();
      const target = await publishedPlanVersion({ includedBookingCredits: 40 });
      const { user } = await dualOwner();
      const [business, professional] = itemsOf((await initialize(user).expect(201)).body);

      await post(`/me/subscriptions/${professional.workspaceRef}/selection`, user)
        .send({ planKey: target.planKey, version: target.version })
        .expect(201);

      const professionalHistory = (await get(`/me/subscriptions/${professional.workspaceRef}/history`, user).expect(200))
        .body.data.items;
      const businessHistory = (await get(`/me/subscriptions/${business.workspaceRef}/history`, user).expect(200)).body
        .data.items;

      // Newest first, and only this workspace's chain.
      expect(professionalHistory).toHaveLength(2);
      expect(professionalHistory[0].plan.planKey).toBe(target.planKey);
      expect(professionalHistory[0].state).toBe('active');
      expect(professionalHistory[1].state).toBe('superseded');
      expect(businessHistory).toHaveLength(1);
      expect(JSON.stringify(businessHistory)).not.toContain(target.planKey);

      // No identity of any kind in a history entry.
      expect(Object.keys(professionalHistory[0]).sort()).toEqual([
        'cancelledAt',
        'effectiveAt',
        'entitlements',
        'plan',
        'price',
        'state',
        'supersededAt',
      ]);
    });

    it('produces no event, payment, order or notification anywhere in the story', async () => {
      await baseWorkspace();
      const target = await publishedPlanVersion();
      const { user } = await dualOwner();
      const domainBefore = await untouchedDomainState();

      const [business, professional] = itemsOf((await initialize(user).expect(201)).body);
      await post(`/me/subscriptions/${professional.workspaceRef}/selection`, user)
        .send({ planKey: target.planKey, version: target.version })
        .expect(201);
      await post(`/me/subscriptions/${professional.workspaceRef}/cancellation`, user).expect(201);
      await post(`/me/subscriptions/${business.workspaceRef}/cancellation`, user).expect(201);

      expect(await untouchedDomainState()).toEqual(domainBefore);
      expect(domainBefore['commercial.outbox_events_absent']).toBe(0);
    });

    it('maps all six routes on the running application', async () => {
      /*
       * Asserted against the ROUTE TABLE Nest actually built, not against the
       * decorators — the same reasoning `audit-enforcement` records. A
       * controller that is declared but never registered by a module produces
       * exactly the decorators this would otherwise be reading, and no routes.
       */
      const server = app.getHttpServer();
      const router = server._events.request._router;
      const paths: string[] = router.stack
        .filter((layer: { route?: { path: string } }) => layer.route)
        .map((layer: { route: { path: string; methods: Record<string, boolean> } }) =>
          `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`,
        );

      for (const route of [
        'POST /api/v1/me/subscriptions/initialization',
        'GET /api/v1/me/subscriptions',
        'GET /api/v1/me/subscriptions/:workspaceRef/history',
        'POST /api/v1/me/subscriptions/:workspaceRef/selection',
        'POST /api/v1/me/subscriptions/:workspaceRef/cancellation',
        'GET /api/v1/me/commercial-plans',
      ]) {
        expect(paths).toContain(route);
      }

      // The discovery half, and the boundary: this controller contributes SIX
      // routes and no seventh.
      const own = paths.filter(
        (path) => path.includes('/me/subscriptions') || path.includes('/me/commercial-plans'),
      );
      expect(own).toHaveLength(6);
      expect(SellerSubscriptionSurfaceController.name).toBe('SellerSubscriptionSurfaceController');
    });
  });
});

/**
 * Counts every statement TypeORM executes.
 *
 * `QueryRunner.query` calls `logger.logQuery` unconditionally — the LOGGER
 * decides whether to print, not the caller — so swapping the instance counts
 * real statements without turning on query logging for the whole suite.
 */
class CountingLogger {
  count = 0;

  reset(): void {
    this.count = 0;
  }

  logQuery(): void {
    this.count += 1;
  }

  logQueryError(): void {}
  logQuerySlow(): void {}
  logSchemaBuild(): void {}
  logMigration(): void {}
  log(): void {}
}
