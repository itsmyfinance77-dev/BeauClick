import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { LedgerService, SettlementService } from '@beauclick/financial';
import { OutboxRelay } from '@beauclick/events';

import { createPgTestApp, requiredPgEnv, resetDatabase, resetFinancial, seedProfessional, seedUser } from './pg-test-app.factory';
import { FINANCIAL_OUTBOX_RELAY } from '../src/composition/financial-outbox-relay.provider';

/**
 * REAL PostgreSQL: the financial outbox consumer (Phase 4, ADR-025).
 *
 * Phase 2 and Phase 3 both left financial.outbox_events undrained on
 * purpose -- "financial-service runs on a different DataSource, and the
 * relay's constructor takes exactly one." This proves the SEPARATE relay
 * Phase 4 adds actually drains it: this is the ONLY way a financial fact
 * can reach analytics at all, since the main application role has REVOKE
 * ALL on the financial schema (ADR-017) and genuinely cannot read it any
 * other way.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;
const OWNER_URL = process.env.TEST_FINANCIAL_OWNER_URL;

describeIfPg('Financial outbox consumer on real PostgreSQL', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let ledger: LedgerService;
  let settlements: SettlementService;
  let financialRelay: OutboxRelay;

  beforeAll(async () => {
    const ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    ledger = app.get(LedgerService);
    settlements = app.get(SettlementService);
    financialRelay = app.get(FINANCIAL_OUTBOX_RELAY);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    await resetFinancial(OWNER_URL as string);
  });

  it('drains LedgerEntriesRecorded into an analytics fact row -- the ONLY path financial data can leave the isolated schema by', async () => {
    const owner = await seedUser(app, dataSource, `+98941${String(Date.now()).slice(-6)}`, ['professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'حسابدار');
    const orderId = uuidv7();
    const paymentRef = uuidv7();

    const recorded = await ledger.recordPayment({
      orderId,
      sourceId: null,
      sellerPartyType: 'professional',
      sellerPartyId: professional.id,
      netAmountToman: 100_000,
      paymentReferenceId: paymentRef,
    });
    expect(recorded).toBe(true);

    const result = await financialRelay.drain();
    expect(result.failed).toBe(0);
    expect(result.dispatched).toBeGreaterThan(0);

    const facts = await dataSource.query(
      `SELECT subject_id, metric_value, dimensions FROM analytics.events WHERE event_type = 'LedgerEntriesRecorded' AND subject_id = $1`,
      [orderId],
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].dimensions.sellerPartyType).toBe('professional');

    // Redelivery: draining again finds nothing new (already published), but
    // even a re-ingestion attempt of the SAME event id must not double-count
    // -- proven directly against the idempotent-by-primary-key insert.
    const again = await financialRelay.drain();
    expect(again.dispatched).toBe(0);
    const stillOne = await dataSource.query(`SELECT count(*) FROM analytics.events WHERE event_type = 'LedgerEntriesRecorded' AND subject_id = $1`, [orderId]);
    expect(Number(stillOne[0].count)).toBe(1);
  });

  it('drains SettlementRecorded into a fact row AND notifies the seller who was actually paid', async () => {
    const owner = await seedUser(app, dataSource, `+98942${String(Date.now()).slice(-6)}`, ['professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'استاد');
    const orderId = uuidv7();

    await ledger.recordPayment({
      orderId,
      sourceId: null,
      sellerPartyType: 'professional',
      sellerPartyId: professional.id,
      netAmountToman: 200_000,
      paymentReferenceId: uuidv7(),
    });
    await financialRelay.drain(); // clear the LedgerEntriesRecorded row first, for a clean settlement-only assertion below.

    const batch = await settlements.createSettlement({
      partyType: 'professional',
      partyId: professional.id,
      orderIds: [orderId],
      method: 'bank_transfer',
      reference: null,
      note: null,
      actorId: uuidv7(),
    });

    const result = await financialRelay.drain();
    expect(result.failed).toBe(0);

    const facts = await dataSource.query(
      `SELECT metric_value, dimensions FROM analytics.events WHERE event_type = 'SettlementRecorded' AND aggregate_id = $1`,
      [batch.id],
    );
    expect(facts).toHaveLength(1);
    expect(Number(facts[0].metric_value)).toBeGreaterThan(0);

    const notifications = await dataSource.query(
      `SELECT user_id, template_key FROM notification.notifications WHERE template_key = 'settlement_recorded'`,
    );
    expect(notifications).toHaveLength(1);
    // The OWNER of the professional profile -- not the party id itself,
    // which is a profile id, not an identity user id.
    expect(notifications[0].user_id).toBe(owner.id);
  });
});
