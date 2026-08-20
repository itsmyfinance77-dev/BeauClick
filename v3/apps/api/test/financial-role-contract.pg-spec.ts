import { Client } from 'pg';
import { isRealPostgresConfigured } from '@beauclick/testing';

/**
 * ADR-009 / GAP-01 verification, automated. Phase 1 does not implement
 * financial-service, but this phase's instructions require verifying that
 * the infrastructure contract it will depend on is genuinely enforceable
 * on the target PostgreSQL environment -- not merely designed.
 *
 * Requires TEST_FINANCIAL_WRITER_URL (a NON-superuser role granted only
 * INSERT + SELECT on the ledger table, per
 * database/scripts/financial-role-contract.sql). Self-skips when unset.
 *
 * The bar this must clear: UPDATE/DELETE/TRUNCATE are denied BY THE
 * DATABASE, with the row provably unchanged afterwards -- exactly the
 * guarantee V2's MySQL hosting could never provide.
 */
const writerUrl = process.env.TEST_FINANCIAL_WRITER_URL;
const readerUrl = process.env.TEST_FINANCIAL_READER_URL;
const describeIfConfigured = isRealPostgresConfigured() && writerUrl ? describe : describe.skip;

const LEDGER = 'financial_contract_check.ledger_entries';
const ROW_ID = '01926a3e-eeee-7abc-8def-0123456789ab';

describeIfConfigured('Financial ledger role contract (ADR-009 / GAP-01) on real PostgreSQL', () => {
  let writer: Client;

  beforeAll(async () => {
    writer = new Client({ connectionString: writerUrl });
    await writer.connect();
    await writer.query(`INSERT INTO ${LEDGER} (id, party_id, amount) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [
      ROW_ID,
      '01926a3e-ffff-7abc-8def-0123456789ab',
      250000,
    ]);
  });

  afterAll(async () => {
    await writer?.end();
  });

  it('the writer role is NOT a superuser (a superuser would make this whole test meaningless)', async () => {
    const { rows } = await writer.query('SELECT usesuper FROM pg_user WHERE usename = current_user');
    expect(rows[0].usesuper).toBe(false);
  });

  it('allows INSERT (the ledger must still be writable)', async () => {
    const id = '01926a3e-1111-7abc-8def-0123456789ab';
    await expect(
      writer.query(`INSERT INTO ${LEDGER} (id, party_id, amount) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [id, ROW_ID, 1000]),
    ).resolves.toBeDefined();
  });

  it('allows SELECT (the ledger must still be readable)', async () => {
    const { rows } = await writer.query(`SELECT id, amount FROM ${LEDGER} WHERE id = $1`, [ROW_ID]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(250000);
  });

  it('DENIES UPDATE at the database level', async () => {
    await expect(writer.query(`UPDATE ${LEDGER} SET amount = 999999 WHERE id = $1`, [ROW_ID])).rejects.toThrow(/permission denied/i);
  });

  it('DENIES DELETE at the database level', async () => {
    await expect(writer.query(`DELETE FROM ${LEDGER} WHERE id = $1`, [ROW_ID])).rejects.toThrow(/permission denied/i);
  });

  it('DENIES TRUNCATE at the database level', async () => {
    await expect(writer.query(`TRUNCATE ${LEDGER}`)).rejects.toThrow(/permission denied/i);
  });

  it('leaves the row genuinely unchanged after every denied mutation attempt', async () => {
    const { rows } = await writer.query(`SELECT amount FROM ${LEDGER} WHERE id = $1`, [ROW_ID]);
    expect(Number(rows[0].amount)).toBe(250000);
  });

  (readerUrl ? describe : describe.skip)('read-only role', () => {
    let reader: Client;

    beforeAll(async () => {
      reader = new Client({ connectionString: readerUrl });
      await reader.connect();
    });

    afterAll(async () => {
      await reader?.end();
    });

    it('allows SELECT', async () => {
      const { rows } = await reader.query(`SELECT id FROM ${LEDGER} WHERE id = $1`, [ROW_ID]);
      expect(rows).toHaveLength(1);
    });

    it('DENIES INSERT (read-only means read-only)', async () => {
      await expect(
        reader.query(`INSERT INTO ${LEDGER} (id, party_id, amount) VALUES ($1, $2, $3)`, ['01926a3e-2222-7abc-8def-0123456789ab', ROW_ID, 5]),
      ).rejects.toThrow(/permission denied/i);
    });

    it('DENIES UPDATE', async () => {
      await expect(reader.query(`UPDATE ${LEDGER} SET amount = 1 WHERE id = $1`, [ROW_ID])).rejects.toThrow(/permission denied/i);
    });
  });
});
