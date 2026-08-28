import { createServer, Server } from 'http';
import { AddressInfo } from 'net';

import {
  ErrorReport,
  HttpErrorReporter,
  HttpErrorReporterConfig,
  LoggingErrorReporter,
  httpErrorReporterConfigFromEnv,
} from './error-reporter';

/**
 * The error-reporting port (`OPS-04`).
 *
 * Exercised against a REAL local HTTP server rather than a mocked `fetch`, for
 * the reason `http-sms-provider.spec.ts` records: a mock verifies the call
 * this code makes, and what needs verifying is what happens when a server
 * behaves badly -- refuses the connection, answers 500, or accepts the
 * connection and never answers. A mock cannot hang.
 *
 * **This is a local HTTP double and it is not provider-sandbox evidence.**
 * `OPS-04` asks for real production errors arriving at a selected backend. No
 * backend has been selected. What is verified here is the CODE half: the
 * request, the timeout, the redaction, and -- the part that matters most --
 * that a failing collector cannot make an outage worse.
 */
function report(overrides: Partial<ErrorReport> = {}): ErrorReport {
  return {
    error: { name: 'Error', message: 'boom', stack: 'Error: boom\n    at x' },
    level: 'error',
    correlationId: 'c-1',
    route: '/v1/orders/:id',
    method: 'GET',
    statusCode: 500,
    userId: 'u1',
    context: {},
    ...overrides,
  };
}

function config(overrides: Partial<HttpErrorReporterConfig> = {}): HttpErrorReporterConfig {
  return {
    endpoint: 'https://collector.example/ingest',
    authHeader: 'Authorization',
    authValue: 'Bearer test-token',
    timeoutMs: 500,
    environment: 'test',
    release: null,
    ...overrides,
  };
}

