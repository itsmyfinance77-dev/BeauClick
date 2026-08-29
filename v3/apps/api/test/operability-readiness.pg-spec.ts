import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PgTestApp, createPgTestApp, requiredPgEnv } from './pg-test-app.factory';

/**
 * The readiness surface, against a real application (V3.1 Phase F).
 *
 * `readiness.spec.ts` pins the vocabulary. This proves the report is built
 * from what the application is ACTUALLY running -- and, above all, that a
 * public, unauthenticated, rate-limit-exempt endpoint publishes no
 * infrastructure.
 *
 * The test application boots with the sandbox gateway, the in-memory search
 * engine, the local storage driver, and the null SMS provider. That is exactly
 * the configuration whose honest description this endpoint exists to give: a
 * perfectly healthy deployment that is not a marketplace.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

describeIfPg('Readiness reporting on real PostgreSQL', () => {
  let ctx: PgTestApp;
  let app: INestApplication;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await app?.close();
  });

  async function readiness(): Promise<Record<string, unknown>> {
    const response = await request(app.getHttpServer()).get('/api/health/ready').expect(200);
    // The envelope interceptor wraps every response; the report is `data`.
    return (response.body.data ?? response.body) as Record<string, unknown>;
  }

  function dependency(report: Record<string, unknown>, name: string) {
    const list = report.dependencies as Array<Record<string, unknown>>;
    const found = list.find((d) => d.name === name);
    expect(found).toBeDefined();
    return found as Record<string, unknown>;
  }

  it('serves without a session, because an orchestrator probe carries none', async () => {
    await request(app.getHttpServer()).get('/api/health/ready').expect(200);
  });

  it('reports the instance as ready even though four dependencies are stand-ins', async () => {
    // The distinction the endpoint exists for: routable and truthful are two
    // different questions, and collapsing them would either take every
    // development instance out of rotation or hide the stand-ins.
    const report = await readiness();
    expect(report.status).toBe('ready');
    expect((report.milestone as Record<string, unknown>).allDependenciesReal).toBe(false);
  });

  it('names the SANDBOX gateway as simulated rather than as a working payment surface', async () => {
    const payment = dependency(await readiness(), 'payment');
    expect(payment.state).toBe('simulated');
    expect(payment.productionVerified).toBe(false);
    expect(payment.blockedBy).toBe('GAP-06b');
  });

  it('names the null SMS provider as simulated, so an environment that sends nothing cannot look like one that sends', async () => {
    const sms = dependency(await readiness(), 'sms');
    expect(sms.state).toBe('simulated');
    expect(sms.blockedBy).toBe('GAP-11');
  });

  it('names the in-memory search engine as simulated even though it answers every ping', async () => {
    // The fake would report itself reachable, which is precisely how a
    // simulated dependency passes for a real one.
    expect(dependency(await readiness(), 'search').state).toBe('simulated');
  });

  it('names the container-disk storage driver as simulated', async () => {
    expect(dependency(await readiness(), 'storage').state).toBe('simulated');
  });

  it('reports the two same-cluster dependencies as genuinely REACHABLE, having asked them', async () => {
    const report = await readiness();
    expect(dependency(report, 'database').state).toBe('reachable');
    expect(dependency(report, 'ledger').state).toBe('reachable');
  });

  it('names an error reporter that transmits nothing as simulated', async () => {
    // Errors are logged, and nothing leaves the process. A deployment that
    // believes it has error tracking and does not must not look like one that
    // does -- the third time this codebase has needed that distinction, after
    // `providerVerified` and `describeDriver().durable`.
    const reporting = dependency(await readiness(), 'error_reporting');
    expect(reporting.state).toBe('simulated');
    expect(reporting.blockedBy).toBe('OPS-04');
  });

  it('reports the per-process throttle store, which no code here can judge', async () => {
    // THROTTLE-STORE is topology-dependent: correct at one instance, silently
    // wrong at two. The fact is surfaced; the judgement belongs to whoever
    // knows how many instances run.
    const throttle = dependency(await readiness(), 'throttle_store');
    expect(throttle.state).toBe('simulated');
    expect(throttle.blockedBy).toBe('THROTTLE-STORE');
  });

  it('reports NOTHING as production-verified', async () => {
    const report = await readiness();
    for (const entry of report.dependencies as Array<Record<string, unknown>>) {
      expect({ name: entry.name, productionVerified: entry.productionVerified }).toEqual({
        name: entry.name,
        productionVerified: false,
      });
    }
    expect((report.milestone as Record<string, unknown>).externalEnablementComplete).toBe(false);
  });

  /**
   * The rule that makes a public, unauthenticated, unthrottled endpoint safe.
   */
  it('publishes no host, credential, endpoint, or connection string', async () => {
    const report = await readiness();
    // `configuration.problems` is excluded deliberately, and its exclusion IS
    // the point: those messages quote origins and driver names, which is why
    // `configurationVerdict` withholds them in production. That branch is
    // asserted directly in `readiness.spec.ts`, because a process cannot be
    // booted as production here -- `validateEnv` and `MediaModule` would both
    // refuse this configuration, exactly as they should. Everything a
    // PRODUCTION deployment would publish is what is scanned below.
    const { configuration, ...published } = report;
    const serialized = JSON.stringify({ ...published, configuration: { valid: (configuration as Record<string, unknown>).valid } });

    // The real values this process is running on. Sourced from the actual
    // environment rather than hardcoded, so this keeps working when the test
    // database moves.
    const secrets = [
      process.env.DATABASE_URL,
      process.env.FINANCIAL_DATABASE_URL,
      process.env.OPENSEARCH_URL,
      process.env.JWT_ACCESS_SECRET,
      process.env.OTP_HMAC_SECRET,
      process.env.MEDIA_S3_SECRET_ACCESS_KEY,
    ].filter((v): v is string => typeof v === 'string' && v.length > 0);

    for (const secret of secrets) expect(serialized).not.toContain(secret);

    // And the shapes those values take, in case one of them is unset here but
    // set on a real deployment.
    for (const fragment of ['postgres://', 'localhost', '127.0.0.1', ':5432', ':5433', 'password', 'Bearer ']) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it('withholds configuration problem DETAIL outside production only by environment, not by accident', async () => {
    // The suite runs as NODE_ENV=test, where the reasons ARE included: they
    // are useful there and there is nothing to protect. The production
    // behaviour -- a bare boolean -- is asserted in `env.validation.spec.ts`
    // and by the branch in `ReadinessService.report`; what matters here is
    // that the field exists and is a verdict rather than a dump.
    const configuration = (await readiness()).configuration as Record<string, unknown>;
    expect(typeof configuration.valid).toBe('boolean');
  });

  it('leaves the liveness endpoint unchanged, because an orchestrator already depends on its shape', async () => {
    const response = await request(app.getHttpServer()).get('/api/health').expect(200);
    const body = (response.body.data ?? response.body) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ database: 'ok' });
    expect(body.storage).toEqual(expect.objectContaining({ durable: expect.any(Boolean) }));
  });
});
