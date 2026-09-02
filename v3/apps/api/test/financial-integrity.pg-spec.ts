import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { LedgerService, MyFinanceService, SettlementService } from '@beauclick/financial';
import { SandboxPaymentProvider } from '@beauclick/payment';
import { OrderService } from '@beauclick/commerce';
import { assertNoLeak } from '@beauclick/testing';
import { CheckoutService } from '../src/checkout/checkout.service';

import {
  PgTestApp,
  createPgTestApp,
  financialOwnerUrl,
  futureSlotTime,
  requireFinancialOwnerUrl,
  requiredPgEnv,
  resetDatabase,
  resetFinancial,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

/**
 * financial-service against real PostgreSQL: immutability, commission
 * correctness, refund reversal, settlement, and party isolation.
 *
 * The immutability half of this suite is the direct closure of GAP-01, and
 * it is only meaningful because the roles involved are genuinely
 * unprivileged -- `usesuper = false` is asserted explicitly, since granting
 * SUPERUSER would make every other assertion here pass for the wrong reason.
 */
/**
 * This suite's gate was already correct; its CAST was not.
 *
 * The gate reads `financialOwnerUrl()` and `beforeEach` calls
 * `requireFinancialOwnerUrl()`, which returns `string` -- so `resetFinancial`
 * receives a proven value rather than an asserted one. The assertion is removed
 * rather than kept as harmless belt-and-braces: an `as string` that happens to
 * be safe today is the line the next suite copies, which is how the sibling
 * suite acquired it.
 */
const OWNER_URL = financialOwnerUrl();
const READER_URL = process.env.TEST_FINANCIAL_READER_URL;
const describeIfPg = requiredPgEnv() && OWNER_URL ? describe : describe.skip;

describeIfPg('Financial integrity on real PostgreSQL', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let financialDataSource: DataSource;
  let ledger: LedgerService;
  let settlements: SettlementService;
  let myFinance: MyFinanceService;
  let orders: OrderService;
  let checkout: CheckoutService;
  let sandbox: SandboxPaymentProvider;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    financialDataSource = ctx.financialDataSource;
    ledger = app.get(LedgerService);
    settlements = app.get(SettlementService);
    myFinance = app.get(MyFinanceService);
    orders = app.get(OrderService);
    checkout = app.get(CheckoutService);
    sandbox = app.get(SandboxPaymentProvider);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    await resetFinancial(requireFinancialOwnerUrl());
  });

  // -------------------------------------------------------------------
  // GAP-01: immutability, enforced by PostgreSQL
  // -------------------------------------------------------------------

  describe('the ledger is append-only, enforced by the database (GAP-01)', () => {
    const ENTRY_ID = '01926a3e-1111-7000-8000-00000000aaaa';

    async function insertEntry(): Promise<void> {
      await financialDataSource.query(
        `INSERT INTO financial.ledger_entries
           (id, order_id, party_type, party_id, entry_type, amount_toman, basis, commission_rate_bp, reference_type, reference_id)
         VALUES ($1, $2, 'professional', $3, 'receivable', 170000, 'net_customer_amount', 1500, 'order_payment', $4)`,
        [ENTRY_ID, uuidv7(), uuidv7(), uuidv7()],
      );
    }

    it('connects as a role that is NOT a superuser (a superuser would void every other assertion here)', async () => {
      const [row] = await financialDataSource.query('SELECT usesuper FROM pg_user WHERE usename = current_user');
      expect(row.usesuper).toBe(false);
    });

    it('allows INSERT and SELECT -- the ledger must still work', async () => {
      await insertEntry();
      const rows = await financialDataSource.query('SELECT amount_toman FROM financial.ledger_entries WHERE id = $1', [ENTRY_ID]);
      expect(rows).toHaveLength(1);
    });

    it('DENIES UPDATE at the database level', async () => {
      await insertEntry();
      await expect(
        financialDataSource.query('UPDATE financial.ledger_entries SET amount_toman = 999999 WHERE id = $1', [ENTRY_ID]),
      ).rejects.toThrow(/permission denied/i);
    });

    it('DENIES DELETE at the database level', async () => {
      await insertEntry();
      await expect(
        financialDataSource.query('DELETE FROM financial.ledger_entries WHERE id = $1', [ENTRY_ID]),
      ).rejects.toThrow(/permission denied/i);
    });

    it('DENIES TRUNCATE at the database level', async () => {
      await expect(financialDataSource.query('TRUNCATE financial.ledger_entries')).rejects.toThrow(/permission denied/i);
    });

    it('leaves the row byte-identical after every denied mutation', async () => {
      await insertEntry();
      const before = await financialDataSource.query('SELECT * FROM financial.ledger_entries WHERE id = $1', [ENTRY_ID]);
      await financialDataSource.query('UPDATE financial.ledger_entries SET amount_toman = 1 WHERE id = $1', [ENTRY_ID]).catch(() => undefined);
      await financialDataSource.query('DELETE FROM financial.ledger_entries WHERE id = $1', [ENTRY_ID]).catch(() => undefined);
      const after = await financialDataSource.query('SELECT * FROM financial.ledger_entries WHERE id = $1', [ENTRY_ID]);
      expect(after).toEqual(before);
    });

    it('DENIES UPDATE on settlement tables too -- settlements are append-only as well', async () => {
      await expect(financialDataSource.query(`UPDATE financial.settlement_batches SET note = 'x'`)).rejects.toThrow(
        /permission denied/i,
      );
      await expect(financialDataSource.query(`UPDATE financial.settlement_items SET amount_toman = 1`)).rejects.toThrow(
        /permission denied/i,
      );
    });

    it('ALLOWS UPDATE on the outbox alone -- the one deliberate, narrow exception', async () => {
      // Delivery receipts, not financial facts. Scoped so the relay can mark
      // a row published without the schema needing a general UPDATE grant.
      await expect(
        financialDataSource.query(`UPDATE financial.outbox_events SET published_at = now() WHERE id = $1`, [uuidv7()]),
      ).resolves.toBeDefined();
    });

    it('denies the MAIN APPLICATION role even a SELECT on the ledger', async () => {
      // Stronger than the blueprint required: the pool every controller,
      // guard, and background job shares cannot read the ledger at all.
      await expect(dataSource.query('SELECT count(*) FROM financial.ledger_entries')).rejects.toThrow(
        /permission denied/i,
      );
    });

    it('denies the MAIN APPLICATION role any write to the ledger', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO financial.ledger_entries (id, order_id, party_type, entry_type, amount_toman, basis, commission_rate_bp, reference_type, reference_id)
           VALUES ($1, $2, 'platform', 'commission', 1, 'x', 1500, 'order_payment', $3)`,
          [uuidv7(), uuidv7(), uuidv7()],
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    (READER_URL ? it : it.skip)('gives the read-only role SELECT but never INSERT', async () => {
      const reader = new Client({ connectionString: READER_URL });
      await reader.connect();
      try {
        await expect(reader.query('SELECT count(*) FROM financial.ledger_entries')).resolves.toBeDefined();
        await expect(
          reader.query(
            `INSERT INTO financial.ledger_entries (id, order_id, party_type, entry_type, amount_toman, basis, commission_rate_bp, reference_type, reference_id)
             VALUES ($1, $2, 'platform', 'commission', 1, 'x', 1500, 'order_payment', $3)`,
            [uuidv7(), uuidv7(), uuidv7()],
          ),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await reader.end();
      }
    });
  });

  // -------------------------------------------------------------------
  // Commission and refunds
  // -------------------------------------------------------------------

  describe('commission and refund arithmetic', () => {
    const orderId = '01926a3e-2222-7000-8000-00000000bbbb';
    const partyId = '01926a3e-2222-7000-8000-00000000cccc';
    const paymentRef = '01926a3e-2222-7000-8000-00000000dddd';

    async function recordPayment(netAmountToman: number) {
      return ledger.recordPayment({
        orderId,
        sourceId: null,
        sellerPartyType: 'professional',
        sellerPartyId: partyId,
        netAmountToman,
        paymentReferenceId: paymentRef,
      });
    }

    it('splits a payment into commission + receivable that sum EXACTLY to the amount paid', async () => {
      expect(await recordPayment(200_000)).toBe(true);

      const entries = await ledger.entriesForOrder(orderId);
      const commission = entries.find((e) => e.entryType === 'commission');
      const receivable = entries.find((e) => e.entryType === 'receivable');

      expect(commission?.amountToman).toBe(30_000); // 15%
      expect(receivable?.amountToman).toBe(170_000);
      expect((commission?.amountToman ?? 0) + (receivable?.amountToman ?? 0)).toBe(200_000);
    });

    it('captures the commission rate ON THE ROW, not by live lookup', async () => {
      await recordPayment(200_000);
      const entries = await ledger.entriesForOrder(orderId);
      expect(entries.every((e) => e.commissionRateBp === 1500)).toBe(true);
      expect(entries.every((e) => e.basis === 'net_customer_amount')).toBe(true);
    });

    it('is idempotent: a redelivered payment event records nothing further', async () => {
      expect(await recordPayment(200_000)).toBe(true);
      expect(await recordPayment(200_000)).toBe(false);
      expect(await recordPayment(200_000)).toBe(false);
      expect(await ledger.entriesForOrder(orderId)).toHaveLength(2);
    });

    it('is idempotent under genuinely CONCURRENT payment recording', async () => {
      const results = await Promise.all([recordPayment(200_000), recordPayment(200_000), recordPayment(200_000)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await ledger.entriesForOrder(orderId)).toHaveLength(2);
    });

    it('reverses a refund at the ORIGINAL captured rate, not the platform current rate', async () => {
      await recordPayment(200_000);

      // The platform changes its commission after the fact. The refund must
      // be immune to it -- this is V2's most important financial rule.
      const originalRate = process.env.FINANCIAL_COMMISSION_RATE_BP;
      process.env.FINANCIAL_COMMISSION_RATE_BP = '5000';
      try {
        const refundId = uuidv7();
        expect(await ledger.recordRefund({ orderId, refundId, refundAmountToman: 200_000 })).toBe(true);

        const entries = await ledger.entriesForOrder(orderId);
        const reversal = entries.filter((e) => e.referenceType === 'order_refund');
        expect(reversal).toHaveLength(2);
        // Reversed at 15%, not the new 50%.
        expect(reversal.every((e) => e.commissionRateBp === 1500)).toBe(true);
        expect(reversal.find((e) => e.entryType === 'commission')?.amountToman).toBe(-30_000);
        expect(reversal.find((e) => e.entryType === 'receivable')?.amountToman).toBe(-170_000);
      } finally {
        if (originalRate === undefined) delete process.env.FINANCIAL_COMMISSION_RATE_BP;
        else process.env.FINANCIAL_COMMISSION_RATE_BP = originalRate;
      }
    });

    it('nets a full refund back to exactly zero', async () => {
      await recordPayment(200_000);
      await ledger.recordRefund({ orderId, refundId: uuidv7(), refundAmountToman: 200_000 });
      expect(await ledger.orderReceivableNet(orderId)).toBe(0);
      expect(await ledger.partyReceivableNet('professional', partyId)).toBe(0);
    });

    it('handles a PARTIAL refund proportionally', async () => {
      await recordPayment(200_000);
      await ledger.recordRefund({ orderId, refundId: uuidv7(), refundAmountToman: 50_000 });

      // 15% of 50,000 = 7,500 commission reversed; 42,500 receivable reversed.
      expect(await ledger.orderReceivableNet(orderId)).toBe(170_000 - 42_500);
      const entries = await ledger.entriesForOrder(orderId);
      const refundPair = entries.filter((e) => e.referenceType === 'order_refund');
      expect(refundPair.reduce((sum, e) => sum + e.amountToman, 0)).toBe(-50_000);
    });

    it('is idempotent on a replayed refund', async () => {
      await recordPayment(200_000);
      const refundId = uuidv7();
      expect(await ledger.recordRefund({ orderId, refundId, refundAmountToman: 50_000 })).toBe(true);
      expect(await ledger.recordRefund({ orderId, refundId, refundAmountToman: 50_000 })).toBe(false);
      expect(await ledger.orderReceivableNet(orderId)).toBe(170_000 - 42_500);
    });

    it('records nothing for a refund against an order that never had a payment', async () => {
      expect(
        await ledger.recordRefund({ orderId: uuidv7(), refundId: uuidv7(), refundAmountToman: 10_000 }),
      ).toBe(false);
    });

    it('refuses to record a negative payment', async () => {
      await expect(
        ledger.recordPayment({
          orderId: uuidv7(),
          sourceId: null,
          sellerPartyType: 'professional',
          sellerPartyId: partyId,
          netAmountToman: -1,
          paymentReferenceId: uuidv7(),
        }),
      ).rejects.toThrow(/must not be negative/);
    });

    it('keeps commission + receivable summing exactly, across many awkward amounts', async () => {
      for (const amount of [1, 3, 7, 33, 12_345, 199_999, 1_000_001]) {
        const oid = uuidv7();
        await ledger.recordPayment({
          orderId: oid,
          sourceId: null,
          sellerPartyType: 'professional',
          sellerPartyId: partyId,
          netAmountToman: amount,
          paymentReferenceId: uuidv7(),
        });
        const entries = await ledger.entriesForOrder(oid);
        expect(entries.reduce((sum, e) => sum + e.amountToman, 0)).toBe(amount);
      }
    });
  });

  // -------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------

  describe('settlement', () => {
    const partyId = '01926a3e-3333-7000-8000-00000000eeee';

    async function seedReceivable(amount: number): Promise<string> {
      const orderId = uuidv7();
      await ledger.recordPayment({
        orderId,
        sourceId: null,
        sellerPartyType: 'professional',
        sellerPartyId: partyId,
        netAmountToman: amount,
        paymentReferenceId: uuidv7(),
      });
      return orderId;
    }

    it('computes outstanding from the ledger, always fresh', async () => {
      const orderId = await seedReceivable(200_000);
      expect(await settlements.outstandingForOrder(orderId)).toBe(170_000);

      const summary = await settlements.partySummary('professional', partyId);
      expect(summary.receivableNetToman).toBe(170_000);
      expect(summary.settledToman).toBe(0);
      expect(summary.outstandingToman).toBe(170_000);
    });

    it('settles specific orders in full, at the system-computed amount', async () => {
      const a = await seedReceivable(200_000);
      const b = await seedReceivable(100_000);

      const batch = await settlements.createSettlement({
        partyType: 'professional',
        partyId,
        orderIds: [a, b],
        method: 'bank_transfer',
        reference: 'TRX-1',
        note: null,
        actorId: uuidv7(),
      });

      expect(batch.amountToman).toBe(170_000 + 85_000);
      expect(await settlements.outstandingForOrder(a)).toBe(0);
      expect((await settlements.partySummary('professional', partyId)).outstandingToman).toBe(0);
    });

    it('refuses to settle the same order twice', async () => {
      const orderId = await seedReceivable(200_000);
      const actorId = uuidv7();
      await settlements.createSettlement({ partyType: 'professional', partyId, orderIds: [orderId], method: null, reference: null, note: null, actorId });

      await expect(
        settlements.createSettlement({ partyType: 'professional', partyId, orderIds: [orderId], method: null, reference: null, note: null, actorId }),
      ).rejects.toThrow(/قابل تسویه نیست/);
    });

    it("refuses to settle another party's order", async () => {
      const orderId = await seedReceivable(200_000);
      await expect(
        settlements.createSettlement({
          partyType: 'professional',
          partyId: uuidv7(), // a different party
          orderIds: [orderId],
          method: null,
          reference: null,
          note: null,
          actorId: uuidv7(),
        }),
      ).rejects.toThrow(/قابل تسویه نیست/);
    });

    it('reverses a settlement non-destructively, leaving the original row intact', async () => {
      const orderId = await seedReceivable(200_000);
      const batch = await settlements.createSettlement({
        partyType: 'professional',
        partyId,
        orderIds: [orderId],
        method: null,
        reference: null,
        note: null,
        actorId: uuidv7(),
      });

      const reversal = await settlements.reverseSettlement(batch.id, uuidv7(), 'bank returned the transfer');

      expect(reversal.kind).toBe('reversal');
      expect(reversal.amountToman).toBe(-batch.amountToman);

      // The original is untouched -- it could not be updated even if the code
      // wanted to.
      const original = await settlements.findSettlement(batch.id);
      expect(original?.amountToman).toBe(batch.amountToman);
      expect(original?.kind).toBe('settlement');

      // And the balance is back.
      expect(await settlements.outstandingForOrder(orderId)).toBe(170_000);
    });

    it('refuses to reverse the same settlement twice', async () => {
      const orderId = await seedReceivable(200_000);
      const batch = await settlements.createSettlement({ partyType: 'professional', partyId, orderIds: [orderId], method: null, reference: null, note: null, actorId: uuidv7() });
      await settlements.reverseSettlement(batch.id, uuidv7(), 'first');
      await expect(settlements.reverseSettlement(batch.id, uuidv7(), 'second')).rejects.toThrow(/قبلاً برگشت خورده/);
    });

    it('lets outstanding go NEGATIVE after a refund lands post-settlement, rather than hiding it', async () => {
      const orderId = await seedReceivable(200_000);
      await settlements.createSettlement({ partyType: 'professional', partyId, orderIds: [orderId], method: null, reference: null, note: null, actorId: uuidv7() });
      expect(await settlements.outstandingForOrder(orderId)).toBe(0);

      // The customer is refunded AFTER the professional was already paid out.
      await ledger.recordRefund({ orderId, refundId: uuidv7(), refundAmountToman: 200_000 });

      // Honest: the professional now owes the platform 170,000. Clamping this
      // to zero would silently hide real money owed back.
      expect(await settlements.outstandingForOrder(orderId)).toBe(-170_000);
      expect((await settlements.partySummary('professional', partyId)).outstandingToman).toBe(-170_000);
    });

    it('offers only genuinely-positive outstanding orders for settlement', async () => {
      const paid = await seedReceivable(200_000);
      const settled = await seedReceivable(100_000);
      await settlements.createSettlement({ partyType: 'professional', partyId, orderIds: [settled], method: null, reference: null, note: null, actorId: uuidv7() });

      const available = await settlements.outstandingOrdersForParty('professional', partyId);
      expect(available.map((o) => o.orderId)).toEqual([paid]);
    });
  });

  // -------------------------------------------------------------------
  // GAP-05: cross-party isolation
  // -------------------------------------------------------------------

  describe('cross-party financial isolation (GAP-05)', () => {
    let professionalA: { ownerId: string; professionalId: string; token: string };
    let professionalB: { ownerId: string; professionalId: string; token: string };
    let customer: { id: string; token: string };

    beforeEach(async () => {
      const ownerA = await seedUser(app, dataSource, '+989121110001', ['professional']);
      const ownerB = await seedUser(app, dataSource, '+989121110002', ['professional']);
      const cust = await seedUser(app, dataSource, '+989131110003');
      const profA = await seedProfessional(dataSource, ownerA.id, 'سارا');
      const profB = await seedProfessional(dataSource, ownerB.id, 'مینا');

      professionalA = { ownerId: ownerA.id, professionalId: profA.id, token: ownerA.accessToken };
      professionalB = { ownerId: ownerB.id, professionalId: profB.id, token: ownerB.accessToken };
      customer = { id: cust.id, token: cust.accessToken };

      // A distinguishable amount for each, so a leak is unmistakable.
      await ledger.recordPayment({
        orderId: uuidv7(), sourceId: null, sellerPartyType: 'professional',
        sellerPartyId: profA.id, netAmountToman: 1_111_000, paymentReferenceId: uuidv7(),
      });
      await ledger.recordPayment({
        orderId: uuidv7(), sourceId: null, sellerPartyType: 'professional',
        sellerPartyId: profB.id, netAmountToman: 2_222_000, paymentReferenceId: uuidv7(),
      });
    });

    it('shows each professional ONLY their own earnings', async () => {
      const a = await myFinance.mySummary(professionalA.ownerId);
      const b = await myFinance.mySummary(professionalB.ownerId);

      expect(a?.receivableNetToman).toBe(1_111_000 - 166_650);
      expect(b?.receivableNetToman).toBe(2_222_000 - 333_300);
      expect(a?.partyId).toBe(professionalA.professionalId);
      expect(b?.partyId).toBe(professionalB.professionalId);
    });

    it("never leaks professional B's figures into professional A's HTTP response", async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/me/finance/summary')
        .set('Authorization', `Bearer ${professionalA.token}`)
        .expect(200);

      // Not merely "the request succeeded" -- B's distinguishable value must
      // appear nowhere in the payload (the adversarial-ownership harness).
      assertNoLeak(response.body, String(2_222_000 - 333_300));
      expect(response.body.data.receivableNetToman).toBe(1_111_000 - 166_650);
    });

    it('returns nothing for a customer, who is not a selling party at all', async () => {
      expect(await myFinance.mySummary(customer.id)).toBeNull();

      await request(app.getHttpServer())
        .get('/api/v1/me/finance/summary')
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(404);
    });

    it('rejects an unauthenticated finance request', async () => {
      await request(app.getHttpServer()).get('/api/v1/me/finance/summary').expect(401);
    });

    it("filters another party's rows out of a per-order ledger read, even with a valid order id", async () => {
      const sharedOrderId = uuidv7();
      await ledger.recordPayment({
        orderId: sharedOrderId, sourceId: null, sellerPartyType: 'professional',
        sellerPartyId: professionalB.professionalId, netAmountToman: 500_000, paymentReferenceId: uuidv7(),
      });

      // A knows the order id. They still see nothing: the rows are filtered
      // to the resolved party, not merely hidden by the controller.
      const entries = await myFinance.myLedgerForOrder(professionalA.ownerId, sharedOrderId);
      expect(entries).toEqual([]);

      // And the platform's own commission row is not visible either.
      const bEntries = await myFinance.myLedgerForOrder(professionalB.ownerId, sharedOrderId);
      expect(bEntries).toHaveLength(1);
      expect(bEntries?.[0].entryType).toBe('receivable');
    });

    it('denies a professional the cross-party admin surface', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/admin/finance/parties/summary?partyType=professional&partyId=${professionalB.professionalId}`)
        .set('Authorization', `Bearer ${professionalA.token}`)
        .expect(403);
    });

    it('denies a customer the platform totals', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/admin/finance/totals')
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(403);
    });

    it('allows a platform operator the cross-party surface', async () => {
      const operator = await seedUser(app, dataSource, '+989121119999', ['platform_operator']);
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/finance/totals')
        .set('Authorization', `Bearer ${operator.accessToken}`)
        .expect(200);
      expect(response.body.data.commissionToman).toBe(166_650 + 333_300);
    });

    it('denies a professional the ability to create a settlement for themselves', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/finance/settlements')
        .set('Authorization', `Bearer ${professionalA.token}`)
        .send({ partyType: 'professional', partyId: professionalA.professionalId, orderIds: [uuidv7()] })
        .expect(403);
    });
  });

  // -------------------------------------------------------------------
  // End-to-end: money moving all the way through
  // -------------------------------------------------------------------

  describe('end to end, from booking to ledger', () => {
    it('records commission and receivable once a real payment is verified', async () => {
      const owner = await seedUser(app, dataSource, '+989125550001', ['professional']);
      const customer = await seedUser(app, dataSource, '+989135550001');
      const professional = await seedProfessional(dataSource, owner.id, 'الهام', 300_000);
      const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(96));

      const result = await checkout.checkout({
        customerId: customer.id,
        professionalId: professional.id,
        slotId,
        serviceId: professional.serviceId,
        callbackBaseUrl: 'http://localhost:3099/api/v1/payments/callback',
      });

      const [{ provider_reference }] = await dataSource.query(
        `SELECT provider_reference FROM payment.payment_attempts WHERE payment_intent_id = $1`,
        [result.paymentIntentId],
      );
      await sandbox.decide(provider_reference, 'success');
      await checkout.handleCallback('sandbox', provider_reference, { reference: provider_reference });

      // The ledger is reached via the outbox, so drain it -- exactly what the
      // periodic sweep does in production.
      await ctx.relay.drain();

      const entries = await ledger.entriesForOrder(result.order.order.id);
      expect(entries).toHaveLength(2);
      expect(entries.find((e) => e.entryType === 'commission')?.amountToman).toBe(45_000);
      expect(entries.find((e) => e.entryType === 'receivable')?.amountToman).toBe(255_000);
      expect(entries.find((e) => e.entryType === 'receivable')?.partyId).toBe(professional.id);

      const summary = await myFinance.mySummary(owner.id);
      expect(summary?.outstandingToman).toBe(255_000);
    });

    it('reverses the ledger when a paid booking is cancelled and refunded', async () => {
      const owner = await seedUser(app, dataSource, '+989125550002', ['professional']);
      const customer = await seedUser(app, dataSource, '+989135550002');
      const professional = await seedProfessional(dataSource, owner.id, 'نگار', 300_000);
      const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(120));

      const result = await checkout.checkout({
        customerId: customer.id,
        professionalId: professional.id,
        slotId,
        serviceId: professional.serviceId,
        callbackBaseUrl: 'http://localhost:3099/api/v1/payments/callback',
      });
      const [{ provider_reference }] = await dataSource.query(
        `SELECT provider_reference FROM payment.payment_attempts WHERE payment_intent_id = $1`,
        [result.paymentIntentId],
      );
      await sandbox.decide(provider_reference, 'success');
      await checkout.handleCallback('sandbox', provider_reference, { reference: provider_reference });
      await ctx.relay.drain();

      expect((await myFinance.mySummary(owner.id))?.outstandingToman).toBe(255_000);

      // The customer cancels. Refund and ledger reversal follow through the
      // event chain: BookingCancelled -> refund -> RefundCompleted ->
      // OrderRefunded -> ledger reversal.
      const bookings = app.get(await import('@beauclick/booking').then((m) => m.BookingService));
      await bookings.cancel(result.bookingId, { type: 'customer', id: customer.id }, 'تغییر برنامه');
      for (let i = 0; i < 4; i++) await ctx.relay.drain();

      const order = await orders.findById(result.order.order.id);
      expect(order?.status).toBe('refunded');
      expect(order?.refundedTotalToman).toBe(300_000);

      // Ledger reversed at the original rate; the professional is owed nothing.
      expect((await myFinance.mySummary(owner.id))?.outstandingToman).toBe(0);
      const entries = await ledger.entriesForOrder(result.order.order.id);
      expect(entries).toHaveLength(4);
      expect(entries.reduce((sum, e) => sum + e.amountToman, 0)).toBe(0);
    });
  });
});
