import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { FundJournalService } from '@beauclick/financial';
import { OutboxRelay } from '@beauclick/events';

import {
  createPgTestApp,
  financialOwnerUrl,
  requireFinancialOwnerUrl,
  requiredPgEnv,
  resetDatabase,
  resetFinancial,
  seedFinancialOutboxEvent,
  seedProfessional,
  seedUser,
} from './pg-test-app.factory';
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
/**
 * THREE dependencies, and the gate names all three.
 *
 * `requiredPgEnv()` covers `TEST_DATABASE_URL` and `TEST_FINANCIAL_WRITER_URL`.
 * This suite also needs the OWNER connection, because `beforeEach` truncates
 * `financial.*` and only the owner may (ADR-017). Gating on `requiredPgEnv()`
 * alone let an absent owner URL through as `undefined`, and `as string` stopped
 * the compiler from saying so -- see `resetFinancial` for what `pg` then did
 * with it.
 *
 * `beforeEach` then calls `requireFinancialOwnerUrl()`, which returns `string`,
 * so nothing below casts.
 */
const OWNER_URL = financialOwnerUrl();
const describeIfPg = requiredPgEnv() && OWNER_URL ? describe : describe.skip;

describeIfPg('Financial outbox consumer on real PostgreSQL', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let financialDataSource: DataSource;
  let fundJournal: FundJournalService;
  let financialRelay: OutboxRelay;

  beforeAll(async () => {
    const ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    financialDataSource = ctx.financialDataSource;
    fundJournal = app.get(FundJournalService);
    financialRelay = app.get(FINANCIAL_OUTBOX_RELAY);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    await resetFinancial(requireFinancialOwnerUrl());
  });

  /**
   * `#43a` (ADR-052 §13): `FundsJournalRecorded` is the pending-funds
   * journal's own event, replacing `LedgerEntriesRecorded` as the path a NEW
   * collection reaches analytics by -- `LedgerService.recordPayment` (and
   * the event it used to emit for a fresh payment) is removed.
   */
  it('drains FundsJournalRecorded into an analytics fact row -- the ONLY path fund-journal data can leave the isolated schema by', async () => {
    const owner = await seedUser(app, dataSource, `+98941${String(Date.now()).slice(-6)}`, ['professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'حسابدار');
    const orderId = uuidv7();
    const paymentRef = uuidv7();

    const recorded = await fundJournal.recordCollection({
      orderId,
      sellerPartyType: 'professional',
      sellerPartyId: professional.id,
      collectedToman: 100_000,
      paymentReferenceId: paymentRef,
    });
    expect(recorded).toBe(true);

    const result = await financialRelay.drain();
    expect(result.failed).toBe(0);
    expect(result.dispatched).toBeGreaterThan(0);

    const facts = await dataSource.query(
      `SELECT subject_id, metric_value, dimensions FROM analytics.events WHERE event_type = 'FundsJournalRecorded' AND subject_id = $1`,
      [orderId],
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].dimensions.sellerPartyType).toBe('professional');
    expect(facts[0].dimensions.kind).toBe('collection');
    expect(Number(facts[0].metric_value)).toBe(100_000);

    // Redelivery: draining again finds nothing new (already published), but
    // even a re-ingestion attempt of the SAME event id must not double-count
    // -- proven directly against the idempotent-by-primary-key insert.
    const again = await financialRelay.drain();
    expect(again.dispatched).toBe(0);
    const stillOne = await dataSource.query(`SELECT count(*) FROM analytics.events WHERE event_type = 'FundsJournalRecorded' AND subject_id = $1`, [orderId]);
    expect(Number(stillOne[0].count)).toBe(1);
  });

  /**
   * `SettlementService.createSettlement` no longer emits `SettlementRecorded`
   * at all (ADR-052 §8: the immediate route is refused unconditionally), but
   * the event contract, and the relay/analytics/notification machinery that
   * consumes it, are UNCHANGED -- a future schedule-gated settlement record
   * (`#43e`) reuses them without a new consumer registration. The event is
   * seeded directly (`seedFinancialOutboxEvent`) to prove that machinery
   * still works, independent of which production code currently emits it.
   */
  it('drains a seeded SettlementRecorded into a fact row AND notifies the seller who was actually paid', async () => {
    const owner = await seedUser(app, dataSource, `+98942${String(Date.now()).slice(-6)}`, ['professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'استاد');
    const settlementId = uuidv7();

    await seedFinancialOutboxEvent(financialDataSource, {
      aggregateType: 'settlement',
      aggregateId: settlementId,
      eventType: 'SettlementRecorded',
      payload: {
        settlementId,
        partyType: 'professional',
        partyId: professional.id,
        amountToman: 170_000,
        orderCount: 1,
        method: 'bank_transfer',
      },
    });

    const result = await financialRelay.drain();
    expect(result.failed).toBe(0);

    const facts = await dataSource.query(
      `SELECT metric_value, dimensions FROM analytics.events WHERE event_type = 'SettlementRecorded' AND aggregate_id = $1`,
      [settlementId],
    );
    expect(facts).toHaveLength(1);
    expect(Number(facts[0].metric_value)).toBe(170_000);

    const notifications = await dataSource.query(
      `SELECT user_id, template_key FROM notification.notifications WHERE template_key = 'settlement_recorded'`,
    );
    expect(notifications).toHaveLength(1);
    // The OWNER of the professional profile -- not the party id itself,
    // which is a profile id, not an identity user id.
    expect(notifications[0].user_id).toBe(owner.id);
  });
});
