/**
 * V3_EVENT_CATALOG.md's contract, expressed as a type instead of prose.
 *
 * Every V3 domain event carries a name, an explicit integer version, the
 * aggregate it is about, and a payload -- so a consumer can never be
 * "accidentally compatible" with a producer that changed shape.
 */
export interface EventEnvelope<TPayload = Record<string, unknown>> {
  /** UUIDv7 -- also the natural dedupe key for a consumer that wants one. */
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: TPayload;
  occurredAt: Date;
}

/**
 * Structural enforcement of the event catalog's single hardest rule:
 *
 *   "NEVER include: OTP codes, passwords, refresh tokens, payment secrets."
 *
 * V2's own catalog note is emphatic that `beauclick/auth/otp_generated`
 * must never become a persisted event. A comment does not enforce that; a
 * throw does. Every outbox write goes through this check, so a payload
 * carrying a forbidden key fails at the write, in the producing
 * transaction, rather than being discovered later in a log aggregator.
 *
 * Deliberately a DENY-list of exact key names rather than a heuristic
 * substring match: `providerReference` and `paymentIntentId` are legitimate
 * and necessary payload fields, and a naive /token|secret/ substring rule
 * would reject them and push authors toward disabling the check entirely.
 */
const FORBIDDEN_PAYLOAD_KEYS = new Set(
  [
    'code',
    'otp',
    'otpCode',
    'codeHash',
    'password',
    'passwordHash',
    'token',
    'accessToken',
    'refreshToken',
    'tokenHash',
    'secret',
    'apiKey',
    'merchantId',
    'cardNumber',
    'pan',
    'cvv',
    'authorization',
  ].map((k) => k.toLowerCase()),
);

export class ForbiddenEventPayloadError extends Error {
  constructor(key: string, path: string) {
    super(
      `Event payload contains forbidden key "${key}" at ${path}. ` +
        'Credentials, OTP codes, tokens, and payment secrets must never enter an event payload (V3_EVENT_CATALOG.md).',
    );
  }
}

/** Recursive, depth-bounded. Arrays and nested objects are inspected too -- a secret one level down is still a secret. */
export function assertPayloadHasNoSecrets(payload: unknown, path = 'payload', depth = 0): void {
  if (depth > 8 || payload === null || typeof payload !== 'object') return;

  if (Array.isArray(payload)) {
    payload.forEach((item, i) => assertPayloadHasNoSecrets(item, `${path}[${i}]`, depth + 1));
    return;
  }

  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
      throw new ForbiddenEventPayloadError(key, path);
    }
    assertPayloadHasNoSecrets(value, `${path}.${key}`, depth + 1);
  }
}
