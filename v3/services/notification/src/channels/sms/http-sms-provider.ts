import { Logger } from '@nestjs/common';

import { SmsProvider, SmsSendOutcome } from './sms-provider.port';

/**
 * Everything a deployment must supply to make SMS real.
 *
 * Deliberately describes a REQUEST rather than a vendor. Every Iranian SMS
 * gateway this platform might use -- and the choice is open
 * (`V3.1_PRODUCT_ROADMAP.md` §12) -- accepts an HTTP request with an API key
 * and a JSON or form body naming a recipient and a message. What differs is
 * the URL, the header name, and the field names, which are exactly the three
 * things below.
 *
 * So selecting a vendor becomes configuration plus one live send, not a code
 * change. That is the same bet `ObjectStorageDriver` and `PaymentProvider`
 * already make, and it is why neither of those blocked on a vendor either.
 */
export interface HttpSmsProviderConfig {
  /** Absolute https URL. */
  readonly endpoint: string;
  readonly method: 'POST' | 'GET';
  /** e.g. `Authorization` / `apikey`. The VALUE lives in `authValue` and is never logged. */
  readonly authHeader: string;
  readonly authValue: string;
  /**
   * The request body, with `{{to}}` and `{{text}}` placeholders.
   *
   * A template rather than a fixed shape because the field names are the part
   * that differs per vendor -- `{"receptor":"{{to}}","message":"{{text}}"}` for
   * one, `{"mobile":"{{to}}","text":"{{text}}"}` for another.
   */
  readonly bodyTemplate: string;
  readonly contentType: string;
  readonly timeoutMs: number;
  /** Optional extra headers, e.g. a sender-line id. Values are never logged. */
  readonly extraHeaders: Readonly<Record<string, string>>;
}

/**
 * Reads the configuration, or reports that there is none.
 *
 * Returns `null` unless EVERY required value is present. Partial
 * configuration is treated as no configuration, deliberately: an endpoint with
 * no credential would produce a 401 on every OTP and a dead-letter queue full
 * of unauthenticated attempts, and the operator would be debugging delivery
 * rather than reading "no provider configured".
 */
export function httpSmsConfigFromEnv(env: NodeJS.ProcessEnv): HttpSmsProviderConfig | null {
  const endpoint = env.SMS_HTTP_ENDPOINT?.trim();
  const authValue = env.SMS_HTTP_AUTH_VALUE?.trim();
  const bodyTemplate = env.SMS_HTTP_BODY_TEMPLATE?.trim();
  if (!endpoint || !authValue || !bodyTemplate) return null;

  // An https-only rule, enforced rather than recommended. The body of this
  // request carries a one-time login code and a phone number; sending it over
  // plaintext http would hand both to anyone on the path, and "we will fix the
  // scheme later" is how that ships.
  if (!endpoint.startsWith('https://')) {
    throw new Error(
      'SMS_HTTP_ENDPOINT must be https. An SMS request body carries a login code and a phone number in plaintext otherwise.',
    );
  }

  const timeoutMs = Number(env.SMS_HTTP_TIMEOUT_MS ?? 8000);

  let extraHeaders: Record<string, string> = {};
  if (env.SMS_HTTP_EXTRA_HEADERS) {
    try {
      const parsed: unknown = JSON.parse(env.SMS_HTTP_EXTRA_HEADERS);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        extraHeaders = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        );
      }
    } catch {
      // Thrown, not swallowed: a malformed header map means the sender line or
      // some other required field is silently missing, and every message would
      // be rejected by the gateway for a reason nothing here would explain.
      throw new Error('SMS_HTTP_EXTRA_HEADERS is not valid JSON object.');
    }
  }

  return {
    endpoint,
    method: env.SMS_HTTP_METHOD === 'GET' ? 'GET' : 'POST',
    authHeader: env.SMS_HTTP_AUTH_HEADER?.trim() || 'Authorization',
    authValue,
    bodyTemplate,
    contentType: env.SMS_HTTP_CONTENT_TYPE?.trim() || 'application/json',
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000,
    extraHeaders,
  };
}

/**
 * Substitutes `{{to}}` and `{{text}}` into the body template.
 *
 * Exported and pure so the escaping can be tested directly, because the
 * escaping is the part that matters: a Persian OTP message contains no quotes
 * today, but a template is a JSON document being assembled by string
 * substitution, and a message body containing a `"` would produce a malformed
 * request that the gateway rejects with an error nobody could attribute.
 *
 * `JSON.stringify` on each value and then trimming the quotes it adds is the
 * correct escape for a JSON template; for a form-encoded one, percent-encoding
 * is. The content type decides, which is why it is a parameter.
 */
export function renderSmsBody(template: string, to: string, text: string, contentType: string): string {
  const isJson = contentType.includes('json');
  const escape = (value: string): string =>
    isJson ? JSON.stringify(value).slice(1, -1) : encodeURIComponent(value);

  return template.replaceAll('{{to}}', escape(to)).replaceAll('{{text}}', escape(text));
}

/**
 * A configurable HTTP SMS provider.
 *
 * `deliversExternally` is TRUE: a configured instance genuinely transmits to
 * an external network. That is not the same as `GAP-11` being closed -- the
 * gap asks for a provider exercised against a REAL vendor API, and no vendor
 * has been selected. What this class removes is the code-shaped half of the
 * gap. The phase report states the split rather than letting a green suite
 * imply more than it proved.
 *
 * Every failure below returns a stable code and never the response body.
 * A gateway's error text routinely quotes the recipient's number back, and
 * that string would otherwise flow into the notification row, the
 * `NotificationFailed` event, and every log line downstream.
 */
export class HttpSmsProvider implements SmsProvider {
  readonly key = 'http';
  readonly deliversExternally = true;

  private readonly logger = new Logger('HttpSmsProvider');

  constructor(private readonly config: HttpSmsProviderConfig) {}

  async send(to: string, text: string): Promise<SmsSendOutcome> {
    const body = renderSmsBody(this.config.bodyTemplate, to, text, this.config.contentType);

    // A timeout is mandatory, not defensive. Without one a gateway that
    // accepts the connection and never answers holds a notification worker
    // until the process dies -- and the retry sweep would keep starting new
    // ones behind it.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(this.config.endpoint, {
        method: this.config.method,
        headers: {
          'content-type': this.config.contentType,
          [this.config.authHeader]: this.config.authValue,
          ...this.config.extraHeaders,
        },
        // A GET provider carries its parameters in the configured endpoint's
        // query string; `fetch` rejects a GET with a body outright.
        body: this.config.method === 'GET' ? undefined : body,
        signal: abort.signal,
      });

      if (response.ok) return { accepted: true, providerMessageId: null };

      // The status code decides retryability, and the split is the one that
      // matters operationally: 4xx means the request was wrong and will be
      // wrong again -- a bad key, a malformed number, an exhausted quota --
      // while 5xx and 429 are the gateway having a moment.
      const retryable = response.status >= 500 || response.status === 429;
      return { accepted: false, errorCode: `sms_http_${response.status}`, retryable };
    } catch (error) {
      const aborted = (error as Error)?.name === 'AbortError';
      // The message is logged WITHOUT the recipient or the body. A transport
      // error's text can contain the resolved host and port, which is
      // operationally useful and carries no personal data.
      this.logger.warn(`SMS transport failure: ${aborted ? 'timeout' : (error as Error).message}`);
      return {
        accepted: false,
        errorCode: aborted ? 'sms_timeout' : 'sms_transport_error',
        // Both are transient by nature: a timeout and a connection reset are
        // exactly the failures a retry exists for.
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
