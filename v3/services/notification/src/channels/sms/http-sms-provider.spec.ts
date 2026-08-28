import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { HttpSmsProvider, HttpSmsProviderConfig, httpSmsConfigFromEnv, renderSmsBody } from './http-sms-provider';
import { NullSmsProvider } from './sms-provider.port';

/**
 * `GAP-11`, code side.
 *
 * WHAT THESE CASES CAN AND CANNOT PROVE, stated up front because the
 * distinction is the whole reason `GAP-11` stays open after this file passes.
 *
 * They CAN prove everything about the request this provider builds and the
 * response it interprets — because they run it against a REAL HTTP server that
 * either accepts what arrives or does not. The header, the body, the escaping,
 * the timeout, the status-code taxonomy, and the redaction rules are all
 * exercised against something that can genuinely disagree.
 *
 * They CANNOT prove that a particular Iranian gateway's field names are right,
 * because no vendor has been selected (`V3.1_PRODUCT_ROADMAP.md` §12) and no
 * credentials exist anywhere this project has run. That is what `GAP-11` is
 * still open for, and it is one live send away rather than a code change.
 *
 * The local server is not a mock of a gateway. It is a real server that
 * records what it received, which is what makes an assertion about the request
 * body mean something rather than restating the implementation.
 */
describe('HttpSmsProvider', () => {
  let server: Server;
  let baseUrl: string;
  let received: Array<{ method: string; headers: IncomingMessage['headers']; body: string }>;
  let respond: (res: ServerResponse) => void;
  let delayMs = 0;

  beforeAll(async () => {
    received = [];
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    };

    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({
          method: req.method ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        // `unref()` so the deliberately-slow response in the timeout case
        // cannot hold the jest worker open after the assertion has already
        // passed -- which it did, and which surfaces as "a worker process has
        // failed to exit gracefully" rather than as a failing test.
        if (delayMs > 0) setTimeout(() => respond(res), delayMs).unref();
        else respond(res);
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  beforeEach(() => {
    received = [];
    delayMs = 0;
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    };
  });

  function configFor(overrides: Partial<HttpSmsProviderConfig> = {}): HttpSmsProviderConfig {
    return {
      endpoint: `${baseUrl}/send`,
      method: 'POST',
      authHeader: 'apikey',
      authValue: 'secret-api-key',
      bodyTemplate: '{"receptor":"{{to}}","message":"{{text}}"}',
      contentType: 'application/json',
      timeoutMs: 2000,
      extraHeaders: {},
      ...overrides,
    };
  }

  describe('the request it actually sends', () => {
    it('carries the credential in the configured header and the recipient in the configured field', async () => {
      const provider = new HttpSmsProvider(configFor());
      const outcome = await provider.send('+989121234567', 'کد ورود شما ۱۲۳۴۵۶ است');

      expect(outcome).toEqual({ accepted: true, providerMessageId: null });
      expect(received).toHaveLength(1);
      expect(received[0].method).toBe('POST');
      expect(received[0].headers.apikey).toBe('secret-api-key');
      // Field NAMES come from the template, which is the whole point: a vendor
      // is a configuration change, not a class.
      expect(JSON.parse(received[0].body)).toEqual({
        receptor: '+989121234567',
        message: 'کد ورود شما ۱۲۳۴۵۶ است',
      });
    });

    it('sends extra headers verbatim, for a sender line or an account id', async () => {
      const provider = new HttpSmsProvider(configFor({ extraHeaders: { 'x-sender-line': '30001234' } }));
      await provider.send('+989121234567', 'سلام');
      expect(received[0].headers['x-sender-line']).toBe('30001234');
    });

    it('sends no body on GET, because fetch rejects one outright', async () => {
      const provider = new HttpSmsProvider(configFor({ method: 'GET' }));
      const outcome = await provider.send('+989121234567', 'سلام');
      expect(outcome.accepted).toBe(true);
      expect(received[0].body).toBe('');
    });
  });

  describe('escaping', () => {
    it('produces valid JSON when the message contains a quote', () => {
      // The realistic path here is not an attack: it is a template variable
      // that happens to contain a quotation mark, producing a malformed body
      // that the gateway rejects with an error nobody could attribute.
      const body = renderSmsBody('{"m":"{{text}}"}', '+98912', 'او گفت "سلام"', 'application/json');
      expect(() => JSON.parse(body)).not.toThrow();
      expect(JSON.parse(body).m).toBe('او گفت "سلام"');
    });

    it('percent-encodes for a form-encoded template', () => {
      const body = renderSmsBody('to={{to}}&text={{text}}', '+989121234567', 'a b&c', 'application/x-www-form-urlencoded');
      expect(body).toBe('to=%2B989121234567&text=a%20b%26c');
    });

    it('survives a newline in the message', () => {
      const body = renderSmsBody('{"m":"{{text}}"}', '+98912', 'خط اول\nخط دوم', 'application/json');
      expect(JSON.parse(body).m).toBe('خط اول\nخط دوم');
    });
  });

  describe('failure classification', () => {
    it('treats 4xx as permanent — a bad key will still be bad on the retry', async () => {
      respond = (res) => {
        res.writeHead(401);
        res.end('{"error":"invalid api key for +989121234567"}');
      };
      const outcome = await new HttpSmsProvider(configFor()).send('+989121234567', 'سلام');

      expect(outcome).toEqual({ accepted: false, errorCode: 'sms_http_401', retryable: false });
      // The gateway quoted the recipient's number back in its error. The code
      // carries the operational meaning; the body never leaves this function,
      // because it would otherwise land on the notification row, in the
      // `NotificationFailed` event, and in every log line downstream.
      expect(JSON.stringify(outcome)).not.toContain('989121234567');
    });

    it('treats 5xx and 429 as transient', async () => {
      for (const status of [500, 502, 429]) {
        respond = (res) => {
          res.writeHead(status);
          res.end('{}');
        };
        const outcome = await new HttpSmsProvider(configFor()).send('+989121234567', 'سلام');
        expect(outcome).toEqual({ accepted: false, errorCode: `sms_http_${status}`, retryable: true });
      }
    });

    it('times out rather than holding a worker forever', async () => {
      // A gateway that accepts the connection and never answers is the failure
      // a timeout exists for -- and without one the retry sweep keeps starting
      // new workers behind the stuck one.
      delayMs = 1_000;
      const outcome = await new HttpSmsProvider(configFor({ timeoutMs: 100 })).send('+989121234567', 'سلام');
      expect(outcome).toEqual({ accepted: false, errorCode: 'sms_timeout', retryable: true });
    });

    it('classifies an unreachable endpoint as transient', async () => {
      const outcome = await new HttpSmsProvider(
        // Port 1 is reserved and nothing listens on it.
        configFor({ endpoint: 'http://127.0.0.1:1/send' }),
      ).send('+989121234567', 'سلام');
      expect(outcome).toEqual({ accepted: false, errorCode: 'sms_transport_error', retryable: true });
    });
  });

  describe('configuration', () => {
    it('reports no provider unless every required value is present', () => {
      // Partial configuration is treated as none: an endpoint with no
      // credential produces a 401 on every OTP and a dead-letter queue full of
      // unauthenticated attempts, and the operator debugs delivery instead of
      // reading "no provider configured".
      expect(httpSmsConfigFromEnv({})).toBeNull();
      expect(httpSmsConfigFromEnv({ SMS_HTTP_ENDPOINT: 'https://x/send' })).toBeNull();
      expect(
        httpSmsConfigFromEnv({ SMS_HTTP_ENDPOINT: 'https://x/send', SMS_HTTP_AUTH_VALUE: 'k' }),
      ).toBeNull();
    });

    it('refuses a plaintext endpoint', () => {
      // The body carries a one-time login code and a phone number. "We will fix
      // the scheme later" is how that ships.
      expect(() =>
        httpSmsConfigFromEnv({
          SMS_HTTP_ENDPOINT: 'http://gateway.example/send',
          SMS_HTTP_AUTH_VALUE: 'k',
          SMS_HTTP_BODY_TEMPLATE: '{}',
        }),
      ).toThrow(/https/);
    });

    it('refuses a malformed extra-header map instead of dropping it', () => {
      expect(() =>
        httpSmsConfigFromEnv({
          SMS_HTTP_ENDPOINT: 'https://gateway.example/send',
          SMS_HTTP_AUTH_VALUE: 'k',
          SMS_HTTP_BODY_TEMPLATE: '{}',
          SMS_HTTP_EXTRA_HEADERS: 'not json',
        }),
      ).toThrow(/SMS_HTTP_EXTRA_HEADERS/);
    });

    it('accepts a complete configuration and defaults the optional parts', () => {
      const config = httpSmsConfigFromEnv({
        SMS_HTTP_ENDPOINT: 'https://gateway.example/send',
        SMS_HTTP_AUTH_VALUE: 'k',
        SMS_HTTP_BODY_TEMPLATE: '{"to":"{{to}}"}',
      });

      expect(config).toMatchObject({
        method: 'POST',
        authHeader: 'Authorization',
        contentType: 'application/json',
        timeoutMs: 8000,
      });
    });
  });

  describe('the null provider', () => {
    it('succeeds and declares that nothing left the building', async () => {
      const provider = new NullSmsProvider();
      // Both halves matter. Succeeding keeps the dead-letter queue from filling
      // with messages that were never meant to be sent; declaring
      // `deliversExternally: false` is what stops an unconfigured environment
      // being indistinguishable from a delivering one on `/health`.
      expect(provider.deliversExternally).toBe(false);
      await expect(provider.send()).resolves.toEqual({ accepted: true, providerMessageId: null });
    });
  });
});
