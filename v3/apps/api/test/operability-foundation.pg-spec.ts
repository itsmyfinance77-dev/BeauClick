import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { RoleService } from '@beauclick/identity';
import { VerificationService } from '@beauclick/provider';
import { AuditEnforcementService } from '@beauclick/audit';
import { OutboxRelay } from '@beauclick/events';

import {
  PgTestApp,
  createPgTestApp,
  requiredPgEnv,
  resetDatabase,
  seedProfessional,
  seedUser,
} from './pg-test-app.factory';

const describePg = requiredPgEnv() ? describe : describe.skip;

/**
 * V3.1 Phase A -- the operability foundation.
 *
 * Four things are proven here, and the FIRST is the one the others depend on:
 *
 *  1. The boot-time audit assertion is not vacuous. A check that silently sees
 *     nothing passes forever and reads as a guarantee, which is worse than no
 *     check. Everything else in this file assumes the enforcement works, so it
 *     is established before anything else is asserted.
 *  2. Roles are grantable, and the escalation rules hold under adversarial use.
 *  3. Every privileged mutation lands in the audit log, and the log cannot be
 *     altered.
 *  4. Verification is reachable end to end, and the `verified` signal it
 *     produces reaches search.
 */
describePg('V3.1 Phase A -- operability foundation (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let relay: OutboxRelay;
  let roles: RoleService;
  let verification: VerificationService;

  async function drainUntilQuiet(maxPasses = 6): Promise<void> {
    for (let i = 0; i < maxPasses; i += 1) {
      const { dispatched } = await relay.drain();
      if (dispatched === 0) return;
    }
  }

  /**
   * Grants a role the way the bootstrap does -- straight into the tables --
   * because a test cannot use the API to create the first privileged account
   * for the same reason a deployment cannot.
   */
  async function bootstrapRole(userId: string, roleSlug: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO identity.user_roles (user_id, role_slug, granted_by, reason)
       VALUES ($1, $2, NULL, 'test bootstrap') ON CONFLICT DO NOTHING`,
      [userId, roleSlug],
    );
  }

  /** A token reflecting the user's CURRENT roles. Re-issued after a grant, as a real refresh would. */
  async function tokenFor(userId: string): Promise<string> {
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = app.get(JwtService);
    const access = await roles.resolveAccess(userId);
    return jwt.sign({ sub: userId, roles: access.roles, capabilities: access.capabilities });
  }

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    relay = ctx.relay;
    roles = app.get(RoleService);
    verification = app.get(VerificationService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  // -------------------------------------------------------------------
  // 1. The enforcement itself
  // -------------------------------------------------------------------

  describe('structural audit enforcement', () => {
    it('SEES real privileged mutations -- the property that makes an empty offender list mean anything', () => {
      const enforcement = app.get(AuditEnforcementService);
      const found = enforcement.privilegedMutations();

      // If the discovery mechanism ever breaks, it breaks by finding NOTHING,
      // and every other assertion in this describe block would still pass. This
      // is the case that catches that.
      expect(found.length).toBeGreaterThan(0);

      const handlers = found.map((r) => r.handler);
      // Named explicitly rather than counted: a route renamed or removed should
      // make somebody look, not silently shrink a number.
      expect(handlers).toEqual(
        expect.arrayContaining([
          'AdminRolesController.mutate',
          'AdminVerificationController.decide',
          'AdminPhoneConflictsController.resolve',
          'FinancialAdminController.createSettlement',
          'FinancialAdminController.reverseSettlement',
          'SearchAdminController.reindex',
          'SearchAdminController.rebuildProjection',
          'NotificationAdminController.retryDue',
        ]),
      );
    });

    it('finds every privileged mutation declared, and none undeclared', () => {
      const enforcement = app.get(AuditEnforcementService);
      expect(enforcement.unaudited()).toEqual([]);
    });

    it('records which declarations are transactional and which are explicitly not', () => {
      const enforcement = app.get(AuditEnforcementService);
      const byHandler = new Map(enforcement.privilegedMutations().map((r) => [r.handler, r]));

      // The three Phase A actions are single-DataSource DB mutations, so the
      // audit row commits with them or not at all.
      expect(byHandler.get('AdminRolesController.mutate')?.transactional).toBe(true);
      expect(byHandler.get('AdminVerificationController.decide')?.transactional).toBe(true);
      expect(byHandler.get('AdminPhoneConflictsController.resolve')?.transactional).toBe(true);

      // Settlement writes to a physically separate DataSource (ADR-017) and a
      // reindex writes to OpenSearch. Neither can share a transaction with the
      // audit row, and both DECLARE that rather than quietly pretending.
      expect(byHandler.get('FinancialAdminController.createSettlement')?.transactional).toBe(false);
      expect(byHandler.get('SearchAdminController.reindex')?.transactional).toBe(false);
    });

    it('a GET is not a mutation, so read routes are not required to declare an audit', () => {
      const enforcement = app.get(AuditEnforcementService);
      const handlers = enforcement.privilegedMutations().map((r) => r.handler);
      expect(handlers).not.toContain('AdminAuditController.list');
      expect(handlers).not.toContain('FinancialAdminController.totals');
    });
  });

  // -------------------------------------------------------------------
  // 2. Roles
  // -------------------------------------------------------------------

  describe('dynamic roles and capabilities', () => {
    it('gives a brand-new account the default role, from the data rather than a constant', async () => {
      const user = await seedUser(app, dataSource, '+989130000001');
      const access = await roles.resolveAccess(user.id);
      expect(access.roles).toEqual(['customer']);
      expect(access.capabilities).toEqual(expect.arrayContaining(['bc_book_service', 'bc_view_own_orders']));
      expect(access.capabilities).not.toContain('bc_manage_platform');
    });

    it('grants a role through the API and the target gains its capabilities', async () => {
      const operator = await seedUser(app, dataSource, '+989130000002');
      await bootstrapRole(operator.id, 'platform_operator');
      const target = await seedUser(app, dataSource, '+989130000003');

      // platform_operator granting platform_operator: the granted role's
      // capabilities are trivially a subset of the actor's own.
      await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${target.id}/roles`)
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .send({ roleSlug: 'platform_operator', operation: 'grant', reason: 'QA: second operator' })
        .expect(201);

      const access = await roles.resolveAccess(target.id);
      expect(access.roles).toContain('platform_operator');
      expect(access.capabilities).toContain('bc_manage_platform');
      expect(access.capabilities).toContain('bc_moderate_verification');
    });

    it('an administrator can appoint a moderator, whose capabilities are a subset of theirs', async () => {
      const admin = await seedUser(app, dataSource, '+989130000020');
      await bootstrapRole(admin.id, 'administrator');
      const target = await seedUser(app, dataSource, '+989130000021');

      await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${target.id}/roles`)
        .set('Authorization', `Bearer ${await tokenFor(admin.id)}`)
        .send({ roleSlug: 'moderator', operation: 'grant', reason: 'QA: content review cover' })
        .expect(201);

      const access = await roles.resolveAccess(target.id);
      expect(access.roles).toContain('moderator');
      expect(access.capabilities).toContain('bc_moderate_reviews');
    });

    it('a re-grant is idempotent rather than a unique-violation the caller must interpret', async () => {
      const operator = await seedUser(app, dataSource, '+989130000004');
      await bootstrapRole(operator.id, 'platform_operator');
      const target = await seedUser(app, dataSource, '+989130000005');
      const token = await tokenFor(operator.id);
      const body = { roleSlug: 'platform_operator', operation: 'grant', reason: 'QA: repeated grant' };

      await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${target.id}/roles`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${target.id}/roles`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(201);

      const rows = await dataSource.query(
        `SELECT count(*)::int AS n FROM identity.user_roles WHERE user_id = $1 AND role_slug = 'platform_operator'`,
        [target.id],
      );
      expect(rows[0].n).toBe(1);
    });

    it('revokes, and the revoked capability is gone from the next token', async () => {
      const operator = await seedUser(app, dataSource, '+989130000006');
      await bootstrapRole(operator.id, 'platform_operator');
      const target = await seedUser(app, dataSource, '+989130000007');
      await bootstrapRole(target.id, 'platform_operator');

      await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${target.id}/roles`)
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .send({ roleSlug: 'platform_operator', operation: 'revoke', reason: 'QA: cover period ended' })
        .expect(201);

      const access = await roles.resolveAccess(target.id);
      expect(access.roles).not.toContain('platform_operator');
      expect(access.capabilities).not.toContain('bc_manage_platform');
    });
  });

  // -------------------------------------------------------------------
  // The security matrix
  // -------------------------------------------------------------------

  describe('privilege escalation is refused', () => {
    it('a customer cannot reach an admin endpoint', async () => {
      const customer = await seedUser(app, dataSource, '+989131000001');
      await request(app.getHttpServer())
        .get('/api/v1/admin/audit-log')
        .set('Authorization', `Bearer ${await tokenFor(customer.id)}`)
        .expect(403);
    });

    it('a professional cannot reach an admin endpoint', async () => {
      const pro = await seedUser(app, dataSource, '+989131000002');
      await seedProfessional(dataSource, pro.id, 'متخصص');
      await request(app.getHttpServer())
        .get('/api/v1/admin/verification/queue')
        .set('Authorization', `Bearer ${await tokenFor(pro.id)}`)
        .expect(403);
    });

    it('a customer cannot grant themselves a role', async () => {
      const customer = await seedUser(app, dataSource, '+989131000003');
      await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${customer.id}/roles`)
        .set('Authorization', `Bearer ${await tokenFor(customer.id)}`)
        .send({ roleSlug: 'platform_operator', operation: 'grant', reason: 'attempting escalation' })
        .expect(403);

      expect(await roles.resolveAccess(customer.id)).toEqual(
        expect.objectContaining({ roles: ['customer'] }),
      );
    });

    it('a platform_operator cannot create an administrator', async () => {
      const operator = await seedUser(app, dataSource, '+989131000004');
      await bootstrapRole(operator.id, 'platform_operator');
      const target = await seedUser(app, dataSource, '+989131000005');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${target.id}/roles`)
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .send({ roleSlug: 'administrator', operation: 'grant', reason: 'attempting escalation' })
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');

      const rows = await dataSource.query(
        `SELECT count(*)::int AS n FROM identity.user_roles WHERE role_slug = 'administrator'`,
      );
      expect(rows[0].n).toBe(0);
    });

    it('an administrator cannot create another administrator through the API either', async () => {
      // The role is not grantable through the application AT ALL -- not "not
      // grantable by lesser roles". The only path is the documented bootstrap
      // with database authority.
      const admin = await seedUser(app, dataSource, '+989131000006');
      await bootstrapRole(admin.id, 'administrator');
      const target = await seedUser(app, dataSource, '+989131000007');

      await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${target.id}/roles`)
        .set('Authorization', `Bearer ${await tokenFor(admin.id)}`)
        .send({ roleSlug: 'administrator', operation: 'grant', reason: 'attempting escalation' })
        .expect(403);
    });

    it('a platform_operator cannot grant themselves a privileged role', async () => {
      const operator = await seedUser(app, dataSource, '+989131000008');
      await bootstrapRole(operator.id, 'platform_operator');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${operator.id}/roles`)
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .send({ roleSlug: 'platform_operator', operation: 'grant', reason: 'attempting self-escalation' })
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('cannot grant a role carrying a capability the actor lacks', async () => {
      // The subset rule at its real boundary. `platform_operator` deliberately
      // does not hold `bc_moderate_reviews`; `moderator` does. An operator
      // therefore cannot appoint one -- that would be handing out authority
      // over a domain they have none over themselves.
      const operator = await seedUser(app, dataSource, '+989131000009');
      await bootstrapRole(operator.id, 'platform_operator');
      const target = await seedUser(app, dataSource, '+989131000010');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${target.id}/roles`)
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .send({ roleSlug: 'moderator', operation: 'grant', reason: 'QA: subset rule' })
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');

      expect((await roles.resolveAccess(target.id)).roles).not.toContain('moderator');
    });

    it('CAN grant a role whose capabilities it fully holds', async () => {
      // The other side of the same rule, so the refusal above is shown to be
      // about the capability gap rather than about privileged roles in general.
      const operator = await seedUser(app, dataSource, '+989131000015');
      await bootstrapRole(operator.id, 'platform_operator');
      const target = await seedUser(app, dataSource, '+989131000016');

      await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${target.id}/roles`)
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .send({ roleSlug: 'platform_operator', operation: 'grant', reason: 'QA: subset rule, positive case' })
        .expect(201);

      expect((await roles.resolveAccess(target.id)).roles).toContain('platform_operator');
    });

    it('a forged target user id is refused, and creates no row', async () => {
      const operator = await seedUser(app, dataSource, '+989131000011');
      await bootstrapRole(operator.id, 'platform_operator');
      const ghost = uuidv7();

      await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${ghost}/roles`)
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .send({ roleSlug: 'platform_operator', operation: 'grant', reason: 'QA: forged target' })
        .expect(404);

      const rows = await dataSource.query(`SELECT count(*)::int AS n FROM identity.user_roles WHERE user_id = $1`, [
        ghost,
      ]);
      expect(rows[0].n).toBe(0);
    });

    it('an unknown role slug is refused', async () => {
      const operator = await seedUser(app, dataSource, '+989131000012');
      await bootstrapRole(operator.id, 'platform_operator');
      const target = await seedUser(app, dataSource, '+989131000013');

      await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${target.id}/roles`)
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .send({ roleSlug: 'superuser', operation: 'grant', reason: 'QA: unknown role' })
        .expect(400);
    });

    it('a revoked operator loses the admin surface IMMEDIATELY, on their existing token', async () => {
      // The property the live re-check exists for. Without it the revoked
      // operator would keep settling money for up to a full access-token TTL.
      const operator = await seedUser(app, dataSource, '+989131000014');
      await bootstrapRole(operator.id, 'platform_operator');
      const token = await tokenFor(operator.id);

      await request(app.getHttpServer())
        .get('/api/v1/admin/audit-log')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      await dataSource.query(`DELETE FROM identity.user_roles WHERE user_id = $1 AND role_slug = 'platform_operator'`, [
        operator.id,
      ]);

      // SAME token. It still says `bc_manage_platform`, and it is still
      // cryptographically valid -- and the request is refused anyway.
      await request(app.getHttpServer())
        .get('/api/v1/admin/audit-log')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });

  // -------------------------------------------------------------------
  // 3. The audit log
  // -------------------------------------------------------------------

  describe('the persistent audit log', () => {
    it('records a role grant with actor, before, after, and reason', async () => {
      const operator = await seedUser(app, dataSource, '+989132000001');
      await bootstrapRole(operator.id, 'platform_operator');
      const target = await seedUser(app, dataSource, '+989132000002');

      await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${target.id}/roles`)
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .send({ roleSlug: 'platform_operator', operation: 'grant', reason: 'QA: audit shape' })
        .expect(201);

      const rows = await dataSource.query(
        `SELECT actor_user_id, action, target_type, target_id, before_state, after_state, reason, correlation_id
           FROM admin.admin_audit_log WHERE action = 'identity.role_granted' AND target_id = $1`,
        [target.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_user_id).toBe(operator.id);
      expect(rows[0].target_type).toBe('user');
      expect(rows[0].before_state).toEqual({ roles: 'customer' });
      expect(rows[0].after_state).toEqual({ roles: 'customer,platform_operator', role: 'platform_operator' });
      expect(rows[0].reason).toBe('QA: audit shape');
      // Attached by construction, so the row can be joined to every event the
      // same request produced.
      expect(rows[0].correlation_id).not.toBeNull();
    });

    it('the ACTOR is the session, and no request field can change that', async () => {
      const operator = await seedUser(app, dataSource, '+989132000003');
      await bootstrapRole(operator.id, 'platform_operator');
      const target = await seedUser(app, dataSource, '+989132000004');
      const impostor = await seedUser(app, dataSource, '+989132000005');

      // `forbidNonWhitelisted` rejects the unknown field outright, which is the
      // stronger outcome: the attempt does not silently succeed with the field
      // ignored.
      await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${target.id}/roles`)
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .send({
          roleSlug: 'platform_operator',
          operation: 'grant',
          reason: 'QA: actor spoofing',
          actorUserId: impostor.id,
        })
        .expect(400);
    });

    it('cannot be modified or deleted -- the guarantee is a database GRANT, not restraint', async () => {
      const operator = await seedUser(app, dataSource, '+989132000006');
      await bootstrapRole(operator.id, 'platform_operator');
      const target = await seedUser(app, dataSource, '+989132000007');

      await request(app.getHttpServer())
        .post(`/api/v1/admin/users/${target.id}/roles`)
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .send({ roleSlug: 'platform_operator', operation: 'grant', reason: 'QA: immutability' })
        .expect(201);

      await expect(dataSource.query(`UPDATE admin.admin_audit_log SET action = 'tampered'`)).rejects.toThrow(
        /permission denied/i,
      );
      await expect(dataSource.query(`DELETE FROM admin.admin_audit_log`)).rejects.toThrow(/permission denied/i);

      // And the row is byte-identical afterwards, so the rejection was not a
      // partial success.
      const rows = await dataSource.query(
        `SELECT action FROM admin.admin_audit_log WHERE target_id = $1`,
        [target.id],
      );
      expect(rows[0].action).toBe('identity.role_granted');
    });

    it('cannot pass for the wrong reason: the connecting role is not a superuser', async () => {
      const rows = await dataSource.query(`SELECT usesuper FROM pg_user WHERE usename = current_user`);
      expect(rows[0].usesuper).toBe(false);
    });

    it('is readable only with the platform capability', async () => {
      const customer = await seedUser(app, dataSource, '+989132000008');
      await request(app.getHttpServer())
        .get('/api/v1/admin/audit-log')
        .set('Authorization', `Bearer ${await tokenFor(customer.id)}`)
        .expect(403);
    });

    it('paginates and filters by action', async () => {
      const operator = await seedUser(app, dataSource, '+989132000009');
      await bootstrapRole(operator.id, 'platform_operator');
      const token = await tokenFor(operator.id);

      for (let i = 0; i < 3; i += 1) {
        const target = await seedUser(app, dataSource, `+98913200100${i}`);
        await request(app.getHttpServer())
          .post(`/api/v1/admin/users/${target.id}/roles`)
          .set('Authorization', `Bearer ${token}`)
          .send({ roleSlug: 'platform_operator', operation: 'grant', reason: `QA: page ${i}` })
          .expect(201);
      }

      // Filtered by ACTOR, not only by action.
      //
      // `admin.admin_audit_log` cannot be truncated between cases -- the
      // application role holds INSERT + SELECT and nothing else, which is the
      // immutability this phase exists to establish -- so rows accumulate
      // across the whole suite run. Counting `action = 'identity.role_granted'`
      // would count every other test's grants too. Scoping to this test's own
      // operator is what makes the number meaningful, and it exercises a second
      // real filter at the same time.
      const res = await request(app.getHttpServer())
        .get(`/api/v1/admin/audit-log?page=1&limit=2&action=identity.role_granted&actorUserId=${operator.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta.pagination.total).toBe(3);

      const second = await request(app.getHttpServer())
        .get(`/api/v1/admin/audit-log?page=2&limit=2&action=identity.role_granted&actorUserId=${operator.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(second.body.data).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------
  // 4. Verification
  // -------------------------------------------------------------------

  describe('professional verification', () => {
    async function seedOperator(phone: string) {
      const operator = await seedUser(app, dataSource, phone);
      await bootstrapRole(operator.id, 'platform_operator');
      return { operator, token: await tokenFor(operator.id) };
    }

    it('a professional submits for themselves and becomes pending', async () => {
      const owner = await seedUser(app, dataSource, '+989133000001');
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص');
      await dataSource.query(`UPDATE provider.professionals SET verification_status = 'unverified' WHERE id = $1`, [
        professional.id,
      ]);

      const res = await request(app.getHttpServer())
        .post('/api/v1/verification/submit')
        .set('Authorization', `Bearer ${await tokenFor(owner.id)}`)
        .send({ note: 'مدارک آماده است' })
        .expect(201);

      expect(res.body.data.status).toBe('pending');
      const rows = await dataSource.query(`SELECT verification_status FROM provider.professionals WHERE id = $1`, [
        professional.id,
      ]);
      expect(rows[0].verification_status).toBe('pending');
    });

    it('there is no route to submit for another professional -- the id is not a parameter', async () => {
      const ownerA = await seedUser(app, dataSource, '+989133000002');
      await seedProfessional(dataSource, ownerA.id, 'متخصص الف');
      const customer = await seedUser(app, dataSource, '+989133000003');

      // A caller with no professional profile gets the generic refusal. There
      // is nothing in the request that could name somebody else's profile.
      await request(app.getHttpServer())
        .post('/api/v1/verification/submit')
        .set('Authorization', `Bearer ${await tokenFor(customer.id)}`)
        .send({})
        .expect(404);
    });

    it('refuses a second open submission', async () => {
      const owner = await seedUser(app, dataSource, '+989133000004');
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص');
      await dataSource.query(`UPDATE provider.professionals SET verification_status = 'unverified' WHERE id = $1`, [
        professional.id,
      ]);
      const token = await tokenFor(owner.id);

      await request(app.getHttpServer())
        .post('/api/v1/verification/submit')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/verification/submit')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(409);
    });

    it('a customer cannot approve', async () => {
      const owner = await seedUser(app, dataSource, '+989133000005');
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص');
      await dataSource.query(`UPDATE provider.professionals SET verification_status = 'unverified' WHERE id = $1`, [
        professional.id,
      ]);
      const submitted = await verification.submit(owner.id, null);
      const customer = await seedUser(app, dataSource, '+989133000006');

      await request(app.getHttpServer())
        .post(`/api/v1/admin/verification/${submitted.id}/decide`)
        .set('Authorization', `Bearer ${await tokenFor(customer.id)}`)
        .send({ decision: 'approve', reason: 'attempting unauthorized approval' })
        .expect(403);

      const rows = await dataSource.query(`SELECT verification_status FROM provider.professionals WHERE id = $1`, [
        professional.id,
      ]);
      expect(rows[0].verification_status).toBe('pending');
    });

    it('a platform_operator decides, and the decision is audited', async () => {
      const { operator, token } = await seedOperator('+989133000007');
      const owner = await seedUser(app, dataSource, '+989133000008');
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص');
      await dataSource.query(`UPDATE provider.professionals SET verification_status = 'unverified' WHERE id = $1`, [
        professional.id,
      ]);
      const submitted = await verification.submit(owner.id, null);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/verification/${submitted.id}/decide`)
        .set('Authorization', `Bearer ${token}`)
        .send({ decision: 'approve', reason: 'مدارک بررسی و تأیید شد' })
        .expect(201);

      const professionals = await dataSource.query(
        `SELECT verification_status FROM provider.professionals WHERE id = $1`,
        [professional.id],
      );
      expect(professionals[0].verification_status).toBe('verified');

      const audit = await dataSource.query(
        `SELECT actor_user_id, before_state, after_state, reason FROM admin.admin_audit_log
          WHERE action = 'provider.verification_approved' AND target_id = $1`,
        [professional.id],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_user_id).toBe(operator.id);
      expect(audit[0].before_state).toEqual({ verificationStatus: 'pending' });
      expect(audit[0].after_state).toEqual(
        expect.objectContaining({ verificationStatus: 'verified', requestId: submitted.id }),
      );
    });

    it('refuses to decide the same request twice', async () => {
      const { token } = await seedOperator('+989133000009');
      const owner = await seedUser(app, dataSource, '+989133000010');
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص');
      await dataSource.query(`UPDATE provider.professionals SET verification_status = 'unverified' WHERE id = $1`, [
        professional.id,
      ]);
      const submitted = await verification.submit(owner.id, null);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/verification/${submitted.id}/decide`)
        .set('Authorization', `Bearer ${token}`)
        .send({ decision: 'approve', reason: 'first decision' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/verification/${submitted.id}/decide`)
        .set('Authorization', `Bearer ${token}`)
        .send({ decision: 'reject', reason: 'attempting to overturn' })
        .expect(409);

      const rows = await dataSource.query(`SELECT verification_status FROM provider.professionals WHERE id = $1`, [
        professional.id,
      ]);
      // An approval is not silently reversible.
      expect(rows[0].verification_status).toBe('verified');
    });

    it('refuses an illegal transition -- the existing state machine still decides what is legal', async () => {
      const owner = await seedUser(app, dataSource, '+989133000011');
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص');
      await dataSource.query(`UPDATE provider.professionals SET verification_status = 'revoked' WHERE id = $1`, [
        professional.id,
      ]);

      // `revoked` has no legal outgoing transition at all.
      await request(app.getHttpServer())
        .post('/api/v1/verification/submit')
        .set('Authorization', `Bearer ${await tokenFor(owner.id)}`)
        .send({})
        .expect(409);
    });

    it('a rejected professional may resubmit, and the queue shows only open requests', async () => {
      const { token } = await seedOperator('+989133000012');
      const owner = await seedUser(app, dataSource, '+989133000013');
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص');
      await dataSource.query(`UPDATE provider.professionals SET verification_status = 'unverified' WHERE id = $1`, [
        professional.id,
      ]);

      const first = await verification.submit(owner.id, null);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/verification/${first.id}/decide`)
        .set('Authorization', `Bearer ${token}`)
        .send({ decision: 'reject', reason: 'مدارک ناقص بود' })
        .expect(201);

      const emptyQueue = await request(app.getHttpServer())
        .get('/api/v1/admin/verification/queue')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(emptyQueue.body.data).toHaveLength(0);

      // rejected -> pending is a legal transition in the existing table.
      await request(app.getHttpServer())
        .post('/api/v1/verification/submit')
        .set('Authorization', `Bearer ${await tokenFor(owner.id)}`)
        .send({ note: 'مدارک کامل ارسال شد' })
        .expect(201);

      const queue = await request(app.getHttpServer())
        .get('/api/v1/admin/verification/queue')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(queue.body.data).toHaveLength(1);
      expect(queue.body.data[0].displayName).toBe('متخصص');
    });

    it('approval reaches SEARCH -- the verified signal stops being inert', async () => {
      const { token } = await seedOperator('+989133000014');
      const owner = await seedUser(app, dataSource, '+989133000015');
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص جست‌وجو');
      await dataSource.query(`UPDATE provider.professionals SET verification_status = 'unverified' WHERE id = $1`, [
        professional.id,
      ]);
      await drainUntilQuiet();

      const submitted = await verification.submit(owner.id, null);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/verification/${submitted.id}/decide`)
        .set('Authorization', `Bearer ${token}`)
        .send({ decision: 'approve', reason: 'تأیید برای آزمون جست‌وجو' })
        .expect(201);

      await drainUntilQuiet();

      // The projection search reads from. Before Phase A this column could
      // never hold anything but 'unverified', so `verifiedOnly` matched nothing
      // and WEIGHT_VERIFIED contributed zero for every provider in the index.
      const projection = await dataSource.query(
        `SELECT verification_status FROM search.provider_documents WHERE professional_id = $1`,
        [professional.id],
      );
      expect(projection).toHaveLength(1);
      expect(projection[0].verification_status).toBe('verified');
    });
  });

  // -------------------------------------------------------------------
  // 5. Phone conflicts
  // -------------------------------------------------------------------

  describe('phone conflict resolution', () => {
    async function seedConflict(phone: string, existingUserId: string): Promise<string> {
      const id = uuidv7();
      await dataSource.query(
        `INSERT INTO identity.phone_conflicts (id, phone, existing_user_id, note, resolved_at)
         VALUES ($1, $2, $3, 'QA fixture', NULL)`,
        [id, phone, existingUserId],
      );
      return id;
    }

    it('resolves, and records who and why', async () => {
      const operator = await seedUser(app, dataSource, '+989134000001');
      await bootstrapRole(operator.id, 'platform_operator');
      const other = await seedUser(app, dataSource, '+989134000002');
      const conflictId = await seedConflict('+989134000099', other.id);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/phone-conflicts/${conflictId}/resolve`)
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .send({ reason: 'بررسی شد؛ دو حساب مجزا هستند' })
        .expect(201);

      expect(res.body.data.resolvedAt).not.toBeNull();

      const audit = await dataSource.query(
        `SELECT actor_user_id, reason FROM admin.admin_audit_log
          WHERE action = 'identity.phone_conflict_resolved' AND target_id = $1`,
        [conflictId],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_user_id).toBe(operator.id);
    });

    it('is idempotent, and a repeat writes NO second audit row', async () => {
      const operator = await seedUser(app, dataSource, '+989134000003');
      await bootstrapRole(operator.id, 'platform_operator');
      const other = await seedUser(app, dataSource, '+989134000004');
      const conflictId = await seedConflict('+989134000098', other.id);
      const token = await tokenFor(operator.id);
      const body = { reason: 'بررسی شد' };

      await request(app.getHttpServer())
        .post(`/api/v1/admin/phone-conflicts/${conflictId}/resolve`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/phone-conflicts/${conflictId}/resolve`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(201);

      // Re-recording a no-op as if it were an action is how an audit trail
      // stops being a reliable account of what happened.
      const audit = await dataSource.query(
        `SELECT count(*)::int AS n FROM admin.admin_audit_log
          WHERE action = 'identity.phone_conflict_resolved' AND target_id = $1`,
        [conflictId],
      );
      expect(audit[0].n).toBe(1);
    });

    it('resolution does NOT touch either identity -- it records a review, not a merge', async () => {
      const operator = await seedUser(app, dataSource, '+989134000005');
      await bootstrapRole(operator.id, 'platform_operator');
      const other = await seedUser(app, dataSource, '+989134000006');
      const conflictId = await seedConflict('+989134000097', other.id);

      const before = await dataSource.query(`SELECT id, phone, roles FROM identity.users WHERE id = $1`, [other.id]);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/phone-conflicts/${conflictId}/resolve`)
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .send({ reason: 'QA: no identity mutation' })
        .expect(201);

      const after = await dataSource.query(`SELECT id, phone, roles FROM identity.users WHERE id = $1`, [other.id]);
      expect(after).toEqual(before);
    });

    it('an unauthorized user cannot resolve', async () => {
      const customer = await seedUser(app, dataSource, '+989134000007');
      const other = await seedUser(app, dataSource, '+989134000008');
      const conflictId = await seedConflict('+989134000096', other.id);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/phone-conflicts/${conflictId}/resolve`)
        .set('Authorization', `Bearer ${await tokenFor(customer.id)}`)
        .send({ reason: 'attempting unauthorized resolution' })
        .expect(403);

      const rows = await dataSource.query(`SELECT resolved_at FROM identity.phone_conflicts WHERE id = $1`, [
        conflictId,
      ]);
      expect(rows[0].resolved_at).toBeNull();
    });
  });

  // -------------------------------------------------------------------
  // 6. Search quality metrics
  // -------------------------------------------------------------------

  describe('search quality metrics', () => {
    it('reports zero-result rate and click-through rate from existing events', async () => {
      const operator = await seedUser(app, dataSource, '+989135000001');
      await bootstrapRole(operator.id, 'platform_operator');

      const today = new Date().toISOString().slice(0, 10);
      const insertFact = async (eventType: string, metric: number | null, dimensions: object) => {
        await dataSource.query(
          `INSERT INTO analytics.events
             (event_id, event_type, event_version, aggregate_type, aggregate_id, subject_type, subject_id,
              dimensions, metric_value, occurred_at, occurred_on)
           VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8, now(), $9)`,
          [
            uuidv7(),
            eventType,
            eventType === 'SearchPerformed' ? 'search' : 'professional',
            uuidv7(),
            eventType === 'SearchPerformed' ? 'search' : 'provider',
            uuidv7(),
            JSON.stringify(dimensions),
            metric,
            today,
          ],
        );
      };

      // Four searches, one of which returned nothing.
      await insertFact('SearchPerformed', 3, { queryClass: 'text' });
      await insertFact('SearchPerformed', 5, { queryClass: 'text' });
      await insertFact('SearchPerformed', 0, { queryClass: 'text' });
      await insertFact('SearchPerformed', 2, { queryClass: 'filtered' });
      // Two profile views, one from a search result and one from a direct link.
      await insertFact('ProviderProfileViewed', null, { source: 'search' });
      await insertFact('ProviderProfileViewed', null, { source: 'direct' });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/admin/analytics?from=${today}&to=${today}`)
        .set('Authorization', `Bearer ${await tokenFor(operator.id)}`)
        .expect(200);

      const search = res.body.data.search;
      expect(search.searches.value).toBe(4);
      expect(search.emptyResultSearches.value).toBe(1);
      expect(search.emptyResultRate.value).toBeCloseTo(0.25, 5);
      // Only the search-sourced view counts; the direct one is excluded, which
      // is the whole reason `source` exists on the contract.
      expect(search.searchSourcedViews.value).toBe(1);
      expect(search.clickThroughRate.value).toBeCloseTo(0.25, 5);
    });

    it('is capability-gated like every other admin read', async () => {
      const customer = await seedUser(app, dataSource, '+989135000002');
      await request(app.getHttpServer())
        .get('/api/v1/admin/analytics')
        .set('Authorization', `Bearer ${await tokenFor(customer.id)}`)
        .expect(403);
    });
  });
});
