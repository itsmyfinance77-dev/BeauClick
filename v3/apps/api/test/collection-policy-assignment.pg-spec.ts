import { INestApplication, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, evaluateCoverage } from '@beauclick/subject-data';
import {
  BookingCollectionPolicyService,
  CollectionPolicyAssignmentService,
  CollectionPolicyAssignmentUnavailableException,
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

const ASSIGNMENTS = 'commercial.seller_collection_policy_assignments';

/**
 * Seller collection-policy assignment against a real PostgreSQL server —
 * V3.3 Story #104 (`#41d-2a`), ADR-048 R2 and R5, `V33-DEC-031`.
 *
 * ## Why the evidence is here rather than on the fast layer
 *
 * pg-mem has no partial unique indexes, no deferrable constraints, no row-level
 * locks, no PL/pgSQL and no honoured ROLLBACK. **Every invariant this story
 * rests on is one of those**: one current row per party, the terminal
 * supersession pairing, immutability, the refusal to DELETE, the deferred
 * self-reference that makes supersession writable at all, the retirement race,
 * and the audit row's atomicity with the mutation. They are proved here or
 * nowhere. The pure half — request shape and projection minimalism — is proved
 * fast, in `collection-policy-assignment-contract.spec.ts`.
 *
 * ## Service-driven and raw-SQL cases, deliberately mixed
 *
 * A rule the service upholds is only a rule the service upholds. ADR-048's
 * claim is stronger: the assignment history is immutable against anything
 * holding a connection. So the invariants are attacked with raw SQL, and the
 * behaviour is exercised through the real service and the real HTTP surface.
 */
describePg('seller collection-policy assignment (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let assignments: CollectionPolicyAssignmentService;
  let policies: BookingCollectionPolicyService;
  let admin: SeededUser;

  let sequence = 0;
  const nextKey = (prefix: string): string => `${prefix}-${(sequence += 1)}-${Date.now() % 100000}`;
  const nextPhone = (): string => `+98913${String(100000 + (sequence += 1)).slice(-6)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    assignments = app.get(CollectionPolicyAssignmentService);
    policies = app.get(BookingCollectionPolicyService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    admin = await seedUser(app, dataSource, nextPhone(), ['administrator']);
  });

  // =========================================================================
  // Builders — real rows through the real administrator service
  // =========================================================================

  /** A published, currently-active policy: the only kind a seller may assign. */
  async function publishedPolicy(key = nextKey('cp')): Promise<string> {
    await policies.createPolicy(admin.id, key, `${key} display`, 'suite setup');
    const draft = await policies.createVersionDraft(
      admin.id,
      {
        policyKey: key,
        terms: { contractVersion: 1, collectionMode: 'full_payment_online', deposit: { kind: 'none' } },
        activationEndsAt: null,
      },
      'suite setup',
    );
    await policies.publishVersion(admin.id, key, draft.version, 'suite setup');
    return key;
  }

  /** A key whose only version is still a draft — present in the catalogue, never assignable. */
  async function draftOnlyPolicy(key = nextKey('dft')): Promise<string> {
    await policies.createPolicy(admin.id, key, `${key} display`, 'suite setup');
    await policies.createVersionDraft(
      admin.id,
      {
        policyKey: key,
        terms: { contractVersion: 1, collectionMode: 'pay_at_venue', deposit: { kind: 'none' } },
        activationEndsAt: null,
      },
      'suite setup',
    );
    return key;
  }

  /** A published key whose only version has since been retired. */
  async function retiredPolicy(): Promise<string> {
    const key = await publishedPolicy(nextKey('ret'));
    const versions = await policies.listVersions(key);
    await policies.retireVersion(admin.id, key, versions[0].version, 'suite setup');
    return key;
  }

  interface Owner {
    user: SeededUser;
    workspaceRef: string;
    partyId: string;
  }

  async function professionalOwner(): Promise<Owner> {
    const user = await seedUser(app, dataSource, nextPhone(), ['professional']);
    const professional = await seedProfessional(dataSource, user.id, 'متخصص آزمون');
    return { user, workspaceRef: (await workspaceRefsFor(user))[0], partyId: professional.id };
  }

  async function businessOwner(): Promise<Owner> {
    const user = await seedUser(app, dataSource, nextPhone(), ['business']);
    const business = await seedBusiness(dataSource, user.id, 'کسب‌وکار آزمون');
    return { user, workspaceRef: (await workspaceRefsFor(user))[0], partyId: business.id };
  }

  /**
   * The caller's own workspace references, obtained the only way a client can:
   * from the subscription surface that already issues them.
   *
   * Deriving one in the test would be a second reference implementation —
   * `V33-DEC-031` R1 requires this surface to reuse #69's, and a test that
   * computed its own would pass even if the two had drifted apart, which is the
   * single most valuable thing this helper proves.
   */
  async function workspaceRefsFor(user: SeededUser): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .get('/api/v1/me/subscriptions')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    const items = response.body.data.items as Array<{ workspaceRef: string }>;
    expect(items.length).toBeGreaterThan(0);
    return items.map((item) => item.workspaceRef);
  }

  // ------------------------------------------------------------------ rows

  const rowsFor = (partyId: string): Promise<Array<Record<string, string | Date | null>>> =>
    dataSource.query(`SELECT * FROM ${ASSIGNMENTS} WHERE seller_party_id = $1 ORDER BY assigned_at, id`, [partyId]);

  /**
   * The audit rows this story wrote FOR ONE PARTY.
   *
   * Filtered by a join rather than counted, because `admin.admin_audit_log` is
   * owned by a role the application cannot TRUNCATE — `resetDatabase` leaves it
   * standing on purpose, so rows accumulate across cases in a run and any
   * assertion that counted the table would be measuring the whole suite.
   * `operability-foundation.pg-spec.ts` filters by `target_id` for the same
   * reason; here the target IS an assignment id, so the join is exact.
   */
  const assignmentAuditFor = (
    partyId: string,
  ): Promise<Array<{ action: string; reason: string | null; target_id: string }>> =>
    dataSource.query(
      `SELECT l.action, l.reason, l.target_id
         FROM admin.admin_audit_log l
         JOIN ${ASSIGNMENTS} a ON a.id::text = l.target_id
        WHERE l.target_type = 'commercial_collection_policy_assignment'
          AND a.seller_party_id = $1
        ORDER BY l.created_at, l.id`,
      [partyId],
    );

  /**
   * Audit rows carrying one exact reason.
   *
   * The complement of the join above: it finds a row even when the assignment
   * it claims to describe does NOT exist, which is precisely the leak a
   * "refusal writes nothing" case has to rule out.
   */
  const auditWithReason = (reason: string): Promise<Array<{ action: string }>> =>
    dataSource.query(`SELECT action FROM admin.admin_audit_log WHERE reason = $1`, [reason]);

  const auditTotal = async (): Promise<number> =>
    (await dataSource.query(`SELECT count(*)::int AS n FROM admin.admin_audit_log`))[0].n;

  // ------------------------------------------------------------------ HTTP

  const authed = (user: SeededUser): string => `Bearer ${user.accessToken}`;

  const listPolicies = (user: SeededUser) =>
    request(app.getHttpServer()).get('/api/v1/me/collection-policies').set('Authorization', authed(user));

  const readAssignment = (user: SeededUser, ref: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/me/collection-policy-assignments/${ref}`)
      .set('Authorization', authed(user));

  const putAssignment = (user: SeededUser, ref: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .put(`/api/v1/me/collection-policy-assignments/${ref}`)
      .set('Authorization', authed(user))
      .send(body);

  // =========================================================================
  // §1. The migration, and the zero-row foundation
  // =========================================================================

  describe('§1 migration and zero rows', () => {
    it('created exactly one table, carrying every named invariant', async () => {
      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM pg_tables
          WHERE schemaname='commercial' AND tablename='seller_collection_policy_assignments'`,
      );
      expect(n).toBe(1);

      const constraints: string[] = (
        await dataSource.query(
          `SELECT conname FROM pg_constraint WHERE conrelid='${ASSIGNMENTS}'::regclass ORDER BY conname`,
        )
      ).map((row: { conname: string }) => row.conname);
      for (const required of [
        'ck_scpa_party_type',
        'ck_scpa_supersession_pairing',
        'ck_scpa_supersession_forward',
        'ck_scpa_not_self_superseding',
      ]) {
        expect(constraints).toContain(required);
      }

      const indexes: string[] = (
        await dataSource.query(
          `SELECT indexname FROM pg_indexes WHERE schemaname='commercial'
            AND tablename='seller_collection_policy_assignments'`,
        )
      ).map((row: { indexname: string }) => row.indexname);
      expect(indexes).toEqual(
        expect.arrayContaining(['uq_scpa_one_current_per_party', 'ix_scpa_party_history', 'ix_scpa_policy_key']),
      );

      const triggers: string[] = (
        await dataSource.query(
          `SELECT tgname FROM pg_trigger WHERE tgrelid='${ASSIGNMENTS}'::regclass AND NOT tgisinternal`,
        )
      ).map((row: { tgname: string }) => row.tgname);
      expect(triggers).toEqual(['tg_scpa_immutable']);
    });

    it('declares the successor reference DEFERRABLE INITIALLY DEFERRED', async () => {
      const [fk] = await dataSource.query(
        `SELECT condeferrable, condeferred FROM pg_constraint
          WHERE conrelid='${ASSIGNMENTS}'::regclass AND contype='f'
            AND pg_get_constraintdef(oid) LIKE '%superseded_by_assignment_id%'`,
      );
      // Without BOTH, supersession is simply unwritable: the pairing CHECK
      // needs the successor's id on the predecessor, while the partial unique
      // index forbids the successor existing before the predecessor ends.
      expect(fk.condeferrable).toBe(true);
      expect(fk.condeferred).toBe(true);
    });

    it('has an immutable-only column set: no enrollment flag and no lifecycle state', async () => {
      const columns: string[] = (
        await dataSource.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema='commercial' AND table_name='seller_collection_policy_assignments'
            ORDER BY ordinal_position`,
        )
      ).map((row: { column_name: string }) => row.column_name);

      // Presence IS enrollment (ADR-048 R2). An exact list, so a later author
      // adding an `enrolled` boolean fails here rather than in production.
      expect(columns).toEqual([
        'id',
        'seller_party_type',
        'seller_party_id',
        'policy_key',
        'assigned_at',
        'assigned_by_user_id',
        'superseded_at',
        'superseded_by_user_id',
        'superseded_by_assignment_id',
      ]);
    });

    it('holds zero assignments: the migration enrolled nobody', async () => {
      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM ${ASSIGNMENTS}`);
      expect(n).toBe(0);
    });

    it('granted the capability non-privileged, to exactly the two seller roles', async () => {
      const [capability] = await dataSource.query(
        `SELECT is_privileged FROM identity.capabilities WHERE slug='bc_manage_own_collection_policy'`,
      );
      expect(capability.is_privileged).toBe(false);

      const roles: string[] = (
        await dataSource.query(
          `SELECT role_slug FROM identity.role_capabilities
            WHERE capability_slug='bc_manage_own_collection_policy' ORDER BY role_slug`,
        )
      ).map((row: { role_slug: string }) => row.role_slug);
      expect(roles).toEqual(['business', 'professional']);
    });
  });

  // =========================================================================
  // §2. The database invariants, attacked with raw SQL
  // =========================================================================

  describe('§2 database invariants (direct SQL)', () => {
    async function insertRaw(partyId: string, overrides: Record<string, unknown> = {}): Promise<string> {
      const id = uuidv7();
      const row: Record<string, unknown> = {
        id,
        seller_party_type: 'professional',
        seller_party_id: partyId,
        policy_key: await publishedPolicy(),
        assigned_by_user_id: admin.id,
        ...overrides,
      };
      const names = Object.keys(row);
      await dataSource.query(
        `INSERT INTO ${ASSIGNMENTS} (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
      return id;
    }

    it('accepts a well-formed row, so every refusal below means something', async () => {
      const partyId = uuidv7();
      await expect(insertRaw(partyId)).resolves.toBeTruthy();

      const rows = await rowsFor(partyId);
      expect(rows).toHaveLength(1);
      expect(rows[0].superseded_at).toBeNull();
      // The instant is PostgreSQL's own: no caller supplied it, and it is now.
      expect(Math.abs((rows[0].assigned_at as Date).getTime() - Date.now())).toBeLessThan(60_000);
    });

    it('refuses an invalid party type', async () => {
      await expect(insertRaw(uuidv7(), { seller_party_type: 'salon' })).rejects.toThrow(/ck_scpa_party_type/);
    });

    it('refuses a policy key that names nothing', async () => {
      await expect(insertRaw(uuidv7(), { policy_key: 'no-such-policy' })).rejects.toThrow();
    });

    it('refuses two current rows for one party', async () => {
      const partyId = uuidv7();
      await insertRaw(partyId);
      await expect(insertRaw(partyId)).rejects.toThrow(/uq_scpa_one_current_per_party/);
    });

    it('refuses every partial supersession', async () => {
      const id = await insertRaw(uuidv7());
      for (const partial of [
        `superseded_at = now()`,
        `superseded_at = now(), superseded_by_user_id = '${admin.id}'`,
        `superseded_by_user_id = '${admin.id}'`,
        `superseded_by_assignment_id = '${uuidv7()}'`,
      ]) {
        await expect(dataSource.query(`UPDATE ${ASSIGNMENTS} SET ${partial} WHERE id = $1`, [id])).rejects.toThrow();
      }
    });

    it('refuses mutation of every frozen field', async () => {
      const id = await insertRaw(uuidv7());
      const otherKey = await publishedPolicy();
      for (const change of [
        `seller_party_id = '${uuidv7()}'`,
        `seller_party_type = 'business'`,
        `policy_key = '${otherKey}'`,
        `assigned_by_user_id = '${uuidv7()}'`,
        `assigned_at = now() - interval '1 day'`,
        `id = '${uuidv7()}'`,
      ]) {
        await expect(dataSource.query(`UPDATE ${ASSIGNMENTS} SET ${change} WHERE id = $1`, [id])).rejects.toThrow(
          /immutable/,
        );
      }
    });

    it('refuses a self-superseding row', async () => {
      const id = await insertRaw(uuidv7());
      await expect(
        dataSource.query(
          `UPDATE ${ASSIGNMENTS}
              SET superseded_at = now(), superseded_by_user_id = $1, superseded_by_assignment_id = $2
            WHERE id = $2`,
          [admin.id, id],
        ),
      ).rejects.toThrow(/ck_scpa_not_self_superseding/);
    });

    it('refuses a supplied supersession instant, taking the clock from the database', async () => {
      const id = await insertRaw(uuidv7());
      await expect(
        dataSource.query(
          `UPDATE ${ASSIGNMENTS}
              SET superseded_at = now() - interval '2 days',
                  superseded_by_user_id = $1,
                  superseded_by_assignment_id = $2
            WHERE id = $3`,
          [admin.id, uuidv7(), id],
        ),
      ).rejects.toThrow();
    });

    it('refuses a second terminal transition, and refuses DELETE outright', async () => {
      const partyId = uuidv7();
      const first = await insertRaw(partyId);
      const successor = uuidv7();

      // A real supersession, written the only way the deferred self-reference
      // permits: compare-and-swap the predecessor naming an id that does not
      // exist yet, then insert the successor. Both statements in ONE
      // transaction, because the reference is checked at COMMIT.
      await dataSource.transaction(async (manager) => {
        await manager.query(
          `UPDATE ${ASSIGNMENTS}
              SET superseded_at = now(), superseded_by_user_id = $1, superseded_by_assignment_id = $2
            WHERE id = $3 AND superseded_at IS NULL`,
          [admin.id, successor, first],
        );
        await manager.query(
          `INSERT INTO ${ASSIGNMENTS} (id, seller_party_type, seller_party_id, policy_key, assigned_by_user_id)
             SELECT $1, seller_party_type, seller_party_id, policy_key, $2 FROM ${ASSIGNMENTS} WHERE id = $3`,
          [successor, admin.id, first],
        );
      });

      expect((await rowsFor(partyId)).filter((row) => row.superseded_at === null)).toHaveLength(1);

      await expect(
        dataSource.query(
          `UPDATE ${ASSIGNMENTS} SET superseded_at = now(), superseded_by_user_id = $1,
             superseded_by_assignment_id = $2 WHERE id = $3`,
          [admin.id, uuidv7(), first],
        ),
      ).rejects.toThrow(/already superseded/);

      for (const id of [first, successor]) {
        await expect(dataSource.query(`DELETE FROM ${ASSIGNMENTS} WHERE id = $1`, [id])).rejects.toThrow(
          /are permanent/,
        );
      }
      await expect(dataSource.query(`DELETE FROM ${ASSIGNMENTS}`)).rejects.toThrow(/are permanent/);
    });

    it('leaves a supersession unwritable unless the successor really arrives', async () => {
      // The deferred reference is not a loophole: naming a successor that never
      // shows up fails at COMMIT, so a half-written supersession cannot survive.
      const id = await insertRaw(uuidv7());
      await expect(
        dataSource.transaction(async (manager) => {
          await manager.query(
            `UPDATE ${ASSIGNMENTS}
                SET superseded_at = now(), superseded_by_user_id = $1, superseded_by_assignment_id = $2
              WHERE id = $3`,
            [admin.id, uuidv7(), id],
          );
        }),
      ).rejects.toThrow();

      const [row] = await dataSource.query(`SELECT superseded_at FROM ${ASSIGNMENTS} WHERE id = $1`, [id]);
      expect(row.superseded_at).toBeNull();
    });
  });

  // =========================================================================
  // §3. Assignment, supersession, replay and audit
  // =========================================================================

  describe('§3 assignment lifecycle', () => {
    it('assigns, then supersedes, keeping all history and exactly one current row', async () => {
      const owner = await professionalOwner();
      const first = await publishedPolicy();
      const second = await publishedPolicy();

      const created = await assignments.assign(owner.user.id, {
        workspaceRef: owner.workspaceRef,
        policyKey: first,
        reason: 'first choice',
      });
      expect(created.assignment?.policyKey).toBe(first);

      const replaced = await assignments.assign(owner.user.id, {
        workspaceRef: owner.workspaceRef,
        policyKey: second,
        reason: 'changed my mind',
      });
      expect(replaced.assignment?.policyKey).toBe(second);

      const rows = await rowsFor(owner.partyId);
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.superseded_at === null)).toHaveLength(1);
      expect(rows[0].policy_key).toBe(first);
      expect(rows[1].policy_key).toBe(second);
      // The predecessor names its successor, and history is intact rather than
      // rewritten: nothing was deleted to make room.
      expect(rows[0].superseded_by_assignment_id).toBe(rows[1].id);
      expect(rows[0].superseded_by_user_id).toBe(owner.user.id);
    });

    it('treats an already-current key as a successful replay: no row, no audit', async () => {
      const owner = await professionalOwner();
      const key = await publishedPolicy();

      await assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: key, reason: 'first' });
      const auditBefore = await auditTotal();

      const replay = await assignments.assign(owner.user.id, {
        workspaceRef: owner.workspaceRef,
        policyKey: key,
        reason: 'retry of the same command',
      });

      expect(replay.assignment?.policyKey).toBe(key);
      expect(await rowsFor(owner.partyId)).toHaveLength(1);
      expect(await auditTotal()).toBe(auditBefore);
    });

    it('replays successfully even after the key has stopped being assignable', async () => {
      // A retry that arrives late is still a retry. Re-requiring assignability
      // first would rewrite an owner's history because a retirement happened in
      // between — the opposite of idempotent.
      const owner = await professionalOwner();
      const key = await publishedPolicy();
      await assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: key, reason: 'first' });

      const versions = await policies.listVersions(key);
      await policies.retireVersion(admin.id, key, versions[0].version, 'retired after assignment');

      const replay = await assignments.assign(owner.user.id, {
        workspaceRef: owner.workspaceRef,
        policyKey: key,
        reason: 'late retry',
      });
      expect(replay.assignment?.policyKey).toBe(key);
      expect(await rowsFor(owner.partyId)).toHaveLength(1);
    });

    it('writes exactly one audit row per real mutation, and none for a read', async () => {
      const owner = await professionalOwner();
      const first = await publishedPolicy();
      const second = await publishedPolicy();

      await assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: first, reason: 'one' });
      await assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: second, reason: 'two' });

      const rows = await assignmentAuditFor(owner.partyId);
      expect(rows.map((row) => row.action)).toEqual([
        'commercial.collection_policy_assigned',
        'commercial.collection_policy_assignment_superseded',
      ]);
      expect(rows.map((row) => row.reason)).toEqual(['one', 'two']);

      const before = await auditTotal();
      await assignments.currentAssignment(owner.user.id, owner.workspaceRef);
      await assignments.assignablePolicies();
      await readAssignment(owner.user, owner.workspaceRef).expect(200);
      await listPolicies(owner.user).expect(200);
      expect(await auditTotal()).toBe(before);
    });

    it('refuses an assignment whose reason is missing, blank or over-long, writing nothing', async () => {
      const owner = await professionalOwner();
      const key = await publishedPolicy();
      for (const reason of ['', '  ', 'ab', 'x'.repeat(501)]) {
        await expect(
          assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: key, reason }),
        ).rejects.toBeInstanceOf(CollectionPolicyAssignmentUnavailableException);
      }
      expect(await rowsFor(owner.partyId)).toHaveLength(0);
    });

    it('rolls the assignment back when the audit write throws after inserting its row', async () => {
      /*
       * The one ordering that distinguishes a shared `EntityManager` from a
       * separate connection.
       *
       * Sharing the caller's manager puts the audit INSERT inside the domain
       * transaction, so a throw AFTER it rolls both back. An audit service on
       * its own connection would have committed its row already, and the count
       * below would be one higher. A probe that threw BEFORE the audit write
       * would pass either way and prove nothing — which is the defect this
       * shape exists to avoid.
       */
      const owner = await professionalOwner();
      const key = await publishedPolicy();
      const audit = app.get(AdminAuditService);
      const original = audit.record.bind(audit);
      const before = await auditTotal();

      (audit as unknown as { record: unknown }).record = async (...args: Parameters<typeof original>) => {
        await original(...args);
        throw new Error('probe: audit row written, then the mutation fails');
      };

      try {
        await expect(
          assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: key, reason: 'atomicity' }),
        ).rejects.toThrow(/probe/);
      } finally {
        (audit as unknown as { record: unknown }).record = original;
      }

      expect(await rowsFor(owner.partyId)).toHaveLength(0);
      expect(await auditTotal()).toBe(before);
    });

    it('the atomicity case is not vacuous: the same write lands on success', async () => {
      const owner = await professionalOwner();
      const key = await publishedPolicy();
      const before = await auditTotal();
      await assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: key, reason: 'control' });
      expect(await auditTotal()).toBe(before + 1);
      expect(await rowsFor(owner.partyId)).toHaveLength(1);
    });
  });

  // =========================================================================
  // §4. Concurrency — the index and the compare-and-swap decide, not the read
  // =========================================================================

  describe('§4 concurrency', () => {
    /**
     * Two statements on two REAL connections, with the interleaving decided by
     * the test rather than by the scheduler.
     *
     * `Promise.allSettled` over two service calls does not reliably produce a
     * race: the first transaction usually commits before the second one opens,
     * and the case then passes while proving only that two sequential requests
     * work. These helpers hold transaction A open across B's statement, so the
     * conflict is guaranteed and the mechanism that resolves it — the partial
     * unique index, or the compare-and-swap predicate — is the only thing that
     * can decide the outcome.
     */
    interface Session {
      query: (sql: string, params?: unknown[]) => Promise<unknown>;
      commit: () => Promise<void>;
      rollback: () => Promise<void>;
    }

    async function withTwoConnections<T>(body: (a: Session, b: Session) => Promise<T>): Promise<T> {
      const runners = [dataSource.createQueryRunner(), dataSource.createQueryRunner()];
      for (const runner of runners) {
        await runner.connect();
        await runner.startTransaction();
      }
      const session = (index: number): Session => ({
        query: (sql, params) => runners[index].query(sql, params as never[]),
        commit: () => runners[index].commitTransaction(),
        rollback: () => runners[index].rollbackTransaction(),
      });
      try {
        return await body(session(0), session(1));
      } finally {
        for (const runner of runners) {
          if (runner.isTransactionActive) await runner.rollbackTransaction();
          await runner.release();
        }
      }
    }

    const insertCurrent = `INSERT INTO ${ASSIGNMENTS}
        (id, seller_party_type, seller_party_id, policy_key, assigned_by_user_id)
      VALUES ($1, 'professional', $2, $3, $4)`;

    it('lets the partial unique index decide two genuinely concurrent first assignments', async () => {
      const partyId = uuidv7();
      const a = await publishedPolicy();
      const b = await publishedPolicy();

      await withTwoConnections(async (holder, contender) => {
        // The contender writes and COMMITS first; the holder's transaction is
        // still open and has not written yet.
        await contender.query(insertCurrent, [uuidv7(), partyId, b, admin.id]);
        await contender.commit();

        // Now the holder tries. At READ COMMITTED it sees the committed row and
        // the index refuses — no application check was consulted, and none
        // could have been: a check-then-insert would have read "no current row"
        // before the contender committed.
        await expect(holder.query(insertCurrent, [uuidv7(), partyId, a, admin.id])).rejects.toThrow(
          /uq_scpa_one_current_per_party/,
        );
      });

      const rows = await rowsFor(partyId);
      expect(rows).toHaveLength(1);
      expect(rows[0].policy_key).toBe(b);
    });

    it('blocks a second concurrent insert until the first transaction resolves', async () => {
      const partyId = uuidv7();
      const a = await publishedPolicy();
      const b = await publishedPolicy();

      await withTwoConnections(async (holder, contender) => {
        await holder.query(insertCurrent, [uuidv7(), partyId, a, admin.id]);

        // The contender BLOCKS on the uncommitted index entry rather than
        // inserting a second current row. Proved by racing it against a timer:
        // a promise that has not settled cannot have inserted anything.
        const contending = contender.query(insertCurrent, [uuidv7(), partyId, b, admin.id]);
        // `catch` attached now, not later: an unhandled rejection between the
        // race below and the await further down would fail the process rather
        // than this assertion.
        const outcome = contending.then(
          () => 'inserted',
          (error: Error) => error,
        );
        const settled = await Promise.race([
          outcome.then(() => 'settled'),
          new Promise((resolve) => setTimeout(() => resolve('blocked'), 750)),
        ]);

        // Committing the holder BEFORE asserting, so a failure here cannot
        // leave the contender's statement waiting on a transaction that the
        // cleanup then tries to roll back on the same connection.
        await holder.commit();
        const result = await outcome;

        expect(settled).toBe('blocked');
        // It was waiting, and what it was waiting for was a refusal: the row it
        // blocked on is now committed and the partial unique index rejects it.
        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toMatch(/uq_scpa_one_current_per_party/);
      });

      const rows = await rowsFor(partyId);
      expect(rows).toHaveLength(1);
      expect(rows[0].policy_key).toBe(a);
    });

    it('lets the compare-and-swap predicate decide two concurrent supersessions', async () => {
      const owner = await professionalOwner();
      const first = await publishedPolicy();
      const second = await publishedPolicy();
      await assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: first, reason: 'first' });
      const [current] = await rowsFor(owner.partyId);

      const cas = `UPDATE ${ASSIGNMENTS}
                      SET superseded_at = now(), superseded_by_user_id = $1, superseded_by_assignment_id = $2
                    WHERE id = $3 AND superseded_at IS NULL
                RETURNING id`;

      /*
       * TypeORM hands back `[rows, affected]` for a raw UPDATE, so the result
       * is length 2 whether one row changed or none did.
       *
       * That is not a test detail — it is the exact trap the service's own
       * compare-and-swap reading guards against: `result.length` is always 2
       * and would accept a lost race silently. Unwrapping here means this case
       * measures the affected rows rather than the driver's envelope.
       */
      const changedRows = (result: unknown): unknown[] => {
        const shape = result as unknown[];
        return Array.isArray(shape[0]) ? (shape[0] as unknown[]) : shape;
      };

      await withTwoConnections(async (holder, contender) => {
        const successorId = uuidv7();
        const won = changedRows(await contender.query(cas, [owner.user.id, successorId, current.id]));
        expect(won).toHaveLength(1);

        // The successor has to actually arrive: the deferred reference is
        // checked at COMMIT, so a winner that superseded without inserting
        // anything could not commit at all.
        await contender.query(
          `INSERT INTO ${ASSIGNMENTS} (id, seller_party_type, seller_party_id, policy_key, assigned_by_user_id)
             VALUES ($1, 'professional', $2, $3, $4)`,
          [successorId, owner.partyId, second, owner.user.id],
        );
        await contender.commit();

        // The loser's predicate no longer matches: `superseded_at IS NULL` is
        // false on the committed row, so it changes ZERO rows rather than
        // overwriting the winner's supersession with its own.
        const lost = changedRows(await holder.query(cas, [owner.user.id, uuidv7(), current.id]));
        expect(lost).toHaveLength(0);
      });

      const rows = await rowsFor(owner.partyId);
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.superseded_at === null)).toHaveLength(1);
      expect(rows[0].superseded_by_assignment_id).toBe(rows[1].id);
    });

    it('keeps one current row however two service-level assignments interleave', async () => {
      const owner = await professionalOwner();
      const a = await publishedPolicy();
      const b = await publishedPolicy();

      const results = await Promise.allSettled([
        assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: a, reason: 'race a' }),
        assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: b, reason: 'race b' }),
      ]);

      /*
       * The scheduler decides whether these overlap, so the assertion is on the
       * INVARIANT rather than on which call lost — a test demanding exactly one
       * rejection would be asserting a timing and would flake on a fast host.
       *
       * What must hold either way: one current row, no orphan, an audit row per
       * real mutation and no more, and a rejection that is the readable refusal
       * rather than a raw driver error.
       */
      const fulfilled = results.filter((result) => result.status === 'fulfilled').length;
      expect(fulfilled).toBeGreaterThanOrEqual(1);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(CollectionPolicyAssignmentUnavailableException);
        }
      }

      const rows = await rowsFor(owner.partyId);
      expect(rows.filter((row) => row.superseded_at === null)).toHaveLength(1);
      expect(rows).toHaveLength(fulfilled);
      expect(await assignmentAuditFor(owner.partyId)).toHaveLength(fulfilled);
    });

    it('converges on one current row when the SAME key races itself', async () => {
      const owner = await professionalOwner();
      const key = await publishedPolicy();

      const results = await Promise.allSettled([
        assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: key, reason: 'same a' }),
        assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: key, reason: 'same b' }),
      ]);
      expect(results.some((result) => result.status === 'fulfilled')).toBe(true);

      // Whichever way they interleaved, a double-click produced ONE row and ONE
      // commercial commitment: either the second call replayed the first, or it
      // lost the index race and was refused.
      expect(await rowsFor(owner.partyId)).toHaveLength(1);
      expect(await assignmentAuditFor(owner.partyId)).toHaveLength(1);
    });

    it('WAITS on the selected version row, which is the retirement-race boundary', async () => {
      /*
       * The `FOR SHARE` lock, observed directly rather than raced for.
       *
       * An earlier version of this case ran `assign` and `retireVersion`
       * through `Promise.allSettled` and accepted either order. That proved
       * almost nothing — a mutation probe that DELETED the lock left it green,
       * and it failed intermittently on its own timing. Both faults have the
       * same cause: "whichever commits first" is not a mechanism, which is the
       * exact sentence ADR-048 R5 opens with.
       *
       * `FOR UPDATE` conflicts with `FOR SHARE`, so holding one on the version
       * row from another connection makes the assignment BLOCK at precisely the
       * statement under test. Remove the lock and the assignment sails past,
       * which is what makes this case probe-sensitive.
       */
      const owner = await professionalOwner();
      const key = await publishedPolicy();
      const [version] = await dataSource.query(
        `SELECT id FROM commercial.booking_collection_policy_versions
          WHERE policy_key = $1 AND lifecycle_state = 'published'`,
        [key],
      );

      const blocker = dataSource.createQueryRunner();
      await blocker.connect();
      await blocker.startTransaction();
      let assigning: Promise<unknown>;
      let settledEarly: string;
      try {
        await blocker.query(
          `SELECT id FROM commercial.booking_collection_policy_versions WHERE id = $1 FOR UPDATE`,
          [version.id],
        );

        assigning = assignments.assign(owner.user.id, {
          workspaceRef: owner.workspaceRef,
          policyKey: key,
          reason: 'waits for the version',
        });
        const outcome = assigning.then(
          () => 'assigned',
          (error: Error) => error,
        );

        settledEarly = (await Promise.race([
          outcome.then(() => 'settled'),
          new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 1_000)),
        ])) as string;

        // Nothing was written while it waited — it is blocked BEFORE the insert,
        // which is what makes the lock a boundary rather than a formality.
        expect(await rowsFor(owner.partyId)).toHaveLength(0);
      } finally {
        await blocker.rollbackTransaction();
        await blocker.release();
      }

      await assigning!;
      expect(settledEarly!).toBe('blocked');

      // Released, it completes normally: the wait was the lock, not a failure.
      expect((await rowsFor(owner.partyId)).filter((row) => row.superseded_at === null)).toHaveLength(1);
      expect(await assignmentAuditFor(owner.partyId)).toHaveLength(1);
    });

    it('refuses an assignment once the version is already retired, writing nothing', async () => {
      // The other half of the boundary, stated as an ordering rather than a
      // race: whatever the lock serialises, a retirement that has COMMITTED
      // must make the key unassignable.
      const owner = await professionalOwner();
      const key = await publishedPolicy();
      const versions = await policies.listVersions(key);
      await policies.retireVersion(admin.id, key, versions[0].version, 'retired first');

      await expect(
        assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: key, reason: 'too late' }),
      ).rejects.toBeInstanceOf(CollectionPolicyAssignmentUnavailableException);

      expect(await rowsFor(owner.partyId)).toHaveLength(0);
      expect(await auditWithReason('too late')).toHaveLength(0);
      expect((await assignments.assignablePolicies()).map((policy) => policy.policyKey)).not.toContain(key);
    });
  });

  // =========================================================================
  // §5. Ownership, isolation and authorization
  // =========================================================================

  describe('§5 ownership and authorization', () => {
    it('isolates a professional owner from a business owner', async () => {
      const professional = await professionalOwner();
      const business = await businessOwner();
      const key = await publishedPolicy();

      await assignments.assign(professional.user.id, {
        workspaceRef: professional.workspaceRef,
        policyKey: key,
        reason: 'professional only',
      });

      expect(await rowsFor(professional.partyId)).toHaveLength(1);
      expect(await rowsFor(business.partyId)).toHaveLength(0);
      expect((await assignments.currentAssignment(business.user.id, business.workspaceRef)).assignment).toBeNull();
    });

    it('gives a dual owner two isolated workspaces', async () => {
      const user = await seedUser(app, dataSource, nextPhone(), ['professional', 'business']);
      const professional = await seedProfessional(dataSource, user.id, 'متخصص دوگانه');
      const business = await seedBusiness(dataSource, user.id, 'کسب‌وکار دوگانه');
      const key = await publishedPolicy();

      const refs = await workspaceRefsFor(user);
      expect(refs).toHaveLength(2);

      // Assigning one side leaves the other unenrolled: a reference is never
      // chosen FOR the caller, and `parties[0]` is nobody's default.
      await assignments.assign(user.id, { workspaceRef: refs[0], policyKey: key, reason: 'one side only' });
      const counts = [(await rowsFor(professional.id)).length, (await rowsFor(business.id)).length];
      expect(counts.slice().sort()).toEqual([0, 1]);

      const views = await Promise.all(refs.map((ref) => assignments.currentAssignment(user.id, ref)));
      expect(views.filter((view) => view.assignment === null)).toHaveLength(1);
    });

    it('refuses an affiliated staff professional — a MANAGER — holding the capability', async () => {
      const business = await businessOwner();
      const staff = await seedUser(app, dataSource, nextPhone(), ['professional']);
      const staffProfessional = await seedProfessional(dataSource, staff.id, 'کارمند');
      await dataSource.query(
        `INSERT INTO business.business_staff (id, business_id, user_id, professional_id, role, status, invited_by)
         VALUES ($1, $2, $3, $4, 'manager', 'active', $5)`,
        [uuidv7(), business.partyId, staff.id, staffProfessional.id, business.user.id],
      );

      const key = await publishedPolicy();

      // The employer's own reference is inert in the staff member's hands: the
      // resolver enumerates what THEY own, and affiliation is not ownership.
      await expect(
        assignments.assign(staff.id, { workspaceRef: business.workspaceRef, policyKey: key, reason: 'staff attempt' }),
      ).rejects.toBeInstanceOf(CollectionPolicyAssignmentUnavailableException);
      await expect(assignments.currentAssignment(staff.id, business.workspaceRef)).rejects.toBeInstanceOf(
        CollectionPolicyAssignmentUnavailableException,
      );
      expect(await rowsFor(business.partyId)).toHaveLength(0);

      // The positive control: the OWNER reaches the same workspace, so the
      // refusal above is about affiliation and not about a broken fixture.
      await assignments.assign(business.user.id, {
        workspaceRef: business.workspaceRef,
        policyKey: key,
        reason: 'owner',
      });
      expect(await rowsFor(business.partyId)).toHaveLength(1);
    });

    it('requires authentication on all three routes', async () => {
      const owner = await professionalOwner();
      const key = await publishedPolicy();
      const server = app.getHttpServer();

      await request(server).get('/api/v1/me/collection-policies').expect(401);
      await request(server).get(`/api/v1/me/collection-policy-assignments/${owner.workspaceRef}`).expect(401);
      await request(server)
        .put(`/api/v1/me/collection-policy-assignments/${owner.workspaceRef}`)
        .send({ policyKey: key, reason: 'unauthenticated' })
        .expect(401);

      // The 404 control. Without it every 401 above would also be produced by a
      // route that simply does not exist.
      await request(server)
        .get('/api/v1/me/collection-policies-that-do-not-exist')
        .set('Authorization', authed(owner.user))
        .expect(404);
    });

    it('gates the mutation on the capability and leaves the catalogue open to any session', async () => {
      const owner = await professionalOwner();
      const key = await publishedPolicy();
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);

      await putAssignment(customer, owner.workspaceRef, { policyKey: key, reason: 'no capability' }).expect(403);
      // Browsing is deliberately NOT capability-gated: hiding the catalogue
      // from a seller who has not yet chosen would hide it from exactly the
      // seller it exists for.
      await listPolicies(customer).expect(200);

      expect(await rowsFor(owner.partyId)).toHaveLength(0);
      // The positive control: the same body from the OWNER succeeds.
      await putAssignment(owner.user, owner.workspaceRef, { policyKey: key, reason: 'the owner' }).expect(200);
      expect(await rowsFor(owner.partyId)).toHaveLength(1);
    });
  });

  // =========================================================================
  // §6. One refusal, byte for byte
  // =========================================================================

  describe('§6 the single refusal', () => {
    it('answers every workspace and every policy failure with the identical body', async () => {
      const owner = await professionalOwner();
      const stranger = await professionalOwner();
      const live = await publishedPolicy();
      const draft = await draftOnlyPolicy();
      const retired = await retiredPolicy();

      const attempts: Array<[string, string]> = [
        // Workspace-side failures, on a perfectly good key.
        ['not-a-reference', live],
        ['A'.repeat(42), live],
        [uuidv7(), live],
        [stranger.workspaceRef, live],
        // Policy-side failures, on a perfectly good workspace.
        [owner.workspaceRef, 'no-such-policy-key'],
        [owner.workspaceRef, draft],
        [owner.workspaceRef, retired],
      ];

      const responses = [];
      for (const [ref, policyKey] of attempts) {
        responses.push(await putAssignment(owner.user, encodeURIComponent(ref), { policyKey, reason: 'probing' }));
      }

      const [first, ...rest] = responses;
      expect(first.status).toBe(409);
      for (const response of rest) {
        expect(response.status).toBe(first.status);
        // BYTE-identical, not merely the same status. A different message, a
        // different details array or a different key order is a distinguishable
        // response, and distinguishable is all an enumeration oracle needs.
        expect(JSON.stringify(response.body)).toBe(JSON.stringify(first.body));
      }

      expect(first.body).toEqual({
        data: null,
        meta: null,
        error: { code: 'collection_policy_assignment_unavailable', message: expect.any(String) },
      });
      // The body names no cause, key, reference, party or identity.
      const serialized = JSON.stringify(first.body);
      for (const forbidden of [draft, retired, owner.workspaceRef, owner.partyId, owner.user.id, 'no-such-policy-key']) {
        expect(serialized).not.toContain(forbidden);
      }

      // The positive control. Without it every assertion above would pass
      // against a surface that refused EVERYTHING, including a valid request.
      await putAssignment(owner.user, owner.workspaceRef, { policyKey: live, reason: 'the valid one' }).expect(200);
    });

    it('answers a READ of a foreign or malformed reference the same way', async () => {
      const owner = await professionalOwner();
      const stranger = await professionalOwner();

      const bodies: string[] = [];
      for (const ref of ['not-a-reference', uuidv7(), stranger.workspaceRef]) {
        const response = await readAssignment(owner.user, encodeURIComponent(ref)).expect(409);
        bodies.push(JSON.stringify(response.body));
      }
      expect(new Set(bodies).size).toBe(1);

      // The control: the caller's OWN reference reads successfully.
      await readAssignment(owner.user, owner.workspaceRef).expect(200);
    });

    it('writes nothing when it refuses', async () => {
      const owner = await professionalOwner();
      const reason = `refusal probe ${uuidv7()}`;
      await putAssignment(owner.user, owner.workspaceRef, {
        policyKey: 'no-such-policy-key',
        reason,
      }).expect(409);
      expect(await rowsFor(owner.partyId)).toHaveLength(0);
      // Searched by REASON, not by a join on the assignment: an audit row
      // describing an assignment that was rolled back would be invisible to a
      // join and is exactly what this case exists to catch.
      expect(await auditWithReason(reason)).toHaveLength(0);
    });
  });

  // =========================================================================
  // §7. The request surface
  // =========================================================================

  describe('§7 request surface', () => {
    it('rejects every forged field rather than silently ignoring it', async () => {
      const owner = await professionalOwner();
      const key = await publishedPolicy();

      for (const forged of [
        { policyKey: key, reason: 'forged', sellerPartyId: uuidv7() },
        { policyKey: key, reason: 'forged', sellerPartyType: 'business' },
        { policyKey: key, reason: 'forged', policyVersion: 1 },
        { policyKey: key, reason: 'forged', collectionMode: 'pay_at_venue' },
        { policyKey: key, reason: 'forged', assignedByUserId: owner.user.id },
        { policyKey: key, reason: 'forged', assignedAt: new Date().toISOString() },
        { policyKey: key, reason: 'forged', supersededAt: null },
        { policyKey: key, reason: 'forged', platformCollectibleToman: 1 },
        { policyKey: key, reason: 'forged', policyAcceptedAt: new Date().toISOString() },
      ]) {
        await putAssignment(owner.user, owner.workspaceRef, forged).expect(400);
      }
      expect(await rowsFor(owner.partyId)).toHaveLength(0);

      // The control: the same request WITHOUT the extra field succeeds, so the
      // 400s above come from the whitelist and not from a broken body.
      await putAssignment(owner.user, owner.workspaceRef, { policyKey: key, reason: 'clean' }).expect(200);
    });

    it('rejects a missing, blank, mistyped or over-long field at the pipe', async () => {
      const owner = await professionalOwner();
      const key = await publishedPolicy();
      for (const body of [
        {},
        { policyKey: key },
        { reason: 'no key' },
        { policyKey: key, reason: '' },
        { policyKey: key, reason: 'x'.repeat(501) },
        { policyKey: '9-starts-with-a-digit', reason: 'bad key' },
        { policyKey: 'a'.repeat(65), reason: 'too long a key' },
        { policyKey: 42, reason: 'not a string' },
        { policyKey: key, reason: 42 },
      ]) {
        await putAssignment(owner.user, owner.workspaceRef, body as Record<string, unknown>).expect(400);
      }
      expect(await rowsFor(owner.partyId)).toHaveLength(0);
    });

    it('rejects an unknown query property on every route', async () => {
      const owner = await professionalOwner();
      const key = await publishedPolicy();
      const server = app.getHttpServer();
      const auth = authed(owner.user);

      await request(server).get('/api/v1/me/collection-policies?all=true').set('Authorization', auth).expect(400);
      await request(server)
        .get(`/api/v1/me/collection-policy-assignments/${owner.workspaceRef}?history=1`)
        .set('Authorization', auth)
        .expect(400);
      await request(server)
        .put(`/api/v1/me/collection-policy-assignments/${owner.workspaceRef}?force=1`)
        .set('Authorization', auth)
        .send({ policyKey: key, reason: 'query forgery' })
        .expect(400);
    });
  });

  // =========================================================================
  // §8. Projections and query counts
  // =========================================================================

  describe('§8 projections and query counts', () => {
    it('lists only currently assignable keys, in a deterministic order, with exactly two fields', async () => {
      const owner = await professionalOwner();
      const live = await publishedPolicy(nextKey('aaa'));
      const alsoLive = await publishedPolicy(nextKey('bbb'));
      const draft = await draftOnlyPolicy();
      const retired = await retiredPolicy();

      const response = await listPolicies(owner.user).expect(200);
      const items = response.body.data.items as Array<Record<string, unknown>>;
      const keys = items.map((item) => item.policyKey as string);

      expect(keys).toEqual(expect.arrayContaining([live, alsoLive]));
      expect(keys).not.toContain(draft);
      expect(keys).not.toContain(retired);
      expect(keys).toEqual([...keys].sort());
      for (const item of items) expect(Object.keys(item).sort()).toEqual(['displayName', 'policyKey']);

      // An unpublished or retired key is simply absent, so its absence
      // discloses nothing about what the administrator plane holds.
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toMatch(/"version"|lifecycle|activation|deposit|collectionMode|basisPoints|ByUserId/i);
    });

    it('costs the SAME number of statements for one policy and for six', async () => {
      /*
       * The N+1 control, and deliberately not "assert the count is 1".
       *
       * A magic number fails when an unrelated statement is added and passes
       * when the catalogue is small — it tests the constant rather than the
       * growth. Comparing one against six tests the growth directly: an
       * implementation that read the active version per key would show five
       * extra statements here and none at all with a single policy.
       */
      const counter = new CountingLogger();
      const originalLogger = dataSource.logger;
      let withOne = 0;
      let withSix = 0;

      await publishedPolicy();
      try {
        dataSource.logger = counter;

        // The discovery half: the counter really counts. Without it both
        // measurements would agree at zero and prove nothing.
        counter.reset();
        await dataSource.query('SELECT 1');
        expect(counter.count).toBe(1);

        counter.reset();
        await assignments.assignablePolicies();
        withOne = counter.count;
      } finally {
        dataSource.logger = originalLogger;
      }

      for (let i = 0; i < 5; i += 1) await publishedPolicy();

      try {
        dataSource.logger = counter;
        counter.reset();
        await assignments.assignablePolicies();
        withSix = counter.count;
      } finally {
        dataSource.logger = originalLogger;
      }

      expect(withOne).toBe(1);
      expect(withSix).toBe(withOne);
      expect((await assignments.assignablePolicies()).length).toBeGreaterThanOrEqual(6);
    });

    it('returns assignment: null for an owned unenrolled workspace, writing nothing', async () => {
      const owner = await professionalOwner();
      const before = await auditTotal();

      const response = await readAssignment(owner.user, owner.workspaceRef).expect(200);
      expect(response.body.data).toEqual({ assignment: null });

      expect(await rowsFor(owner.partyId)).toHaveLength(0);
      expect(await auditTotal()).toBe(before);
    });

    it('exposes only the minimum current-assignment projection', async () => {
      const owner = await professionalOwner();
      const key = await publishedPolicy();
      await assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: key, reason: 'chosen' });

      const response = await readAssignment(owner.user, owner.workspaceRef).expect(200);
      expect(Object.keys(response.body.data.assignment).sort()).toEqual(['assignedAt', 'displayName', 'policyKey']);

      const serialized = JSON.stringify(response.body);
      // No actor, no party, no row id, no supersession internal, no reason.
      for (const forbidden of [owner.user.id, owner.partyId, 'chosen']) {
        expect(serialized).not.toContain(forbidden);
      }
      expect(serialized).not.toMatch(/superseded|assignedBy|"id"|"version"/i);
    });

    it('costs the same number of statements to read an enrolled and an unenrolled workspace', async () => {
      const owner = await professionalOwner();
      const key = await publishedPolicy();

      const unenrolled = await countStatements(() =>
        assignments.currentAssignment(owner.user.id, owner.workspaceRef),
      );
      await assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: key, reason: 'read' });
      const enrolled = await countStatements(() => assignments.currentAssignment(owner.user.id, owner.workspaceRef));

      // The display name is joined, not fetched afterwards, so having an
      // assignment costs nothing extra beyond the transaction it already opens.
      expect(enrolled).toBe(unenrolled);
    });

    it('costs the same number of statements to assign whatever the catalogue size', async () => {
      const small = await professionalOwner();
      const key = await publishedPolicy();
      const withOne = await countStatements(() =>
        assignments.assign(small.user.id, { workspaceRef: small.workspaceRef, policyKey: key, reason: 'small' }),
      );

      for (let i = 0; i < 5; i += 1) await publishedPolicy();
      const large = await professionalOwner();
      const withSix = await countStatements(() =>
        assignments.assign(large.user.id, { workspaceRef: large.workspaceRef, policyKey: key, reason: 'large' }),
      );

      // The mutation resolves ONE key. A catalogue five times larger must not
      // cost a single extra statement.
      expect(withSix).toBe(withOne);
    });

    it('reads the assignment instant back exactly as the database wrote it', async () => {
      const owner = await professionalOwner();
      const key = await publishedPolicy();
      await assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: key, reason: 'clock' });

      const response = await readAssignment(owner.user, owner.workspaceRef).expect(200);
      const [row] = await rowsFor(owner.partyId);
      expect(response.body.data.assignment.assignedAt).toBe((row.assigned_at as Date).toISOString());
    });
  });

  // =========================================================================
  // §9. Privacy — ADR-027
  // =========================================================================

  describe('§9 privacy', () => {
    it('claims the table, and the exact-set coverage check sees it', async () => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const claimed = contracts.flatMap((contract) => contract.tables.map((table) => table.table));
      expect(claimed).toContain('commercial.seller_collection_policy_assignments');

      const rows = await dataSource.query(
        `SELECT t.schemaname AS schema, t.tablename AS name,
                array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
           FROM pg_tables t
           JOIN information_schema.columns c
             ON c.table_schema = t.schemaname AND c.table_name = t.tablename
          WHERE t.schemaname = 'commercial'
          GROUP BY t.schemaname, t.tablename`,
      );
      const report = evaluateCoverage(rows, contracts);
      expect(report.violations.filter((violation) => violation.table.startsWith('commercial.'))).toEqual([]);
    });

    it('claims it RETAINED, matching the actor columns it really carries', async () => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const claim = contracts
        .flatMap((contract) => contract.tables)
        .find((table) => table.table === 'commercial.seller_collection_policy_assignments');

      expect(claim?.disposition).toBe('retained');
      expect((claim?.reason ?? '').length).toBeGreaterThan(40);

      // The claim is truthful: the table really does carry subject columns, so
      // a `no_subject_data` claim on it would fail the boot check rather than
      // merely being wrong.
      const columns: string[] = (
        await dataSource.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema='commercial' AND table_name='seller_collection_policy_assignments'
              AND column_name LIKE '%_user_id' ORDER BY column_name`,
        )
      ).map((row: { column_name: string }) => row.column_name);
      expect(columns).toEqual(['assigned_by_user_id', 'superseded_by_user_id']);
    });

    it('reports erasure truthfully, exports nothing, and leaves the commercial fact standing', async () => {
      const owner = await professionalOwner();
      const key = await publishedPolicy();
      await assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: key, reason: 'kept' });

      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const contract = contracts.find(
        (candidate) => candidate.moduleKey === 'commercial-collection-policy-assignment',
      );
      expect(contract).toBeDefined();

      const outcome = await contract!.eraseSubjectData(dataSource.manager, owner.user.id, {
        userId: owner.user.id,
        phoneAlias: 'del:story104',
        displayAlias: 'x',
        erasedAt: new Date(),
      });
      expect(outcome.anonymized).toBe(0);
      expect(outcome.deleted).toBe(0);
      expect(outcome.retained.map((entry) => entry.table)).toEqual([
        'commercial.seller_collection_policy_assignments',
      ]);

      expect(await contract!.exportSubjectData(dataSource.manager, owner.user.id)).toEqual([]);

      // `retained` is a claim about the data, so the data has to still be here.
      const rows = await rowsFor(owner.partyId);
      expect(rows).toHaveLength(1);
      expect(rows[0].assigned_by_user_id).toBe(owner.user.id);
    });
  });

  /** Statements one operation issues, measured through the same logger swap §8 proves. */
  async function countStatements(operation: () => Promise<unknown>): Promise<number> {
    const counter = new CountingLogger();
    const original = dataSource.logger;
    try {
      dataSource.logger = counter;
      counter.reset();
      await dataSource.query('SELECT 1');
      expect(counter.count).toBe(1);
      counter.reset();
      await operation();
      return counter.count - 0;
    } finally {
      dataSource.logger = original;
    }
  }

  /**
   * Everything written to a log during one operation.
   *
   * Both halves are needed and the repository has already learned why: the
   * referral suite shipped a version capturing only the process streams, which
   * passed while capturing nothing at all, because Nest's `Logger` is called
   * directly. So `Logger.prototype` is spied AND stdout/stderr are captured,
   * and §11's first case proves the mechanism sees a planted value before any
   * absence claim is trusted.
   */
  async function recordLogging<T>(run: () => Promise<T>): Promise<{ result: T; args: string; output: string }> {
    const args: unknown[] = [];
    let output = '';

    const methods = ['log', 'warn', 'error', 'debug', 'verbose'] as const;
    const loggerSpies = methods.map((method) =>
      jest.spyOn(Logger.prototype, method).mockImplementation(((...called: unknown[]) => {
        args.push(...called);
      }) as never),
    );
    const capture = (chunk: unknown): boolean => {
      output += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    };
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(capture as never);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(capture as never);

    try {
      const result = await run();
      return { result, args: JSON.stringify(args), output };
    } finally {
      out.mockRestore();
      err.mockRestore();
      for (const spy of loggerSpies) spy.mockRestore();
    }
  }

  // =========================================================================
  // §11. Nothing leaks into a log, an event or a notification
  // =========================================================================

  describe('\u00a711 leakage', () => {
    it('non-vacuity: the capture mechanism DOES see a planted value', async () => {
      // Asserted BEFORE any absence below is trusted. Without it, a clean
      // result could mean "nothing leaked" or "the probe sees nothing", and
      // those two look identical.
      const canary = 'CANARY-S104-7X9Q';
      const { args, output } = await recordLogging(async () => {
        new Logger('Story104Probe').log(`planted ${canary}`);
        process.stdout.write(`planted ${canary}\n`);
      });

      expect(args).toContain(canary);
      expect(output).toContain(canary);
    });

    it('logs no reason, policy key, workspace reference or identity across a full cycle', async () => {
      const owner = await professionalOwner();
      const first = await publishedPolicy(`canarykey-a-${Date.now() % 100000}`);
      const second = await publishedPolicy(`canarykey-b-${Date.now() % 100000}`);
      const reasonA = 'CANARY-REASON-ASSIGNED';
      const reasonB = 'CANARY-REASON-SUPERSEDED';

      const { args, output } = await recordLogging(async () => {
        await putAssignment(owner.user, owner.workspaceRef, { policyKey: first, reason: reasonA }).expect(200);
        await putAssignment(owner.user, owner.workspaceRef, { policyKey: second, reason: reasonB }).expect(200);
        await putAssignment(owner.user, owner.workspaceRef, { policyKey: second, reason: 'CANARY-REASON-REPLAY' }).expect(
          200,
        );
        await putAssignment(owner.user, owner.workspaceRef, {
          policyKey: 'canary-missing-key',
          reason: 'CANARY-REASON-REFUSED',
        }).expect(409);
        await readAssignment(owner.user, owner.workspaceRef).expect(200);
        await listPolicies(owner.user).expect(200);
      });

      for (const secret of [
        reasonA,
        reasonB,
        'CANARY-REASON-REPLAY',
        'CANARY-REASON-REFUSED',
        first,
        second,
        'canary-missing-key',
        owner.workspaceRef,
        owner.partyId,
        owner.user.id,
        owner.user.phone,
      ]) {
        expect(args).not.toContain(secret);
        expect(output).not.toContain(secret);
      }
    });

    it('emits no notification and no outbox row for any of it', async () => {
      const owner = await professionalOwner();
      const key = await publishedPolicy();
      const before = await dataSource.query(
        `SELECT (SELECT count(*)::int FROM notification.notifications) AS notifications,
                (SELECT count(*)::int FROM commerce.outbox_events) AS commerce_events,
                (SELECT count(*)::int FROM booking.outbox_events) AS booking_events`,
      );

      await assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: key, reason: 'quiet' });

      const after = await dataSource.query(
        `SELECT (SELECT count(*)::int FROM notification.notifications) AS notifications,
                (SELECT count(*)::int FROM commerce.outbox_events) AS commerce_events,
                (SELECT count(*)::int FROM booking.outbox_events) AS booking_events`,
      );
      expect(after).toEqual(before);

      // `commercial` has no outbox table at all, and asserting its ABSENCE is
      // stronger than counting one: a story that started emitting would have to
      // create the table first.
      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='commercial' AND tablename LIKE '%outbox%'`,
      );
      expect(n).toBe(0);
    });
  });

  // =========================================================================
  // §10. The #115 boundary — this story changes no order behaviour
  // =========================================================================

  describe('§10 the #115 boundary', () => {
    const domainSnapshot = () =>
      dataSource.query(
        `SELECT (SELECT count(*)::int FROM commerce.orders) AS orders,
                (SELECT count(*)::int FROM commerce.order_payment_schedules) AS schedules,
                (SELECT count(*)::int FROM commerce.order_payment_schedules WHERE policy_key IS NOT NULL) AS with_policy,
                (SELECT count(*)::int FROM commerce.order_payment_schedules WHERE policy_accepted_at IS NOT NULL) AS accepted,
                (SELECT count(*)::int FROM commerce.outbox_events) AS events,
                (SELECT count(*)::int FROM payment.payment_intents) AS intents,
                (SELECT count(*)::int FROM notification.notifications) AS notifications`,
      );

    it('changes no order, schedule, event, payment or notification row across a full cycle', async () => {
      const before = await domainSnapshot();

      const owner = await professionalOwner();
      const a = await publishedPolicy();
      const b = await publishedPolicy();
      await assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: a, reason: 'one' });
      await assignments.assign(owner.user.id, { workspaceRef: owner.workspaceRef, policyKey: b, reason: 'two' });
      await readAssignment(owner.user, owner.workspaceRef).expect(200);
      await listPolicies(owner.user).expect(200);

      expect(await domainSnapshot()).toEqual(before);
      // The control: the cycle really did happen.
      expect(await rowsFor(owner.partyId)).toHaveLength(2);
    });

    it('owns no commerce migration, whoever later changed the constraint', async () => {
      /*
       * Formerly temporal: it asserted the all-three CHECK was still in place,
       * because "replacing it is #115's decision". #115 has since made that
       * decision, so the assertion came due -- key and version are now
       * all-or-none and `policy_accepted_at` is independently nullable.
       *
       * What was permanent is that ASSIGNMENT does not reach into commerce. A
       * commerce migration authored by this story would still fail here, which
       * is what the original case was protecting.
       */
      const owned = await dataSource.query(
        `SELECT filename FROM public.schema_migrations
          WHERE filename LIKE 'commerce/%' AND filename LIKE '%assignment%'`,
      );
      expect(owned).toEqual([]);

      // The constraint is #115's shape now, and #104 still writes no schedule.
      const [reference] = await dataSource.query(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='ck_ops_policy_reference'`,
      );
      expect(reference.definition).not.toContain('policy_accepted_at');
    });

    it('populates no acceptance instant anywhere, which stays #42’s after Legal', async () => {
      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM commerce.order_payment_schedules WHERE policy_accepted_at IS NOT NULL`,
      );
      expect(n).toBe(0);
    });
  });
});

/**
 * Counts every statement TypeORM executes.
 *
 * `QueryRunner.query` calls `logger.logQuery` unconditionally — the LOGGER
 * decides whether to print, not the caller — so swapping the instance counts
 * real statements without turning query logging on for the whole suite. The
 * same helper `seller-subscription-surface.pg-spec.ts` uses, for the same
 * reason.
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