describe('httpErrorReporterConfigFromEnv', () => {
  it('returns null unless BOTH the endpoint and the credential are present', () => {
    // Partial configuration is treated as none: an endpoint with no credential
    // produces a 401 on every report, and an operator would be debugging the
    // reporter during the incident the reporter exists to explain.
    expect(httpErrorReporterConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      httpErrorReporterConfigFromEnv({ ERROR_REPORTER_ENDPOINT: 'https://c.example/i' } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(httpErrorReporterConfigFromEnv({ ERROR_REPORTER_AUTH_VALUE: 'x' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('refuses a plaintext endpoint', () => {
    // An error report carries stack traces, route templates, and user ids.
    expect(() =>
      httpErrorReporterConfigFromEnv({
        ERROR_REPORTER_ENDPOINT: 'http://c.example/i',
        ERROR_REPORTER_AUTH_VALUE: 'x',
      } as NodeJS.ProcessEnv),
    ).toThrow(/must be https/);
  });

  it('builds a configuration when both are present', () => {
    const built = httpErrorReporterConfigFromEnv({
      NODE_ENV: 'production',
      ERROR_REPORTER_ENDPOINT: 'https://c.example/i',
      ERROR_REPORTER_AUTH_VALUE: 'secret-value',
      ERROR_REPORTER_AUTH_HEADER: 'x-api-key',
      ERROR_REPORTER_TIMEOUT_MS: '1500',
      RELEASE_VERSION: 'v3.1.0',
    } as NodeJS.ProcessEnv);

    expect(built).toEqual({
      endpoint: 'https://c.example/i',
      authHeader: 'x-api-key',
      authValue: 'secret-value',
      timeoutMs: 1500,
      environment: 'production',
      release: 'v3.1.0',
    });
  });

  it('falls back to a sane timeout rather than trusting a junk one', () => {
    const built = httpErrorReporterConfigFromEnv({
      ERROR_REPORTER_ENDPOINT: 'https://c.example/i',
      ERROR_REPORTER_AUTH_VALUE: 'x',
      ERROR_REPORTER_TIMEOUT_MS: 'not-a-number',
    } as NodeJS.ProcessEnv);
    expect(built?.timeoutMs).toBe(3000);
  });
});

describe('LoggingErrorReporter', () => {
  it('reports that it transmits nothing, so it cannot be mistaken for one that does', () => {
    const reporter = new LoggingErrorReporter();
    expect(reporter.reportsExternally).toBe(false);
  });

  it('never throws', async () => {
    await expect(new LoggingErrorReporter().capture(report())).resolves.toBeUndefined();
  });
});

describe('HttpErrorReporter against a real HTTP server', () => {
  let server: Server;
  let received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }>;
  let endpoint: string;
  let behaviour: 'ok' | 'error' | 'hang' = 'ok';

  beforeAll(async () => {
    received = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += String(chunk)));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        if (behaviour === 'hang') return; // accepted, never answered
        res.writeHead(behaviour === 'error' ? 500 : 202, { 'content-type': 'application/json' });
        // A collector's error body routinely quotes the payload back, which is
        // why the reporter must log the STATUS and never this.
        res.end(JSON.stringify({ ok: behaviour === 'ok', echo: body }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ingest`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    received.length = 0;
    behaviour = 'ok';
  });

  it('transmits, and says that it does', async () => {
    const reporter = new HttpErrorReporter(config({ endpoint }));
    expect(reporter.reportsExternally).toBe(true);
    await reporter.capture(report());

    expect(received).toHaveLength(1);
    const sent = JSON.parse(received[0].body);
    expect(sent.correlationId).toBe('c-1');
    expect(sent.route).toBe('/v1/orders/:id');
    expect(sent.statusCode).toBe(500);
    expect(sent.error.name).toBe('Error');
  });

  it('sends the credential in the configured header', async () => {
    await new HttpErrorReporter(config({ endpoint, authHeader: 'x-api-key', authValue: 'k1' })).capture(report());
    expect(received[0].headers['x-api-key']).toBe('k1');
  });

  it('redacts the payload on the way out, even if the caller did not', async () => {
    // The reporter is the boundary where bytes leave the building, so it
    // redacts a second time. The cost is nothing next to a caller that built a
    // report by another route.
    await new HttpErrorReporter(config({ endpoint })).capture(
      report({
        error: { name: 'QueryFailedError', message: 'connect postgres://app:hunter2@db/x failed', stack: 'at +989123456789' },
        context: { authorization: 'Bearer abc123def456', phone: '+989123456789' },
      }),
    );

    const body = received[0].body;
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('9123456789');
    expect(body).not.toContain('abc123def456');
  });

  it('carries a user ID and nothing else identifying', async () => {
    // An error tracker is a third-party system holding data indefinitely. An
    // opaque id there can be joined to a person by someone with database
    // access, which is the correct amount of friction; a phone number there is
    // a personal-data export nobody approved.
    await new HttpErrorReporter(config({ endpoint })).capture(report({ userId: 'u1' }));
    const sent = JSON.parse(received[0].body);
    expect(sent.userId).toBe('u1');
    expect(Object.keys(sent)).not.toContain('phone');
    expect(Object.keys(sent)).not.toContain('email');
  });

  describe('when the collector misbehaves', () => {
    it('does not throw when it answers 500', async () => {
      // The property that matters: this runs inside the exception filter, on a
      // request already failing. A reporter that throws there turns a 500 with
      // a Persian message into an unhandled rejection.
      behaviour = 'error';
      await expect(new HttpErrorReporter(config({ endpoint })).capture(report())).resolves.toBeUndefined();
    });

    it('does not throw, and does not hang, when it never answers', async () => {
      behaviour = 'hang';
      const startedAt = Date.now();
      await expect(
        new HttpErrorReporter(config({ endpoint, timeoutMs: 200 })).capture(report()),
      ).resolves.toBeUndefined();
      // Without the deadline this would hold the failing request until
      // something else gave up -- turning a 500 into a hang, and a hang into
      // an exhausted connection pool.
      expect(Date.now() - startedAt).toBeLessThan(5000);
    });

    it('does not throw when the connection is refused', async () => {
      const reporter = new HttpErrorReporter(config({ endpoint: 'http://127.0.0.1:1/ingest', timeoutMs: 300 }));
      await expect(reporter.capture(report())).resolves.toBeUndefined();
    });

    it('does not retry — a retry storm during an incident is how a partial outage becomes total', async () => {
      behaviour = 'error';
      await new HttpErrorReporter(config({ endpoint })).capture(report());
      expect(received).toHaveLength(1);
    });
  });
});
