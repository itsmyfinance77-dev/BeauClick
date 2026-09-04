import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { StaffService, BusinessService } from '@beauclick/business';
import { OrderService } from '@beauclick/commerce';
import {
  FINANCIAL_PARTY_RESOLVER,
  FinanceWorkspaceService,
  FinancialPartyResolver,
  MyFinanceService,
} from '@beauclick/financial';

import { createPgTestApp, requiredPgEnv, resetDatabase, seedBusiness, seedProfessional, seedUser } from './pg-test-app.factory';

/**
 * REAL PostgreSQL: business authorization (ADR-023) and the financial-party
 * resolution it drives.
 *
 * The consent invariant matters most here -- an owner must never be able to
 * grant themselves a professional's earnings by naming an id they do not
 * control -- so it is proved end-to-end through HTTP, not by calling
 * StaffService directly, since the guard/resolver wiring is exactly what a
 * unit test cannot exercise.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

describeIfPg('Business authorization on real PostgreSQL', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let businesses: BusinessService;
  let staff: StaffService;
  let orders: OrderService;
  let myFinance: MyFinanceService;
  let workspaces: FinanceWorkspaceService;
  let financialParties: FinancialPartyResolver;

  beforeAll(async () => {
    const ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    businesses = app.get(BusinessService);
    staff = app.get(StaffService);
    orders = app.get(OrderService);
    myFinance = app.get(MyFinanceService);
    workspaces = app.get(FinanceWorkspaceService);
    financialParties = app.get<FinancialPartyResolver>(FINANCIAL_PARTY_RESOLVER);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  describe('cross-business isolation', () => {
    it('a stranger gets the same 404 whether the business exists or not -- ids are non-enumerable', async () => {
      const ownerA = await seedUser(app, dataSource, `+98922${String(Date.now()).slice(-6)}`, ['business']);
      const businessA = await seedBusiness(dataSource, ownerA.id, 'کسب‌وکار A');
      const strangerToken = (await seedUser(app, dataSource, `+98923${String(Date.now()).slice(-6)}`)).accessToken;

      const real = await request(app.getHttpServer())
        .get(`/api/v1/businesses/${businessA.id}`)
        .set('Authorization', `Bearer ${strangerToken}`)
        .expect(404);
      const fake = await request(app.getHttpServer())
        .get(`/api/v1/businesses/${uuidv7()}`)
        .set('Authorization', `Bearer ${strangerToken}`)
        .expect(404);
      expect(real.body).toEqual(fake.body);
    });

    it("Business B's owner cannot invite staff into Business A", async () => {
      const ownerA = await seedUser(app, dataSource, `+98924${String(Date.now()).slice(-6)}`, ['business']);
      const businessA = await seedBusiness(dataSource, ownerA.id, 'A');
      const ownerB = await seedUser(app, dataSource, `+98925${String(Date.now()).slice(-6)}`, ['business']);
      await seedBusiness(dataSource, ownerB.id, 'B');
      const target = await seedUser(app, dataSource, `+98926${String(Date.now()).slice(-6)}`);

      await request(app.getHttpServer())
        .post(`/api/v1/businesses/${businessA.id}/staff`)
        .set('Authorization', `Bearer ${ownerB.accessToken}`)
        .send({ userId: target.id, role: 'staff' })
        .expect(404);

      expect(await staff.roleFor(businessA.id, target.id)).toBeNull();
    });

    it('a plain customer with no business at all is denied every business-scoped route', async () => {
      const ownerA = await seedUser(app, dataSource, `+98927${String(Date.now()).slice(-6)}`, ['business']);
      const businessA = await seedBusiness(dataSource, ownerA.id, 'A');
      const customer = await seedUser(app, dataSource, `+98928${String(Date.now()).slice(-6)}`);

      await request(app.getHttpServer())
        .get(`/api/v1/businesses/${businessA.id}`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(404);
      await request(app.getHttpServer())
        .patch(`/api/v1/businesses/${businessA.id}`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ displayName: 'hijacked' })
        .expect(404);
    });
  });

  describe('staff consent -- an owner cannot grant themselves access by naming an id they do not control', () => {
    it('an invited user has NO access until they accept, and only their own token can accept', async () => {
      const owner = await seedUser(app, dataSource, `+98929${String(Date.now()).slice(-6)}`, ['business']);
      const business = await seedBusiness(dataSource, owner.id, 'Salon');
      const invitee = await seedUser(app, dataSource, `+98930${String(Date.now()).slice(-6)}`);

      const invited = await request(app.getHttpServer())
        .post(`/api/v1/businesses/${business.id}/staff`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ userId: invitee.id, role: 'staff' })
        .expect(201);

      // Invited, not yet a member: the invitee cannot yet see the business.
      await request(app.getHttpServer())
        .get(`/api/v1/businesses/${business.id}`)
        .set('Authorization', `Bearer ${invitee.accessToken}`)
        .expect(404);

      // The OWNER cannot accept on the invitee's behalf.
      await request(app.getHttpServer())
        .post(`/api/v1/me/business-staff/${invited.body.data.id}/accept`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(404);

      // Only the real invitee can.
      await request(app.getHttpServer())
        .post(`/api/v1/me/business-staff/${invited.body.data.id}/accept`)
        .set('Authorization', `Bearer ${invitee.accessToken}`)
        .expect(201);

      await request(app.getHttpServer())
        .get(`/api/v1/businesses/${business.id}`)
        .set('Authorization', `Bearer ${invitee.accessToken}`)
        .expect(200);
    });

    it('a manager can edit the profile; plain staff cannot', async () => {
      const owner = await seedUser(app, dataSource, `+98931${String(Date.now()).slice(-6)}`, ['business']);
      const business = await seedBusiness(dataSource, owner.id, 'Salon');
      const manager = await seedUser(app, dataSource, `+98932${String(Date.now()).slice(-6)}`);
      const plainStaff = await seedUser(app, dataSource, `+98933${String(Date.now()).slice(-6)}`);

      for (const [user, role] of [[manager, 'manager'], [plainStaff, 'staff']] as const) {
        const invited = await staff.invite(business.id, owner.id, { userId: user.id, role });
        await staff.accept(invited.id, user.id);
      }

      await request(app.getHttpServer())
        .patch(`/api/v1/businesses/${business.id}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ displayName: 'Renamed by manager' })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/api/v1/businesses/${business.id}`)
        .set('Authorization', `Bearer ${plainStaff.accessToken}`)
        .send({ displayName: 'Should be refused' })
        .expect(404);
    });

    it('the owner removes a staff member; the removed member loses access immediately', async () => {
      const owner = await seedUser(app, dataSource, `+98934${String(Date.now()).slice(-6)}`, ['business']);
      const business = await seedBusiness(dataSource, owner.id, 'Salon');
      const member = await seedUser(app, dataSource, `+98935${String(Date.now()).slice(-6)}`);
      const invited = await staff.invite(business.id, owner.id, { userId: member.id, role: 'staff' });
      await staff.accept(invited.id, member.id);

      await request(app.getHttpServer())
        .post(`/api/v1/businesses/${business.id}/staff/${invited.id}/remove`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(201);

      await request(app.getHttpServer())
        .get(`/api/v1/businesses/${business.id}`)
        .set('Authorization', `Bearer ${member.accessToken}`)
        .expect(404);
    });
  });

  describe('financial party resolution (ADR-023 §3) -- the point of the whole feature', () => {
    it('an independent professional (no business) is their own financial party', async () => {
      const owner = await seedUser(app, dataSource, `+98936${String(Date.now()).slice(-6)}`, ['professional']);
      const professional = await seedProfessional(dataSource, owner.id, 'مستقل');

      const detail = await orders.createForBooking({
        bookingId: uuidv7(),
        customerId: uuidv7(),
        professionalId: professional.id,
        serviceId: professional.serviceId,
      });
      expect(detail.order.sellerPartyType).toBe('professional');
      expect(detail.order.sellerPartyId).toBe(professional.id);

      const summary = await myFinance.mySummary(owner.id);
      expect(summary?.partyType).toBe('professional');
      expect(summary?.partyId).toBe(professional.id);
    });

    it('a professional affiliated with a business SELLS for it but may not READ its finance', async () => {
      const businessOwner = await seedUser(app, dataSource, `+98937${String(Date.now()).slice(-6)}`, ['business']);
      const business = await businesses.create(businessOwner.id, { displayName: 'سالن بزرگ' });
      const proOwner = await seedUser(app, dataSource, `+98938${String(Date.now()).slice(-6)}`, ['professional']);
      const professional = await seedProfessional(dataSource, proOwner.id, 'کارمند');

      const invited = await staff.invite(business.id, businessOwner.id, {
        userId: proOwner.id,
        professionalId: professional.id,
        role: 'staff',
      });
      await staff.accept(invited.id, proOwner.id);

      const detail = await orders.createForBooking({
        bookingId: uuidv7(),
        customerId: uuidv7(),
        professionalId: professional.id,
        serviceId: professional.serviceId,
      });
      expect(detail.order.sellerPartyType).toBe('business');
      expect(detail.order.sellerPartyId).toBe(business.id);

      /*
       * ATTRIBUTION is unchanged, and that is the half this case still proves.
       *
       * The order sells FOR the business, the ledger rows are written against
       * the business party, and `FinancialPartyResolver` — the BENEFICIARY
       * port — still answers `business` for the affiliated professional's own
       * user id. Their earnings genuinely moved; this is not an order-time
       * label.
       */
      const beneficiary = await financialParties.resolveForUser(proOwner.id);
      expect(beneficiary).toEqual({ partyType: 'business', partyId: business.id });

      /*
       * READ AUTHORIZATION is not attribution — V3.3 #72, `V33-DEC-020`.
       *
       * ## What this case used to assert, and why it was wrong
       *
       * Until #72 it read:
       *
       *     const proSummary = await myFinance.mySummary(proOwner.id);
       *     expect(proSummary?.partyType).toBe('business');
       *     expect(proSummary?.partyId).toBe(business.id);
       *
       * — i.e. it asserted that an affiliated professional's own finance screen
       * shows the EMPLOYER's receivable, settlement and outstanding position,
       * aggregated across every other staff member and the owner. That is a
       * cross-party financial disclosure, and the assertion was codifying it as
       * correct because attribution and permission were being answered by one
       * resolver.
       *
       * `V33-DEC-020` ruled that staff affiliation is not financial ownership.
       * The staff member now sees their OWN professional party, which may
       * legitimately be empty or zero, and the server must not fall back to the
       * employer's figures to avoid an empty screen.
       *
       * ## This fails against the old resolver
       *
       * Restore `MyFinanceService` to `FINANCIAL_PARTY_RESOLVER` and the first
       * expectation below returns `business` — the probe is exactly the diff
       * this bug reverted.
       */
      const proSummary = await myFinance.mySummary(proOwner.id);
      expect(proSummary?.partyType).toBe('professional');
      expect(proSummary?.partyId).toBe(professional.id);
      // Truthfully zero: every Toman they earned belongs to the business.
      expect(proSummary?.receivableNetToman).toBe(0);

      // POSITIVE CONTROL 1 — the business owner still reads the business.
      // Without this, the assertion above would pass against a service that had
      // simply stopped resolving anybody.
      const ownerSummary = await myFinance.mySummary(businessOwner.id);
      expect(ownerSummary?.partyType).toBe('business');
      expect(ownerSummary?.partyId).toBe(business.id);

      // POSITIVE CONTROL 2 — the staff professional's own party is genuinely
      // readable, so "restricted to their own" is distinguishable from
      // "refused everything".
      const ownWorkspaces = await workspaces.ownedWorkspaces(proOwner.id);
      expect(ownWorkspaces).toEqual([{ partyType: 'professional', partyId: professional.id }]);
      // And the employer's workspace is nowhere in it.
      expect(ownWorkspaces.some((party) => party.partyId === business.id)).toBe(false);
    });

    it('deactivating the staff membership reverts the professional to their own party for FUTURE orders', async () => {
      const businessOwner = await seedUser(app, dataSource, `+98939${String(Date.now()).slice(-6)}`, ['business']);
      const business = await businesses.create(businessOwner.id, { displayName: 'سالن' });
      const proOwner = await seedUser(app, dataSource, `+98940${String(Date.now()).slice(-6)}`, ['professional']);
      const professional = await seedProfessional(dataSource, proOwner.id, 'کارمند سابق');

      const invited = await staff.invite(business.id, businessOwner.id, {
        userId: proOwner.id,
        professionalId: professional.id,
        role: 'staff',
      });
      await staff.accept(invited.id, proOwner.id);
      await staff.deactivate(invited.id);

      const detail = await orders.createForBooking({
        bookingId: uuidv7(),
        customerId: uuidv7(),
        professionalId: professional.id,
        serviceId: professional.serviceId,
      });
      expect(detail.order.sellerPartyType).toBe('professional');
      expect(detail.order.sellerPartyId).toBe(professional.id);
    });
  });
});
