import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, evaluateCoverage, SubjectDataCoverageService } from '@beauclick/subject-data';

import {
  PgTestApp,
  createPgTestApp,
  requiredPgEnv,
  resetDatabase,
} from './pg-test-app.factory';

const describePg = requiredPgEnv() !== null ? describe : describe.skip;

/**
 * REAL PostgreSQL: V3.3 Story #95 (`#58b-1`) -- the booking-credit
 * enforcement control foundation, ADR-050.
 *
 * Every claim here is about a CHECK, a trigger, a row lock, an advisory lock,
 * a `REPEATABLE READ` snapshot or a rollback; pg-mem honours none of them.
 * Section numbers follow ADR-050 §10's matrix so a probe can be traced to the
 * test it must kill.
 */
describePg('booking-credit enforcement control foundation (#95 / #58b-1, real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  const CONTROL = 'commercial.booking_credit_enforcement_control';
  const GOVERNANCE = 'commercial.booking_credit_party_governance';

  const controlRow = async () => (await dataSource.query(`SELECT * FROM ${CONTROL} WHERE id = 1`))[0];

  /** Run SQL that must be refused, and return the SQLSTATE it was refused with. */
  async function refused(sql: string, params: unknown[] = []): Promise<string> {
    try {
      await dataSource.query(sql, params);
    } catch (err) {
      return (err as { code?: string }).code ?? 'unknown';
    }
    throw new Error(`expected a refusal for: ${sql}`);
  }

  async function plantedGovernance(state: 'legacy_exempt' | 'governed', overrides: Record<string, unknown> = {}): Promise<string> {
    const id = uuidv7();
    const row = {
      party_type: 'professional',
      party_id: uuidv7(),
      state,
      cause: state === 'governed' ? 'created_under_enforcement' : 'explicit_exemption',
      proof_grant_id: null,
      governed_at: state === 'governed' ? new Date() : null,
      recorded_by_user_id: null,
      recorded_by_label: 'suite',
      audit_id: uuidv7(),
      ...overrides,
    };
    await dataSource.query(
      `INSERT INTO ${GOVERNANCE}
         (id, party_type, party_id, state, cause, proof_grant_id, governed_at, recorded_by_user_id, recorded_by_label, audit_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, row.party_type, row.party_id, row.state, row.cause, row.proof_grant_id, row.governed_at, row.recorded_by_user_id, row.recorded_by_label, row.audit_id],
    );
    return id;
  }

  // =========================================================================
  // §A  Schema: the migration produced exactly the ratified shape (case 26)
  // =========================================================================

  describe('§A schema and constraints (ADR-050 §2, case 26)', () => {
    it('seeded exactly one control row in its initial safe state', async () => {
      const rows = await dataSource.query(`SELECT * FROM ${CONTROL}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 1,
        rollout_state: 'inactive',
        activation_generation: 0,
        activated_at: null,
        activation_audit_id: null,
        kill_switch_state: 'released',
        kill_switch_changed_at: null,
        kill_switch_audit_id: null,
      });
    });

    it('ck_bcec_singleton refuses a second row, whatever its id', async () => {
      expect(await refused(`INSERT INTO ${CONTROL} (id, rollout_state, activation_generation, kill_switch_state) VALUES (2, 'inactive', 0, 'released')`)).toBe('23514');
      expect(await refused(`INSERT INTO ${CONTROL} (id, rollout_state, activation_generation, kill_switch_state) VALUES (1, 'inactive', 0, 'released')`)).toBe('23505');
    });

    it('the control row refuses every value outside its vocabularies', async () => {
      expect(await refused(`UPDATE ${CONTROL} SET rollout_state = 'paused' WHERE id = 1`)).toBe('23514');
      expect(await refused(`UPDATE ${CONTROL} SET kill_switch_state = 'armed' WHERE id = 1`)).toBe('23514');
      expect(await refused(`UPDATE ${CONTROL} SET activation_generation = -1 WHERE id = 1`)).toMatch(/23514|23001/);
    });

    it('ck_bcec_activation_consistent binds the activation facts together', async () => {
      // An active rollout with no instant, no audit pointer or generation zero.
      expect(await refused(`UPDATE ${CONTROL} SET rollout_state = 'active', activation_generation = 1 WHERE id = 1`)).toBe('23514');
      // An inactive rollout carrying activation facts.
      expect(await refused(`UPDATE ${CONTROL} SET activated_at = now() WHERE id = 1`)).toBe('23514');
      expect(await refused(`UPDATE ${CONTROL} SET activation_audit_id = $1 WHERE id = 1`, [uuidv7()])).toBe('23514');
    });

    it('ck_bcec_kill_switch_consistent binds the kill-switch facts together', async () => {
      expect(await refused(`UPDATE ${CONTROL} SET kill_switch_state = 'engaged' WHERE id = 1`)).toBe('23514');
      expect(await refused(`UPDATE ${CONTROL} SET kill_switch_changed_at = now() WHERE id = 1`)).toBe('23514');
      expect(await refused(`UPDATE ${CONTROL} SET kill_switch_audit_id = $1 WHERE id = 1`, [uuidv7()])).toBe('23514');
      // Control: the consistent shape is accepted, in both directions.
      await dataSource.query(`UPDATE ${CONTROL} SET kill_switch_state = 'engaged', kill_switch_changed_at = now(), kill_switch_audit_id = $1 WHERE id = 1`, [uuidv7()]);
      expect((await controlRow()).kill_switch_state).toBe('engaged');
      await dataSource.query(`UPDATE ${CONTROL} SET kill_switch_state = 'released', kill_switch_changed_at = now(), kill_switch_audit_id = $1 WHERE id = 1`, [uuidv7()]);
      expect((await controlRow()).kill_switch_state).toBe('released');
    });

    it('uq_bcpg_party refuses a second row for one party', async () => {
      const partyId = uuidv7();
      await plantedGovernance('legacy_exempt', { party_id: partyId });
      expect(await refused(
        `INSERT INTO ${GOVERNANCE} (id, party_type, party_id, state, cause, recorded_by_label, audit_id)
         VALUES ($1, 'professional', $2, 'legacy_exempt', 'explicit_exemption', 'suite', $3)`,
        [uuidv7(), partyId, uuidv7()],
      )).toBe('23505');
      // Non-vacuity: the same party id under the OTHER party type is a different party.
      await plantedGovernance('legacy_exempt', { party_type: 'business', party_id: partyId });
    });

    it('ck_bcpg_cause_state, ck_bcpg_proof, ck_bcpg_governed_at and ck_bcpg_actor refuse every illegal combination', async () => {
      const base = (over: Record<string, unknown>) => plantedGovernance('governed', over);
      // exemption cause on a governed row / transition cause on an exempt row
      await expect(base({ cause: 'explicit_exemption' })).rejects.toMatchObject({ code: '23514' });
      await expect(plantedGovernance('legacy_exempt', { cause: 'explicit_transition', proof_grant_id: uuidv7() })).rejects.toMatchObject({ code: '23514' });
      // explicit_transition without proof; any other cause with proof
      await expect(base({ cause: 'explicit_transition', proof_grant_id: null })).rejects.toMatchObject({ code: '23514' });
      await expect(base({ cause: 'created_under_enforcement', proof_grant_id: uuidv7() })).rejects.toMatchObject({ code: '23514' });
      // governed without governed_at; exempt with governed_at
      await expect(base({ governed_at: null })).rejects.toMatchObject({ code: '23514' });
      await expect(plantedGovernance('legacy_exempt', { governed_at: new Date() })).rejects.toMatchObject({ code: '23514' });
      // actor XOR
      await expect(base({ recorded_by_user_id: uuidv7(), recorded_by_label: 'suite' })).rejects.toMatchObject({ code: '23514' });
      await expect(base({ recorded_by_user_id: null, recorded_by_label: null })).rejects.toMatchObject({ code: '23514' });
      // vocabularies
      await expect(base({ state: 'suspended', governed_at: null })).rejects.toMatchObject({ code: '23514' });
      await expect(base({ party_type: 'staff' })).rejects.toMatchObject({ code: '23514' });
      // proof must be a REAL grant
      await expect(base({ cause: 'explicit_transition', proof_grant_id: uuidv7() })).rejects.toMatchObject({ code: '23503' });
      // Control: a legal governed row and a legal exempt row are accepted.
      await base({});
      await plantedGovernance('legacy_exempt');
    });

    it('carries no commercial number: no column named for an allowance, price, quantity or bound', async () => {
      const columns: string[] = (
        await dataSource.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'commercial' AND table_name IN ('booking_credit_enforcement_control', 'booking_credit_party_governance')`,
        )
      ).map((r: { column_name: string }) => r.column_name);
      expect(columns.length).toBe(21);
      for (const column of columns) expect(column).not.toMatch(/credit|allowance|quota|price|quantity|min|max|grace|expir/i);
    });
  });

  // =========================================================================
  // §B  Triggers: one-way rollout, monotonic governance, no DELETE (case 25)
  // =========================================================================

  describe('§B triggers (ADR-050 §2, case 25)', () => {
    it('the control row cannot be deleted', async () => {
      expect(await refused(`DELETE FROM ${CONTROL} WHERE id = 1`)).toBe('23001');
      expect(await dataSource.query(`SELECT count(*)::int AS n FROM ${CONTROL}`)).toEqual([{ n: 1 }]);
    });

    it('the rollout cannot go active -> inactive, and activation facts are immutable once active', async () => {
      // The trigger admits the #141 transition shape so that story needs no
      // schema change; everything after it is refused. Proven inside one
      // rolled-back transaction, so no suite ever leaves the row active.
      await expect(
        dataSource.transaction(async (m) => {
          await m.query(
            `UPDATE ${CONTROL} SET rollout_state = 'active', activation_generation = 1, activated_at = now(), activation_audit_id = $1 WHERE id = 1`,
            [uuidv7()],
          );
          expect((await m.query(`SELECT rollout_state FROM ${CONTROL}`))[0].rollout_state).toBe('active');

          for (const sql of [
            `UPDATE ${CONTROL} SET rollout_state = 'inactive', activation_generation = 0, activated_at = NULL, activation_audit_id = NULL WHERE id = 1`,
            `UPDATE ${CONTROL} SET activation_generation = 2 WHERE id = 1`,
            `UPDATE ${CONTROL} SET activated_at = now() - interval '1 day' WHERE id = 1`,
            `UPDATE ${CONTROL} SET activation_audit_id = '${uuidv7()}' WHERE id = 1`,
          ]) {
            await m.query('SAVEPOINT probe');
            try {
              await m.query(sql);
              throw new Error(`accepted: ${sql}`);
            } catch (err) {
              expect((err as { code?: string }).code).toBe('23001');
            } finally {
              await m.query('ROLLBACK TO SAVEPOINT probe');
            }
          }
          // The kill switch still moves while active.
          await m.query(`UPDATE ${CONTROL} SET kill_switch_state = 'engaged', kill_switch_changed_at = now(), kill_switch_audit_id = $1 WHERE id = 1`, [uuidv7()]);
          throw new Error('planted rollback');
        }),
      ).rejects.toThrow('planted rollback');
      expect((await controlRow()).rollout_state).toBe('inactive');
    });

    it('activation must increment the generation by exactly one, and the generation cannot move while inactive', async () => {
      expect(await refused(`UPDATE ${CONTROL} SET rollout_state = 'active', activation_generation = 2, activated_at = now(), activation_audit_id = $1 WHERE id = 1`, [uuidv7()])).toBe('23001');
      expect(await refused(`UPDATE ${CONTROL} SET activation_generation = 1 WHERE id = 1`)).toBe('23001');
      expect(await refused(`UPDATE ${CONTROL} SET id = 1, created_at = now() - interval '1 day' WHERE id = 1`)).toBe('23001');
    });

    it('governance rows cannot be deleted', async () => {
      const id = await plantedGovernance('legacy_exempt');
      expect(await refused(`DELETE FROM ${GOVERNANCE} WHERE id = $1`, [id])).toBe('23001');
      expect(await dataSource.query(`SELECT count(*)::int AS n FROM ${GOVERNANCE}`)).toEqual([{ n: 1 }]);
    });

    it('governed -> legacy_exempt is refused, as is every rewrite of a governed row', async () => {
      const id = await plantedGovernance('governed');
      expect(await refused(`UPDATE ${GOVERNANCE} SET state = 'legacy_exempt', cause = 'explicit_exemption', governed_at = NULL WHERE id = $1`, [id])).toBe('23001');
      expect(await refused(`UPDATE ${GOVERNANCE} SET governed_at = now() WHERE id = $1`, [id])).toBe('23001');
      expect(await refused(`UPDATE ${GOVERNANCE} SET recorded_by_label = 'someone' WHERE id = $1`, [id])).toBe('23001');
      expect(await refused(`UPDATE ${GOVERNANCE} SET party_id = $2 WHERE id = $1`, [id, uuidv7()])).toBe('23001');
    });

    it('legacy_exempt -> governed by explicit transition is the ONE permitted update, and only in its full shape', async () => {
      const id = await plantedGovernance('legacy_exempt');
      // A real grant to point the proof at.
      const grantId = await plantGrant();

      for (const sql of [
        `UPDATE ${GOVERNANCE} SET state = 'governed' WHERE id = $1`,
        `UPDATE ${GOVERNANCE} SET state = 'governed', cause = 'created_under_enforcement', governed_at = now() WHERE id = $1`,
        `UPDATE ${GOVERNANCE} SET state = 'governed', cause = 'explicit_transition', governed_at = now() WHERE id = $1`,
        `UPDATE ${GOVERNANCE} SET recorded_by_label = 'other' WHERE id = $1`,
        `UPDATE ${GOVERNANCE} SET recorded_at = now() - interval '1 day' WHERE id = $1`,
      ]) {
        expect(await refused(sql, [id])).toMatch(/23001|23514/);
      }

      await dataSource.query(
        `UPDATE ${GOVERNANCE}
            SET state = 'governed', cause = 'explicit_transition', governed_at = now(), proof_grant_id = $2, audit_id = $3
          WHERE id = $1`,
        [id, grantId, uuidv7()],
      );
      const [row] = await dataSource.query(`SELECT state, cause, proof_grant_id FROM ${GOVERNANCE} WHERE id = $1`, [id]);
      expect(row).toEqual({ state: 'governed', cause: 'explicit_transition', proof_grant_id: grantId });
    });
  });

  async function plantGrant(): Promise<string> {
    // A minimal, real grant row: `proof_grant_id` is a genuine FK, so the
    // trigger test above needs a genuine grant. Built through the catalogue
    // and subscription tables exactly as the #58a suite plants its grants.
    const scheduleVersionId = uuidv7();
    await dataSource.query(`INSERT INTO commercial.price_schedules (schedule_key, purpose, created_by_label) VALUES ('enf-base', 'seller_plan', 'suite') ON CONFLICT DO NOTHING`);
    await dataSource.query(
      `INSERT INTO commercial.price_schedule_versions (id, schedule_key, version, display_name, currency_code, min_purchase_quantity, max_purchase_quantity, ui_preset_quantities, activation_starts_at, created_by_label)
       VALUES ($1, 'enf-base', 1, 'enf base', 'IRT', 1, 1, '{}', '1970-01-01T00:00:00Z', 'suite')`,
      [scheduleVersionId],
    );
    await dataSource.query(`INSERT INTO commercial.price_tiers (id, schedule_version_id, min_quantity, max_quantity, unit_price_toman, created_by_label) VALUES ($1, $2, 1, 1, 0, 'suite')`, [uuidv7(), scheduleVersionId]);
    await dataSource.query(`UPDATE commercial.price_schedule_versions SET lifecycle_state = 'published', published_at = now(), published_by_label = 'suite' WHERE id = $1`, [scheduleVersionId]);
    const planVersionId = uuidv7();
    await dataSource.query(`INSERT INTO commercial.plans (plan_key, created_by_label) VALUES ('ENF-BASE', 'suite') ON CONFLICT DO NOTHING`);
    await dataSource.query(
      `INSERT INTO commercial.plan_versions (id, plan_key, version, display_name, billing_term_days, included_booking_credits, staff_seats, included_locations, capability_keys, price_schedule_version_id, auto_assignable, activation_starts_at, created_by_label)
       VALUES ($1, 'ENF-BASE', 1, 'enf base', NULL, 0, 0, 0, '{}', $2, true, '1970-01-01T00:00:00Z', 'suite')`,
      [planVersionId, scheduleVersionId],
    );
    await dataSource.query(`UPDATE commercial.plan_versions SET lifecycle_state = 'published', published_at = now(), published_by_label = 'suite' WHERE id = $1`, [planVersionId]);
    const subscriptionId = uuidv7();
    const partyId = uuidv7();
    await dataSource.query(
      `INSERT INTO commercial.seller_subscriptions
         (id, subscriber_party_type, subscriber_party_id, plan_version_id, lifecycle_state, snapshot_plan_key, snapshot_version, snapshot_billing_term_days,
          snapshot_included_booking_credits, snapshot_staff_seats, snapshot_included_locations, snapshot_capability_keys, snapshot_currency_code,
          snapshot_unit_price_toman, snapshot_price_schedule_version_id, effective_at, created_by_label)
       VALUES ($1, 'professional', $2, $3, 'active', 'ENF-BASE', 1, NULL, 0, 0, 0, '{}', 'IRT', 0, $4, now(), 'suite')`,
      [subscriptionId, partyId, planVersionId, scheduleVersionId],
    );
    const grantId = uuidv7();
    await dataSource.query(
      `INSERT INTO commercial.booking_credit_grants (id, subscription_id, plan_version_id, subscriber_party_type, subscriber_party_id, source, quantity, period_index)
       VALUES ($1, $2, $3, 'professional', $4, 'plan_included', 1, 0)`,
      [grantId, subscriptionId, planVersionId, partyId],
    );
    return grantId;
  }

  // =========================================================================
  // §C  ADR-027 dispositions, pinned (case 27)
  // =========================================================================

  describe('§C ADR-027 dispositions (ADR-050 §8, case 27)', () => {
    let contracts: SubjectDataContract[];
    let coverage: SubjectDataCoverageService;

    beforeAll(() => {
      contracts = app.get(SUBJECT_DATA_CONTRACTS);
      coverage = app.get(SubjectDataCoverageService);
    });

    it('claims the control row no_subject_data and the governance table retained, each exactly once with a reason', () => {
      const claims = contracts.flatMap((c) => c.tables.filter((t) => t.table.startsWith('commercial.booking_credit_enforcement') || t.table === GOVERNANCE));
      expect(claims.map((c) => `${c.table}:${c.disposition}`).sort()).toEqual([
        'commercial.booking_credit_enforcement_control:no_subject_data',
        'commercial.booking_credit_party_governance:retained',
      ]);
      for (const claim of claims) expect((claim.reason ?? '').length).toBeGreaterThan(40);
    });

    it('the live catalogue is fully claimed, both new tables included', async () => {
      const catalogue = await coverage.readCatalogue();
      const names = catalogue.map((t) => `${t.schema}.${t.name}`);
      expect(names).toContain(CONTROL);
      expect(names).toContain(GOVERNANCE);
      expect(evaluateCoverage(catalogue, contracts).violations).toEqual([]);
    });

    it('a dishonest no_subject_data claim on the governance table is DETECTED (wrongly_declared_empty)', async () => {
      const catalogue = await coverage.readCatalogue();
      const dishonest = contracts.map((c) => ({
        ...c,
        tables: c.tables.map((t) => (t.table === GOVERNANCE ? { ...t, disposition: 'no_subject_data' as const, reason: 'dishonest' } : t)),
      })) as SubjectDataContract[];
      const violations = evaluateCoverage(catalogue, dishonest).violations;
      expect(violations.map((v) => `${v.kind}:${v.table}`)).toContain(`wrongly_declared_empty:${GOVERNANCE}`);
    });

    it('the heuristic CANNOT detect a dishonest claim on the control row -- which is why the pin above exists', async () => {
      // Non-vacuity of the explicit pin: if the detector could see it, the pin
      // would be redundant. It cannot, because the row has no `_by` or
      // `_user_id` column -- and that is the honest reason it is no_subject_data.
      const catalogue = await coverage.readCatalogue();
      const control = catalogue.find((t) => `${t.schema}.${t.name}` === CONTROL)!;
      expect(control.columns.some((c) => c.endsWith('_by') || c.endsWith('_user_id'))).toBe(false);
    });
  });
});
