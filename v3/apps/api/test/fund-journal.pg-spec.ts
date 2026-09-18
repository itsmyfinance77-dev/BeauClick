import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import { uuidv7 } from 'uuidv7';

import { FUND_JOURNAL_ORDER_LOCK_NAMESPACE, FundJournalService, FinanceWorkspaceService } from '@beauclick/financial';

import {
  PgTestApp,
  createPgTestApp,
  financialOwnerUrl,
  requireFinancialOwnerUrl,
  requiredPgEnv,
  resetDatabase,
  resetFinancial,
  seedProfessional,
  seedUser,
} from './pg-test-app.factory';

/**
 * REAL PostgreSQL: the pending-funds journal's own guarantees -- `#43a`,
 * ADR-052 §4, §5, §12. `financial-integrity.pg-spec.ts` proves the legacy
 * ledger and the end-to-end new-regime path; this suite proves the JOURNAL
 * mechanism itself: the two triggers, the idempotency key, the beneficiary
 * rule, the advisory-lock serialisation `FundJournalService` relies on
 * (proved both as "the writer role genuinely cannot row-lock" and as "the
 * lock genuinely blocks a concurrent writer"), the M1 reconciliation
 * identity, and the additive `/funds` read.
 */
const OWNER_URL = financialOwnerUrl();
const describeIfPg = requiredPgEnv() && OWNER_URL ? describe : describe.skip;

