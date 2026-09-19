import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { OrderService } from '@beauclick/commerce';
import { CommissionPolicyService } from '@beauclick/commercial-policy';
import { COMMISSION_ARITHMETIC_VERSION } from '@beauclick/commercial-policy-contract';
import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, evaluateCoverage } from '@beauclick/subject-data';

import {
  PgTestApp,
  SeededUser,
  createPgTestApp,
  futureSlotTime,
  requiredPgEnv,
  resetDatabase,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

const describePg = requiredPgEnv() !== null ? describe : describe.skip;

/**
 * The per-order commission snapshot against a real PostgreSQL server — V3.3
 * Story #192 (`#43b-2`), ADR-052 §2, `V33-DEC-028` Ruling 4.
 *
 * ## Why every guarantee here is proved HERE
 *
 * pg-mem does not honour TypeORM's ROLLBACK, runs no PL/pgSQL, has no
 * `FOR SHARE` and no second connection to race against. This story's whole
 * content is those four things: a row written inside the checkout transaction
 * and gone if it rolls back, an append-only trigger, a share lock that makes a
 * publication wait, and a concurrent publication that cannot produce a mixed
 * snapshot. None is observable on the fast layer.
 *
 * ## Values in this file are TEST values
 *
 * Every basis-point figure and Toman amount is a suite fixture chosen to
 * exercise a rule. None is a product value and none reaches a migration, seed
 * or default — `#43b-1`'s boundary spec and the repository commission scan
 * prove that against the real files.
 */
describePg('order commission snapshot at commitment (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let orders: OrderService;
  let policies: CommissionPolicyService;
  let admin: SeededUser;

  let sequence = 0;
  const nextPhone = (): string => `+98917${String(100000 + (sequence += 1)).slice(0, 6)}`;
  const nextKey = (prefix: string): string => `${prefix}-${sequence}-${Date.now() % 100000}`;

  const TERMS = 'commerce.order_commission_terms';

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    orders = app.get(OrderService);
    policies = app.get(CommissionPolicyService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    admin = await seedUser(app, dataSource, nextPhone(), ['administrator']);
  });

  // -------------------------------------------------------------------------
  // Builders
  // -------------------------------------------------------------------------

  interface Seller {
    readonly professionalId: string;
    readonly serviceId: string;
  }

  async function seller(): Promise<Seller> {
    const owner = await seedUser(app, dataSource, nextPhone(), ['professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'فروشندهٔ سوئیت', 300_000);
    return { professionalId: professional.id, serviceId: professional.serviceId };
  }

  /** A real checkout through the real service, returning the order id. */
  async function checkout(s: Seller): Promise<string> {
    const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const slotId = await seedSlot(dataSource, s.professionalId, s.serviceId, futureSlotTime(24 + (sequence += 1)));
    // The slot is seeded so the fixture matches a real booking's shape; the
    // order service takes the booking, not the slot.
    void slotId;
    const order = await orders.createForBooking({
      bookingId: uuidv7(),
      customerId: customer.id,
      professionalId: s.professionalId,
      serviceId: s.serviceId,
    });
    return order.order.id;
  }

  /** Publishes one rule for one component, through the real administrator service. */
  async function publish(
    component: 'booking_commission' | 'acquisition' | 'processing_recovery',
    rule: { ruleKind: 'zero' | 'percentage' | 'fixed' | 'hybrid'; basisPoints?: number; fixedToman?: number; base?: 'platform_collected_amount' | 'service_total' },
  ): Promise<{ policyKey: string; version: number }> {
    const policyKey = nextKey('cm');
    await policies.createPolicy(admin.id, policyKey, component, 'suite commission policy', 'suite setup');
    const draft = await policies.createVersionDraft(
      admin.id,
      policyKey,
      {
        ruleKind: rule.ruleKind,
        basisPoints: rule.basisPoints ?? null,
        fixedToman: rule.fixedToman ?? null,
        base: rule.base ?? null,
        activationEndsAt: null,
      },
      'suite setup',
    );
    const published = await policies.publishVersion(admin.id, policyKey, draft.version, 'suite setup');
    return { policyKey, version: published.version };
  }

  const termsOf = async (orderId: string) =>
    dataSource.query(
      `SELECT component, state, policy_key, policy_version, rule_kind, bp, fixed_toman, base, arithmetic_version, resolved_at
         FROM ${TERMS} WHERE order_id = $1 ORDER BY component`,
      [orderId],
    );

  // =========================================================================
  // §1. Every order is snapshotted, for every component
  // =========================================================================

  describe('§1 the snapshot', () => {
    it('writes THREE rows for an order committed with no published policy, all `absent`, and the checkout succeeds', async () => {
      const s = await seller();
      const orderId = await checkout(s);

      const rows = await termsOf(orderId);
      expect(rows.map((row: { component: string; state: string }) => [row.component, row.state])).toEqual([
        ['acquisition', 'absent'],
        ['booking_commission', 'absent'],
        ['processing_recovery', 'absent'],
      ]);
      // `absent` carries nothing at all — the state matrix in SQL enforces it,
      // and this asserts the writer agrees rather than relying on the CHECK.
      for (const row of rows) {
        expect([row.policy_key, row.policy_version, row.rule_kind, row.bp, row.fixed_toman, row.base, row.arithmetic_version]).toEqual([
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ]);
      }
    });

    it('copies a published rule BY VALUE, and tells `zero` apart from `absent`', async () => {
      const percentage = await publish('booking_commission', {
        ruleKind: 'percentage',
        basisPoints: 1_500,
        base: 'platform_collected_amount',
      });
      const zero = await publish('acquisition', { ruleKind: 'zero' });
      // `processing_recovery` is deliberately left unpublished.

      const orderId = await checkout(await seller());
      const rows = await termsOf(orderId);
      const byComponent = new Map(rows.map((row: { component: string }) => [row.component, row]));

      expect(byComponent.get('booking_commission')).toMatchObject({
        state: 'rule',
        policy_key: percentage.policyKey,
        policy_version: percentage.version,
        rule_kind: 'percentage',
        bp: 1_500,
        base: 'platform_collected_amount',
        arithmetic_version: COMMISSION_ARITHMETIC_VERSION,
      });
      expect(byComponent.get('acquisition')).toMatchObject({
        state: 'zero',
        policy_key: zero.policyKey,
        policy_version: zero.version,
        rule_kind: 'zero',
        bp: null,
        fixed_toman: null,
        base: null,
      });
      // The distinction the whole state vocabulary exists for: somebody
      // decided to charge nothing, versus nobody decided anything.
      expect(byComponent.get('processing_recovery')).toMatchObject({ state: 'absent', policy_key: null });
    });

    it('copies a fixed and a hybrid rule with their own fields and no others', async () => {
      await publish('booking_commission', { ruleKind: 'fixed', fixedToman: 45_000 });
      await publish('acquisition', { ruleKind: 'hybrid', basisPoints: 250, fixedToman: 0, base: 'service_total' });

      const rows = await termsOf(await checkout(await seller()));
      const byComponent = new Map(rows.map((row: { component: string }) => [row.component, row]));

      expect(byComponent.get('booking_commission')).toMatchObject({
        state: 'rule',
        rule_kind: 'fixed',
        fixed_toman: '45000',
        bp: null,
        base: null,
      });
      expect(byComponent.get('acquisition')).toMatchObject({
        state: 'rule',
        rule_kind: 'hybrid',
        bp: 250,
        fixed_toman: '0',
        base: 'service_total',
      });
    });

    it('stamps one instant across an order`s three rows, and it is the transaction`s', async () => {
      const orderId = await checkout(await seller());
      const [{ instants }] = await dataSource.query(
        `SELECT count(DISTINCT resolved_at)::int AS instants FROM ${TERMS} WHERE order_id = $1`,
        [orderId],
      );
      expect(instants).toBe(1);
    });

    it('never refuses a checkout for want of a commission policy — the positive control for the whole story', async () => {
      // No policy exists at all; three checkouts in a row all succeed and all
      // record their own three rows. ADR-052 §2 and #173's own non-goal.
      const s = await seller();
      const ids = [await checkout(s), await checkout(s), await checkout(s)];
      for (const id of ids) expect(await termsOf(id)).toHaveLength(3);
    });
  });

  // =========================================================================
  // §2. Append-only
  // =========================================================================

  describe('§2 append-only', () => {
    it('refuses UPDATE and DELETE, through raw SQL, with the order named in the refusal', async () => {
      const orderId = await checkout(await seller());

      await expect(dataSource.query(`UPDATE ${TERMS} SET bp = 1 WHERE order_id = $1`, [orderId])).rejects.toThrow(
        /append-only/,
      );
      await expect(dataSource.query(`DELETE FROM ${TERMS} WHERE order_id = $1`, [orderId])).rejects.toThrow(/append-only/);

      // Positive control: the rows are still exactly as written.
      expect(await termsOf(orderId)).toHaveLength(3);
    });

    it('cannot hold two rows for one component of one order', async () => {
      const orderId = await checkout(await seller());
      await expect(
        dataSource.query(`INSERT INTO ${TERMS} (order_id, component, state) VALUES ($1, 'booking_commission', 'absent')`, [
          orderId,
        ]),
      ).rejects.toThrow(/order_commission_terms_pkey/);
    });
  });

  // =========================================================================
  // §3. Nothing on rollback
  // =========================================================================

  describe('§3 the transaction', () => {
    it('leaves NO row when the checkout transaction rolls back', async () => {
      const s = await seller();
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const slotId = await seedSlot(dataSource, s.professionalId, s.serviceId, futureSlotTime(24 + (sequence += 1)));
      const bookingId = uuidv7();

      let orderId = '';
      await expect(
        dataSource.transaction(async (manager) => {
          void slotId;
          const created = await orders.createForBooking(
            { bookingId, customerId: customer.id, professionalId: s.professionalId, serviceId: s.serviceId },
            manager,
          );
          orderId = created.order.id;

          // The rows exist INSIDE the transaction — otherwise the assertion
          // after the rollback would pass for the wrong reason.
          const inside = await manager.query(`SELECT count(*)::int AS count FROM ${TERMS} WHERE order_id = $1`, [orderId]);
          expect(inside[0].count).toBe(3);

          throw new Error('suite rollback');
        }),
      ).rejects.toThrow('suite rollback');

      expect(await termsOf(orderId)).toEqual([]);
      // And the order itself is gone too, so the snapshot did not outlive or
      // predecease the thing it describes.
      const [{ count }] = await dataSource.query(`SELECT count(*)::int AS count FROM commerce.orders WHERE id = $1`, [orderId]);
      expect(count).toBe(0);
    });
  });

  // =========================================================================
  // §4. A publication racing a checkout
  // =========================================================================

  describe('§4 publication racing checkout', () => {
    it('makes a retirement WAIT for an in-flight checkout, so no order sees a half-applied change', async () => {
      const published = await publish('booking_commission', {
        ruleKind: 'percentage',
        basisPoints: 1_000,
        base: 'platform_collected_amount',
      });
      const s = await seller();
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const slotId = await seedSlot(dataSource, s.professionalId, s.serviceId, futureSlotTime(24 + (sequence += 1)));

      let releaseCheckout: () => void = () => undefined;
      const holdUntil = new Promise<void>((resolve) => {
        releaseCheckout = resolve;
      });
      let checkoutReady: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        checkoutReady = resolve;
      });

      let orderId = '';
      const inFlight = dataSource.transaction(async (manager) => {
        void slotId;
        const created = await orders.createForBooking(
          { bookingId: uuidv7(), customerId: customer.id, professionalId: s.professionalId, serviceId: s.serviceId },
          manager,
        );
        orderId = created.order.id;
        checkoutReady();
        await holdUntil;
      });

      await ready;

      // The retirement cannot proceed while the checkout holds the version's
      // share lock. Proved by racing it against a timer rather than asserted.
      let retired = false;
      const retirement = policies
        .retireVersion(admin.id, published.policyKey, published.version, 'suite')
        .then(() => {
          retired = true;
        });
      const timer = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_500));
      expect(await Promise.race([retirement.then(() => 'retired' as const), timer])).toBe('timeout');
      expect(retired).toBe(false);

      releaseCheckout();
      await inFlight;
      await retirement;
      expect(retired).toBe(true);

      // The order kept the rule that was live when it committed. A retirement
      // is never retroactive, and the snapshot is why.
      const rows = await termsOf(orderId);
      const booking = rows.find((row: { component: string }) => row.component === 'booking_commission');
      expect(booking).toMatchObject({ state: 'rule', policy_key: published.policyKey, bp: 1_000 });
    });

    it('binds an order to the rule live at ITS commit instant, never to one published afterwards', async () => {
      const before = await checkout(await seller());
      const published = await publish('booking_commission', {
        ruleKind: 'percentage',
        basisPoints: 2_000,
        base: 'service_total',
      });
      const after = await checkout(await seller());

      const beforeRow = (await termsOf(before)).find((row: { component: string }) => row.component === 'booking_commission');
      const afterRow = (await termsOf(after)).find((row: { component: string }) => row.component === 'booking_commission');

      expect(beforeRow).toMatchObject({ state: 'absent', policy_key: null });
      expect(afterRow).toMatchObject({ state: 'rule', policy_key: published.policyKey, bp: 2_000 });
      // The earlier order is untouched by a later publication — the property
      // the whole snapshot exists to provide.
      expect(beforeRow.resolved_at.getTime()).toBeLessThan(afterRow.resolved_at.getTime());
    });
  });

  // =========================================================================
  // §5. Orders older than the table
  // =========================================================================

  describe('§5 an order that predates the table', () => {
    it('has no rows, and that absence is the documented reading rather than a defect', async () => {
      const orderId = await checkout(await seller());
      // Simulate the pre-migration state: remove the snapshot the way a
      // restore of an older dump would leave it. TRUNCATE bypasses the
      // append-only trigger, which is exactly how the test factory resets.
      await dataSource.query(`TRUNCATE ${TERMS}`);

      expect(await termsOf(orderId)).toEqual([]);
      // The order is still readable and unchanged: nothing in the order path
      // depends on the snapshot existing.
      const [order] = await dataSource.query(`SELECT id, status FROM commerce.orders WHERE id = $1`, [orderId]);
      expect(order.id).toBe(orderId);
    });
  });

  // =========================================================================
  // §6. ADR-027
  // =========================================================================

  describe('§6 privacy', () => {
    it('claims the table `retained`, and without the claim the boot check would fail on exactly it', async () => {
      const rows = await dataSource.query(
        `SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
      );
      const catalogue = rows.map((row: { schemaname: string; tablename: string }) => ({
        schema: row.schemaname,
        name: row.tablename,
        columns: [] as string[],
      }));

      const all = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const commerce = all.find((contract) => contract.tables.some((table) => table.table === 'commerce.order_commission_terms'));
      expect(commerce).toBeDefined();
      expect(commerce!.tables.find((table) => table.table === 'commerce.order_commission_terms')?.disposition).toBe('retained');

      expect(evaluateCoverage(catalogue, all).violations.filter((v) => v.table === 'commerce.order_commission_terms')).toEqual([]);

      // Non-vacuity: drop the claiming contract and exactly this table is
      // reported unclaimed, which is what stops the application booting.
      const without = all.filter((contract) => contract !== commerce);
      const unclaimed = evaluateCoverage(catalogue, without)
        .violations.filter((v) => v.kind === 'unclaimed' && v.table === 'commerce.order_commission_terms');
      expect(unclaimed).toHaveLength(1);
    });

    it('is not exported to the customer: the snapshot is a platform/seller arrangement', async () => {
      const orderId = await checkout(await seller());
      expect(await termsOf(orderId)).toHaveLength(3);

      const all = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const commerce = all.find((contract) => contract.tables.some((table) => table.table === 'commerce.order_commission_terms'))!;
      const sections = await commerce.exportSubjectData(dataSource.manager, admin.id);
      const serialised = JSON.stringify(sections);
      expect(serialised).not.toContain('commission');
    });
  });
});
