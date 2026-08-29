/**
 * Redaction for anything on its way out of the process (V3.1 Phase F).
 *
 * `V3_INFRASTRUCTURE_PLAN.md` §8 asks for structured JSON logs from every
 * process, correlation-ID-tagged, shipped somewhere central. That last clause
 * is why this file exists before the logger does.
 *
 * A log aggregator is a SECOND COPY of whatever you put in it, held for
 * months, searchable by more people than can read the database, and outside
 * every access control this platform enforces. `financial.ledger_entries` is
 * append-only by grant; a log line quoting a ledger row is not. `otp_codes`
 * stores an HMAC and never the plaintext; a log line carrying the code a
 * customer just typed is plaintext, retained.
 *
 * The existing `AuditLogger` already refuses objects at the TYPE level --
 * `AuditField` cannot express one, which stops an entity being spread in
 * wholesale. That works because every call site is hand-written. It cannot
 * help with what this file has to survive: a thrown error's `message` built by
 * a library from data it was given, a stack trace, a `QueryFailedError` that
 * embeds the failing SQL and its bound parameters, or an HTTP client error
 * that quotes the request headers back.
 *
 * So redaction is two rules, applied together:
 *
 *  1. **By KEY.** A field named `password`, `token`, `secret`, `otp`, or
 *     `authorization` is replaced regardless of what it holds. Cheap, total,
 *     and it catches the structured cases.
 *  2. **By VALUE SHAPE.** Free text is scanned for the shapes this platform
 *     actually emits -- a JWT, a `postgres://user:pass@host` URL, a `Bearer`
 *     header, an Iranian phone number, a long hex/base64 credential. This is
 *     what catches the error MESSAGE, which no key-based rule can reach.
 *
 * Neither rule alone is sufficient and both are deliberately blunt. A redacted
 * log line that was over-cautious costs an engineer one extra query; a log
 * line carrying a live token costs a rotation and an incident.
 */

/** What replaces a redacted value. Fixed, so it is greppable in an aggregator. */
export const REDACTED = '[redacted]';

/**
 * Field names whose VALUE is never logged, whatever it contains.
 *
 * Matched as a case-insensitive substring of the key, so `jwtAccessSecret`,
 * `JWT_ACCESS_SECRET`, and `secret` are all caught by one entry. Substring
 * matching produces false positives -- `secretaryName` would be redacted --
 * and that is the correct trade here.
 */
const FORBIDDEN_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'apikey',
  'api_key',
  'credential',
  'otp',
  'code', // OTP codes, and gateway codes that may embed a reference
  'cookie',
  'session',
  'merchant',
  'pan',
  'cvv',
  'iban',
  'card',
  'phone',
  'mobile',
  'email',
  'nationalid',
  'national_id',
];

/**
 * Value shapes that must never appear in a log line, wherever they turn up.
 *
 * Ordered longest-match-first where two could overlap, because replacement is
 * sequential and a shorter pattern firing first would leave the tail of a
 * longer secret in place.
 */
const FORBIDDEN_VALUE_PATTERNS: readonly RegExp[] = [
  // A connection string with credentials. `QueryFailedError` and every pg
  // connection error quote one.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/gi,
  // A JWT. Three base64url segments. This platform's access tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // An Authorization header value, quoted back by many HTTP clients.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // An Iranian mobile number, in the shapes this platform stores and receives.
  /(\+98|0098|98|0)9\d{9}\b/g,
  // A long opaque credential: 32+ hex or base64-ish characters with no spaces.
  // Deliberately last, and deliberately long enough not to eat a UUID (36
  // characters WITH hyphens, which this does not match) or an order id.
  /\b[A-Fa-f0-9]{32,}\b/g,
];

function keyIsForbidden(key: string): boolean {
  const lowered = key.toLowerCase();
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) => lowered.includes(fragment));
}

/**
 * Redacts secret-shaped substrings from free text.
 *
 * Exported because it is the half that matters for error messages and stack
 * traces, which arrive as one string and cannot be filtered by key.
 */
export function redactText(value: string): string {
  let out = value;
  for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
    // `lastIndex` is reset because these are module-level /g regexes, and a
    // stateful regex reused across calls silently skips matches -- a bug that
    // would make redaction intermittent, which is worse than absent.
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Redacts a structured record, recursively.
 *
 * `depth` bounds the walk. A TypeORM entity carries lazy relations and
 * circular parent/child references, and an unbounded walk over one either
 * never terminates or serialises the whole object graph into a log line. The
 * bound is a truncation marker rather than a throw: a log call must never be
 * the thing that fails a request.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated: too deep]';

  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  // A function or a symbol in a log record is a mistake, not data.
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      // The stack is kept -- it is the single most useful field in an error
      // log -- but redacted, because a stack frame's arguments and a nested
      // `caused by` message routinely carry the value that caused the failure.
      stack: value.stack ? redactText(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    // Bounded for the same reason as depth: a 10,000-row result set in a log
    // line is a denial of service against the aggregator, not a diagnostic.
    const limited = value.slice(0, 50).map((item) => redact(item, depth + 1));
    return value.length > 50 ? [...limited, `[${value.length - 50} more]`] : limited;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = keyIsForbidden(key) ? REDACTED : redact(item, depth + 1);
    }
    return out;
  }

  return String(value);
}