describeIfPg('The pending-funds journal on real PostgreSQL (#43a)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let financialDataSource: DataSource;
  let fundJournal: FundJournalService;
  let workspaces: FinanceWorkspaceService;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    financialDataSource = ctx.financialDataSource;
    fundJournal = app.get(FundJournalService);
    workspaces = app.get(FinanceWorkspaceService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    await resetFinancial(requireFinancialOwnerUrl());
  });

  // -------------------------------------------------------------------
  // The grant contract, proved directly (not merely via the boot check)
  // -------------------------------------------------------------------

  describe('grants (ADR-052 §4)', () => {
    it('the writer role may INSERT + SELECT and NOTHING else on fund_journals / fund_postings', async () => {
      for (const table of ['fund_journals', 'fund_postings']) {
        const [insert] = await financialDataSource.query(
          `SELECT has_table_privilege('beauclick_financial_writer', $1, 'INSERT') AS ok`,
          [`financial.${table}`],
        );
        const [select] = await financialDataSource.query(
          `SELECT has_table_privilege('beauclick_financial_writer', $1, 'SELECT') AS ok`,
          [`financial.${table}`],
        );
        expect(insert.ok).toBe(true);
        expect(select.ok).toBe(true);
        for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
          const [row] = await financialDataSource.query(
            `SELECT has_table_privilege('beauclick_financial_writer', $1, $2) AS ok`,
            [`financial.${table}`, privilege],
          );
          expect(row.ok).toBe(false);
        }
      }
    });

    it('the writer role cannot SELECT ... FOR UPDATE -- the documentary claim ADR-052 §4 makes, proved against the real server', async () => {
      await expect(financialDataSource.query('SELECT 1 FROM financial.fund_postings FOR UPDATE LIMIT 1')).rejects.toThrow(
        /permission denied/i,
      );
    });

    it('the application role reaches neither table at all', async () => {
      await expect(dataSource.query('SELECT 1 FROM financial.fund_postings LIMIT 1')).rejects.toThrow(/permission denied|does not exist/i);
    });
  });

  // -------------------------------------------------------------------
  // M0 / M4: the balance chain and zero-sum triggers
  // -------------------------------------------------------------------

  describe('the balance chain and zero-sum triggers (M0, M4)', () => {
    async function insertJournalAndPosting(
      journalId: string,
      orderId: string,
      partyId: string,
      account: string,
      amountToman: number,
      seq: number,
      balanceAfter: number,
      opts: { idempotencyKey?: string; kind?: string } = {},
    ): Promise<void> {
      await financialDataSource.query(
        `INSERT INTO financial.fund_journals (id, kind, idempotency_key, source_type, source_id)
         VALUES ($1, $2, $3, 'order', $4) ON CONFLICT (idempotency_key) DO NOTHING`,
        [journalId, opts.kind ?? 'collection', opts.idempotencyKey ?? `collection:${journalId}`, orderId],
      );
      await financialDataSource.query(
        `INSERT INTO financial.fund_postings
           (id, journal_id, order_id, seller_party_type, seller_party_id, account, amount_toman, seq, balance_after)
         VALUES ($1, $2, $3, 'professional', $4, $5, $6, $7, $8)`,
        [uuidv7(), journalId, orderId, partyId, account, String(amountToman), seq, String(balanceAfter)],
      );
    }

    it('a BALANCED journal (pending +c / collected -c) commits, and zero postings do not trip the check', async () => {
      const orderId = uuidv7();
      const journalId = uuidv7();
      await financialDataSource.transaction(async (manager) => {
        await manager.query(
          `INSERT INTO financial.fund_journals (id, kind, idempotency_key, source_type, source_id) VALUES ($1, 'collection', $2, 'order', $3)`,
          [journalId, `collection:${journalId}`, orderId],
        );
        const partyId = uuidv7();
        await manager.query(
          `INSERT INTO financial.fund_postings (id, journal_id, order_id, seller_party_type, seller_party_id, account, amount_toman, seq, balance_after)
           VALUES ($1, $2, $3, 'professional', $4, 'pending', 100, 1, 100)`,
          [uuidv7(), journalId, orderId, partyId],
        );
        await manager.query(
          `INSERT INTO financial.fund_postings (id, journal_id, order_id, seller_party_type, seller_party_id, account, amount_toman, seq, balance_after)
           VALUES ($1, $2, $3, 'professional', $4, 'collected', -100, 1, 100)`,
          [uuidv7(), journalId, orderId, partyId],
        );
      });

      const rows = await financialDataSource.query('SELECT account, balance_after FROM financial.fund_postings WHERE order_id = $1 ORDER BY account', [orderId]);
      expect(rows).toHaveLength(2);
    });

    it('an UNBALANCED journal is refused at COMMIT (M0), even though each individual INSERT succeeds', async () => {
      const orderId = uuidv7();
      const journalId = uuidv7();
      await expect(
        financialDataSource.transaction(async (manager) => {
          await manager.query(
            `INSERT INTO financial.fund_journals (id, kind, idempotency_key, source_type, source_id) VALUES ($1, 'collection', $2, 'order', $3)`,
            [journalId, `collection:${journalId}`, orderId],
          );
          await manager.query(
            `INSERT INTO financial.fund_postings (id, journal_id, order_id, seller_party_type, seller_party_id, account, amount_toman, seq, balance_after)
             VALUES ($1, $2, $3, 'professional', $4, 'pending', 50, 1, 50)`,
            [uuidv7(), journalId, orderId, uuidv7()],
          );
          // No offsetting `collected` posting -- the journal never balances.
        }),
      ).rejects.toThrow(/sum to/i);

      const rows = await financialDataSource.query('SELECT 1 FROM financial.fund_postings WHERE order_id = $1', [orderId]);
      expect(rows).toHaveLength(0); // the whole transaction rolled back -- nothing survives an unbalanced journal
    });

    it('an overdraw (balance_after would go negative) is refused, whatever the caller claims the chain math says', async () => {
      const orderId = uuidv7();
      const partyId = uuidv7();
      // Seed a real `pending` balance of 100 first, exactly as `recordCollection` would.
      await fundJournal.recordCollection({
        orderId,
        sellerPartyType: 'professional',
        sellerPartyId: partyId,
        collectedToman: 100,
        paymentReferenceId: uuidv7(),
      });

      const refundJournalId = uuidv7();
      await expect(
        financialDataSource.transaction(async (manager) => {
          await manager.query(
            `INSERT INTO financial.fund_journals (id, kind, idempotency_key, source_type, source_id) VALUES ($1, 'refund', $2, 'order', $3)`,
            [refundJournalId, `refund:${uuidv7()}`, orderId],
          );
          await manager.query(
            `INSERT INTO financial.fund_postings (id, journal_id, order_id, seller_party_type, seller_party_id, account, amount_toman, seq, balance_after)
             VALUES ($1, $2, $3, 'professional', $4, 'refunded', 200, 1, 200)`,
            [uuidv7(), refundJournalId, orderId, partyId],
          );
          // pending is 100; draw 200 -- balance_after would be -100.
          await manager.query(
            `INSERT INTO financial.fund_postings (id, journal_id, order_id, seller_party_type, seller_party_id, account, amount_toman, seq, balance_after)
             VALUES ($1, $2, $3, 'professional', $4, 'pending', -200, 2, -100)`,
            [uuidv7(), refundJournalId, orderId, partyId],
          );
        }),
      ).rejects.toThrow(/balance_after|check constraint/i);

      const states = await fundJournal.statesForOrder(orderId);
      expect(states.pending).toBe(100); // untouched -- the overdraw never committed
    });

    it('seq must chain from the previous posting -- a gap or a re-use is refused', async () => {
      const orderId = uuidv7();
      const partyId = uuidv7();
      await fundJournal.recordCollection({
        orderId,
        sellerPartyType: 'professional',
        sellerPartyId: partyId,
        collectedToman: 100,
        paymentReferenceId: uuidv7(),
      });

      const journalId = uuidv7();
      await expect(
        insertJournalAndPosting(journalId, orderId, partyId, 'pending', -10, 5 /* should be 2 */, 90, {
          kind: 'refund',
          idempotencyKey: `refund:${uuidv7()}`,
        }),
      ).rejects.toThrow(/seq must chain/i);
    });

    it("a posting whose seller party disagrees with the order's first posting is refused (`V33-DEC-025` R7)", async () => {
      const orderId = uuidv7();
      const originalParty = uuidv7();
      await fundJournal.recordCollection({
        orderId,
        sellerPartyType: 'professional',
        sellerPartyId: originalParty,
        collectedToman: 100,
        paymentReferenceId: uuidv7(),
      });

      const journalId = uuidv7();
      await financialDataSource.query(
        `INSERT INTO financial.fund_journals (id, kind, idempotency_key, source_type, source_id) VALUES ($1, 'refund', $2, 'order', $3)`,
        [journalId, `refund:${uuidv7()}`, orderId],
      );
      await expect(
        financialDataSource.query(
          `INSERT INTO financial.fund_postings (id, journal_id, order_id, seller_party_type, seller_party_id, account, amount_toman, seq, balance_after)
           VALUES ($1, $2, $3, 'business', $4, 'refunded', 10, 1, 10)`, // a DIFFERENT party
          [uuidv7(), journalId, orderId, uuidv7()],
        ),
      ).rejects.toThrow(/already attributed to/i);
    });

    it('an overdraw of exactly 1 toman is refused; exactly 0 remaining is allowed', async () => {
      const orderId = uuidv7();
      const partyId = uuidv7();
      await fundJournal.recordCollection({
        orderId,
        sellerPartyType: 'professional',
        sellerPartyId: partyId,
        collectedToman: 100,
        paymentReferenceId: uuidv7(),
      });

      // Refund of exactly 100 -- pending lands at exactly 0. Allowed.
      expect(await fundJournal.recordRefund({ orderId, refundId: uuidv7(), refundAmountToman: 100 })).toBe(true);
      expect((await fundJournal.statesForOrder(orderId)).pending).toBe(0);

      // A further refund of 1 would draw pending to -1. The commerce-side
      // `ck_orders_refund_within_collected` CHECK would already prevent this
      // in production; this proves the JOURNAL'S OWN CHECK independently
      // refuses it too, never trusting the caller's arithmetic.
      const journalId = uuidv7();
      await expect(
        financialDataSource.transaction(async (manager) => {
          await manager.query(
            `INSERT INTO financial.fund_journals (id, kind, idempotency_key, source_type, source_id) VALUES ($1, 'refund', $2, 'order', $3)`,
            [journalId, `refund:${uuidv7()}`, orderId],
          );
          // `refunded`'s own chain already holds seq=1 from the first refund above.
          await manager.query(
            `INSERT INTO financial.fund_postings (id, journal_id, order_id, seller_party_type, seller_party_id, account, amount_toman, seq, balance_after)
             VALUES ($1, $2, $3, 'professional', $4, 'refunded', 1, 2, 101)`,
            [uuidv7(), journalId, orderId, partyId],
          );
          // `pending`'s own chain already holds seq=1 (collection) and seq=2
          // (the first refund above, which drew it to exactly 0).
          await manager.query(
            `INSERT INTO financial.fund_postings (id, journal_id, order_id, seller_party_type, seller_party_id, account, amount_toman, seq, balance_after)
             VALUES ($1, $2, $3, 'professional', $4, 'pending', -1, 3, -1)`,
            [uuidv7(), journalId, orderId, partyId],
          );
        }),
      ).rejects.toThrow(/balance_after|check constraint/i);
    });

    /**
     * A missed advisory lock fails LOUDLY (`23505`), never silently -- ADR-052
     * §4's own justification for why the app-level lock is safe to rely on.
     * Two raw clients race the SAME next `seq` for the SAME chain, bypassing
     * `FundJournalService` (and therefore its lock) entirely on purpose.
     */
    it('a parallel seq race (bypassing the service lock) gives exactly one success and one 23505', async () => {
      const orderId = uuidv7();
      const partyId = uuidv7();
      await fundJournal.recordCollection({
        orderId,
        sellerPartyType: 'professional',
        sellerPartyId: partyId,
        collectedToman: 1000,
        paymentReferenceId: uuidv7(),
      });

      const writerUrl = process.env.TEST_FINANCIAL_WRITER_URL!;
      const clientA = new Client({ connectionString: writerUrl });
      const clientB = new Client({ connectionString: writerUrl });
      await clientA.connect();
      await clientB.connect();
      try {
        const journalA = uuidv7();
        const journalB = uuidv7();
        await clientA.query(
          `INSERT INTO financial.fund_journals (id, kind, idempotency_key, source_type, source_id) VALUES ($1, 'refund', $2, 'order', $3)`,
          [journalA, `refund:${uuidv7()}`, orderId],
        );
        await clientB.query(
          `INSERT INTO financial.fund_journals (id, kind, idempotency_key, source_type, source_id) VALUES ($1, 'refund', $2, 'order', $3)`,
          [journalB, `refund:${uuidv7()}`, orderId],
        );

        // A real, BALANCED `refund` journal each (`refunded +1 / pending -1`,
        // exactly `FundJournalService.recordRefund`'s own shape) so the
        // deferred M0 check passes for whichever one wins -- the race this
        // test targets is the `seq` uniqueness on `pending` (and, since it is
        // each journal's first `refunded` posting too, on `refunded`), not
        // M0. Sent as an explicit transaction per client -- a raw `pg` Client
        // with bound parameters uses the extended protocol, which cannot
        // batch multiple statements into one implicit transaction the way a
        // bare multi-statement string can.
        const insertOne = async (client: Client, journalId: string) => {
          await client.query('BEGIN');
          try {
            await client.query(
              `INSERT INTO financial.fund_postings (id, journal_id, order_id, seller_party_type, seller_party_id, account, amount_toman, seq, balance_after)
               VALUES ($1, $2, $3, 'professional', $4, 'refunded', 1, 1, 1)`,
              [uuidv7(), journalId, orderId, partyId],
            );
            // Both computed seq = 2 (the collection above used seq 1) -- a
            // real race, since neither took the advisory lock.
            await client.query(
              `INSERT INTO financial.fund_postings (id, journal_id, order_id, seller_party_type, seller_party_id, account, amount_toman, seq, balance_after)
               VALUES ($1, $2, $3, 'professional', $4, 'pending', -1, 2, 999)`,
              [uuidv7(), journalId, orderId, partyId],
            );
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        };

        const results = await Promise.allSettled([insertOne(clientA, journalA), insertOne(clientB, journalB)]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/23505|duplicate key/i);
      } finally {
        await clientA.end();
        await clientB.end();
      }
    });
  });

  // -------------------------------------------------------------------
  // FundJournalService: idempotency, no commission, the advisory lock
  // -------------------------------------------------------------------

  describe('FundJournalService', () => {
    it('recordCollection posts exactly `pending +c / collected -c` -- no commission, no receivable exist to post', async () => {
      const orderId = uuidv7();
      const partyId = uuidv7();
      const recorded = await fundJournal.recordCollection({
        orderId,
        sellerPartyType: 'professional',
        sellerPartyId: partyId,
        collectedToman: 300_000,
        paymentReferenceId: uuidv7(),
      });
      expect(recorded).toBe(true);

      const states = await fundJournal.statesForOrder(orderId);
      expect(states.pending).toBe(300_000);
      expect(states.collected).toBe(300_000);
      expect(states.platform_earned).toBeUndefined();
      expect(states.refunded).toBeUndefined();

      const postings = await financialDataSource.query(
        'SELECT account, seller_party_type, seller_party_id FROM financial.fund_postings WHERE order_id = $1',
        [orderId],
      );
      expect(postings).toHaveLength(2);
      expect(postings.every((p: { seller_party_type: string; seller_party_id: string }) => p.seller_party_type === 'professional' && p.seller_party_id === partyId)).toBe(true);
    });

    it('is idempotent: triple concurrent delivery of the SAME payment intent writes exactly one journal', async () => {
      const orderId = uuidv7();
      const paymentReferenceId = uuidv7();
      const call = () =>
        fundJournal.recordCollection({
          orderId,
          sellerPartyType: 'professional',
          sellerPartyId: uuidv7(),
          collectedToman: 250_000,
          paymentReferenceId,
        });

      const results = await Promise.all([call(), call(), call()]);
      expect(results.filter(Boolean)).toHaveLength(1);

      const journals = await financialDataSource.query('SELECT id FROM financial.fund_journals WHERE source_id = $1', [orderId]);
      expect(journals).toHaveLength(1);
      const postings = await financialDataSource.query('SELECT id FROM financial.fund_postings WHERE order_id = $1', [orderId]);
      expect(postings).toHaveLength(2);
    });

    it('recordRefund is idempotent per refundId, and draws from pending', async () => {
      const orderId = uuidv7();
      await fundJournal.recordCollection({
        orderId,
        sellerPartyType: 'professional',
        sellerPartyId: uuidv7(),
        collectedToman: 100_000,
        paymentReferenceId: uuidv7(),
      });

      const refundId = uuidv7();
      expect(await fundJournal.recordRefund({ orderId, refundId, refundAmountToman: 40_000 })).toBe(true);
      expect(await fundJournal.recordRefund({ orderId, refundId, refundAmountToman: 40_000 })).toBe(false);

      const states = await fundJournal.statesForOrder(orderId);
      expect(states.pending).toBe(60_000);
      expect(states.refunded).toBe(40_000);
      expect(states.collected).toBe(100_000); // a custody fact, never reduced by a refund
    });

    it('recordRefund is a no-op (never fabricates a reversal) against an order with no new-regime collection', async () => {
      expect(await fundJournal.recordRefund({ orderId: uuidv7(), refundId: uuidv7(), refundAmountToman: 1000 })).toBe(false);
    });

    it('the M1 custody identity holds after collection and after a partial refund', async () => {
      const orderId = uuidv7();
      await fundJournal.recordCollection({
        orderId,
        sellerPartyType: 'professional',
        sellerPartyId: uuidv7(),
        collectedToman: 777_000,
        paymentReferenceId: uuidv7(),
      });
      await fundJournal.recordRefund({ orderId, refundId: uuidv7(), refundAmountToman: 200_000 });

      const s = await fundJournal.statesForOrder(orderId);
      const left = (s.collected ?? 0) + (s.platform_advance ?? 0) + (s.recovered_in ?? 0);
      const right =
        (s.refunded ?? 0) +
        (s.pending ?? 0) +
        (s.disputed ?? 0) +
        (s.available ?? 0) +
        (s.reserve ?? 0) +
        (s.settled ?? 0) +
        (s.platform_earned ?? 0) +
        (s.provider_fee ?? 0) +
        (s.recovery_out ?? 0);
      expect(left).toBe(right);
      expect(left).toBe(777_000);
      expect(s.pending).toBe(577_000);
      expect(s.refunded).toBe(200_000);
    });

    /**
     * The lock genuinely serialises, not merely "is taken and released
     * quickly enough that nobody notices" -- a holder transaction takes the
     * SAME `pg_advisory_xact_lock(fjo, hashtext(orderId))` on a separate raw
     * connection and keeps it open; the service call for the SAME order must
     * not complete until the holder releases it.
     */
    it('recordCollection genuinely blocks on the advisory lock for the same order, and proceeds once it is released', async () => {
      const orderId = uuidv7();
      let released = false;
      let signalReady: () => void = () => undefined;
      let releaseHolder: () => void = () => undefined;
      const holderReady = new Promise<void>((r) => {
        signalReady = r;
      });
      const holderDone = new Promise<void>((r) => {
        releaseHolder = r;
      });

      const holder = financialDataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [FUND_JOURNAL_ORDER_LOCK_NAMESPACE, orderId]);
        signalReady();
        await holderDone;
      });
      await holderReady;

      const blocked = fundJournal
        .recordCollection({
          orderId,
          sellerPartyType: 'professional',
          sellerPartyId: uuidv7(),
          collectedToman: 50_000,
          paymentReferenceId: uuidv7(),
        })
        .then((result) => {
          if (!released) throw new Error('recordCollection completed while the advisory lock was held');
          return result;
        });

      await new Promise((r) => setTimeout(r, 300)); // give the blocked call every chance to (wrongly) proceed
      const midway = await fundJournal.statesForOrder(orderId);
      expect(midway.pending).toBeUndefined(); // still nothing written

      released = true;
      releaseHolder();
      await holder;
      expect(await blocked).toBe(true);

      const finalStates = await fundJournal.statesForOrder(orderId);
      expect(finalStates.pending).toBe(50_000);
    });
  });

  // -------------------------------------------------------------------
  // Legacy byte-identity, dynamically (complements the static
  // `fund-journal-migration-shape.spec.ts` proof)
  // -------------------------------------------------------------------

  describe('legacy byte-identity across a migration re-run (ADR-052 §16)', () => {
    it('re-running `pnpm migrate` (idempotent) leaves every pre-existing ledger_entries / settlement_batches / settlement_items row byte-identical', async () => {
      const { seedLegacyPayment, seedSettlementBatch } = await import('./pg-test-app.factory');
      const orderId = uuidv7();
      await seedLegacyPayment(financialDataSource, {
        orderId,
        sellerPartyType: 'professional',
        sellerPartyId: uuidv7(),
        netAmountToman: 123_456,
        rateBp: 1500,
        paymentReferenceId: uuidv7(),
      });
      await seedSettlementBatch(financialDataSource, {
        partyType: 'professional',
        partyId: uuidv7(),
        items: [{ orderId, amountToman: 100_000 }],
        createdBy: uuidv7(),
      });

      // Row-text hashes, one table at a time (a UNION ALL across three
      // differently-shaped tables would need padding every column to a
      // common shape, which is fragile for no extra strength of proof).
      const hashOf = async (table: string) =>
        (await financialDataSource.query(`SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS h FROM financial.${table} t`))[0].h;

      const before = {
        ledger: await hashOf('ledger_entries'),
        batches: await hashOf('settlement_batches'),
        items: await hashOf('settlement_items'),
      };

      const { execSync } = await import('node:child_process');
      const { resolve: resolvePath } = await import('node:path');
      execSync('pnpm migrate', {
        cwd: resolvePath(__dirname, '..', '..'), // apps/api/test -> apps/api -> v3
        env: {
          ...process.env,
          DATABASE_URL: process.env.TEST_DATABASE_URL,
          MIGRATION_URL_FINANCIAL: requireFinancialOwnerUrl(),
        },
        stdio: 'pipe',
      });

      const after = {
        ledger: await hashOf('ledger_entries'),
        batches: await hashOf('settlement_batches'),
        items: await hashOf('settlement_items'),
      };
      expect(after).toEqual(before);
    }, 60_000);
  });

  // -------------------------------------------------------------------
  // The additive `/funds` read (ADR-052 §16, the tenth route)
  // -------------------------------------------------------------------

  describe('the additive /funds workspace read', () => {
    it('returns every account as a distinct field, reflecting the new-regime states and nothing legacy', async () => {
      const owner = await seedUser(app, dataSource, `+98944${String(Date.now()).slice(-6)}`, ['professional']);
      const professional = await seedProfessional(dataSource, owner.id, 'دارا');
      const orderId = uuidv7();
      await fundJournal.recordCollection({
        orderId,
        sellerPartyType: 'professional',
        sellerPartyId: professional.id,
        collectedToman: 400_000,
        paymentReferenceId: uuidv7(),
      });
      await fundJournal.recordRefund({ orderId, refundId: uuidv7(), refundAmountToman: 100_000 });

      const ref = workspaces.referenceFor(owner.id, { partyType: 'professional', partyId: professional.id });
      const request = (await import('supertest')).default;
      const res = await request(app.getHttpServer())
        .get(`/api/v1/me/finance/${ref}/funds`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      expect(res.body.data).toEqual({
        pending: 300_000,
        disputed: 0,
        available: 0,
        reserve: 0,
        settled: 0,
        refunded: 100_000,
        platformEarned: 0,
        providerFee: 0,
        recoveryOut: 0,
        collected: 400_000,
        platformAdvance: 0,
        recoveredIn: 0,
        currency: 'IRT',
      });
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it('is non-enumerating: a foreign or malformed workspaceRef gets the identical 404 every other reference failure gets', async () => {
      const owner = await seedUser(app, dataSource, `+98945${String(Date.now()).slice(-6)}`, ['professional']);
      const request = (await import('supertest')).default;
      await request(app.getHttpServer())
        .get(`/api/v1/me/finance/${'x'.repeat(43)}/funds`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(404);
    });

    it('returns all-zero fields for a real, addressable workspace with no new-regime collection yet', async () => {
      const owner = await seedUser(app, dataSource, `+98946${String(Date.now()).slice(-6)}`, ['professional']);
      const professional = await seedProfessional(dataSource, owner.id, 'زهرا');
      const ref = workspaces.referenceFor(owner.id, { partyType: 'professional', partyId: professional.id });
      const request = (await import('supertest')).default;
      const res = await request(app.getHttpServer())
        .get(`/api/v1/me/finance/${ref}/funds`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(res.body.data).toEqual({
        pending: 0,
        disputed: 0,
        available: 0,
        reserve: 0,
        settled: 0,
        refunded: 0,
        platformEarned: 0,
        providerFee: 0,
        recoveryOut: 0,
        collected: 0,
        platformAdvance: 0,
        recoveredIn: 0,
        currency: 'IRT',
      });
    });
  });
});
