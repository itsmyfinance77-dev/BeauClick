import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MetricsRegistry } from '@beauclick/observability';

import { PgTestApp, createPgTestApp, requiredPgEnv } from './pg-test-app.factory';

/**
 * Observability instrumentation, against a real running application
 * (`OPS-03`, `OPS-04`).
 *
 * ## What this verifies, and what it explicitly does not
 *
 * **Verified locally:** that requests through the real Nest pipeline produce
 * metrics, that the metric labels are the bounded ones (a route TEMPLATE, a
 * status CLASS) rather than the unbounded ones that kill a monitoring system,
 * and that the scrape endpoint fails CLOSED when it is not configured.
 *
 * **Not verified, and it is a live gate:** that any of this reaches a
 * monitoring backend. No backend has been selected -- that is downstream of
 * `HOSTING` -- and a green run here is evidence about the instrumentation, not
 * about a dashboard. `OPS-03` and `OPS-04` stay open.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

describeIfPg('Observability instrumentation on real PostgreSQL', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let metrics: MetricsRegistry;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    metrics = app.get(MetricsRegistry);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    metrics.reset();
  });

  describe('HTTP metrics', () => {
    it('counts a request that went through the real pipeline', async () => {
      await request(app.getHttpServer()).get('/api/health').expect(200);
      const output = metrics.render();
      expect(output).toContain('beauclick_http_requests_total{');
      expect(output).toContain('status="2xx"');
      expect(output).toContain('beauclick_http_request_duration_seconds_count{');
    });

    it('labels by ROUTE TEMPLATE, never by the path', async () => {
      // The cardinality decision, asserted against the real router rather than
      // against a hand-built context. `req.route.path` is populated by Express
      // only after matching, so this is where the assumption is actually
      // tested.
      await request(app.getHttpServer()).get('/api/health/ready').expect(200);
      const output = metrics.render();
      // The template carries the global `/api` prefix, because that is what
      // Express matched. Bounded either way, and the fuller string is the more
      // useful label.
      expect(output).toContain('route="/api/health/ready"');
      expect(output).not.toContain('route="unmatched"');
    });

    it('does NOT create a series per unmatched path, which is how a 404 flood would kill it', async () => {
      // Deliberately several distinct paths. If the raw path were the label,
      // this would produce three series and an attacker could produce
      // millions.
      for (const path of ['/api/v1/does-not-exist-1', '/api/v1/does-not-exist-2', '/api/v1/does-not-exist-3']) {
        await request(app.getHttpServer()).get(path).expect(404);
      }
      const output = metrics.render();
      const unmatched = output.split('\n').filter((l) => l.startsWith('beauclick_http_requests_total{') && l.includes('unmatched'));
      expect(unmatched).toHaveLength(1);
      expect(unmatched[0]).toContain('} 3');
      expect(output).not.toContain('does-not-exist');
    });

    it('records a failing request under its status class', async () => {
      await request(app.getHttpServer()).get('/api/v1/me').expect(401);
      expect(metrics.render()).toContain('status="4xx"');
    });

    it('renders a body a Prometheus parser accepts', async () => {
      await request(app.getHttpServer()).get('/api/health').expect(200);
      const output = metrics.render();
      for (const line of output.split('\n').filter(Boolean)) {
        // Every line is either a comment or `name{labels} value`.
        expect(line).toMatch(/^(#\s(HELP|TYPE)\s\S+\s.+|[a-zA-Z_:][a-zA-Z0-9_:]*(\{.*\})?\s-?[\d.eE+]+)$/);
      }
    });
  });

  describe('the scrape endpoint', () => {
    it('is INDISTINGUISHABLE FROM ABSENT when no token is configured', async () => {
      // Failing closed. The alternative is a deployment that publishes every
      // route template, request volume, latency distribution, and payment
      // outcome because somebody forgot a variable -- with nothing anywhere
      // saying so. The worst outcome of a forgotten variable should be a
      // missing dashboard, which is visible, not an open one, which is not.
      await request(app.getHttpServer()).get('/api/metrics').expect(404);
    });

    it('is still 404 for a caller presenting a token, so a scan learns nothing', async () => {
      await request(app.getHttpServer()).get('/api/metrics').set('authorization', 'Bearer anything').expect(404);
    });
  });

  describe('the scrape endpoint, configured', () => {
    let secured: PgTestApp;

    beforeAll(async () => {
      secured = await createPgTestApp({ METRICS_AUTH_TOKEN: 'scrape-token-for-this-suite' });
    }, 60_000);

    afterAll(async () => {
      await secured?.app.close();
      // Restored so no later suite in this file inherits it.
      delete process.env.METRICS_AUTH_TOKEN;
    });

    it('serves the exposition format to a caller with the token', async () => {
      const response = await request(secured.app.getHttpServer())
        .get('/api/metrics')
        .set('authorization', 'Bearer scrape-token-for-this-suite')
        .expect(200);

      // The exposition content type. A scraper handed `application/json`
      // refuses the body.
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.text).toContain('# TYPE beauclick_http_requests_total counter');
      // NOT wrapped in the response envelope -- that would make it unparseable.
      expect(response.text.startsWith('{')).toBe(false);
    });

    it('accepts the raw token as well as a Bearer prefix, because scrapers differ', async () => {
      await request(secured.app.getHttpServer())
        .get('/api/metrics')
        .set('authorization', 'scrape-token-for-this-suite')
        .expect(200);
    });

    it('refuses a wrong token', async () => {
      await request(secured.app.getHttpServer())
        .get('/api/metrics')
        .set('authorization', 'Bearer wrong')
        .expect(403);
    });

    it('refuses no token at all', async () => {
      await request(secured.app.getHttpServer()).get('/api/metrics').expect(403);
    });

    it('never serves a secret in the scrape body', async () => {
      const response = await request(secured.app.getHttpServer())
        .get('/api/metrics')
        .set('authorization', 'Bearer scrape-token-for-this-suite')
        .expect(200);

      expect(response.text).not.toContain('scrape-token-for-this-suite');
      expect(response.text).not.toContain('postgres://');
      for (const secret of [process.env.JWT_ACCESS_SECRET, process.env.OTP_HMAC_SECRET]) {
        if (secret) expect(response.text).not.toContain(secret);
      }
    });
  });
});
