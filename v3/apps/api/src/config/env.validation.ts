/**
 * Boot-time environment validation.
 *
 * The original version of this file checked three variables for presence and
 * called it production validation. That is genuinely better than nothing --
 * "discovered missing at first request" is the failure mode it was written
 * against -- but presence is the weakest property a production configuration
 * has, and the deployments this platform is heading towards fail in ways
 * presence cannot see:
 *
 *  - a `.env` copied from a developer's machine, carrying `dev-only-insecure-
 *    secret-override-in-env` verbatim, because that string is what the code
 *    itself falls back to;
 *  - `PAYMENT_ENVIRONMENT=sandbox` on a production host -- a SANDBOX PRESENTED
 *    AS PRODUCTION, which is the exact hazard the two-condition gate on
 *    `SandboxPaymentProvider` exists to make impossible, arriving through
 *    configuration instead of code;
 *  - `CORS_ALLOWED_ORIGINS=*`, which hands any site on the internet the
 *    ability to drive this API with a signed-in user's browser;
 *  - `PUBLIC_API_BASE_URL=http://...`, which puts the gateway callback and
 *    every media token on a plaintext hop;
 *  - one secret reused for two purposes, so a leak of either is a leak of both.
 *
 * None of those is exotic. Each is one wrong line in a file, each boots
 * happily today, and each is invisible until something has already gone wrong.
 *
 * ## Three rules this file follows
 *
 * **1. Fail closed, in production only.** Every rule below is production-
 * scoped unless its comment says otherwise. A development machine must keep
 * booting with nothing configured -- that is what makes people run the real
 * application locally instead of only the tests.
 *
 * **2. Report EVERY failure at once.** An operator who fixes one variable,
 * redeploys, and discovers the next one is doing five deploys where one would
 * do -- and each of those deploys is a production outage window if this runs
 * on a host that has already taken the old process down. The errors are
 * collected and thrown together.
 *
 * **3. Never echo a value.** The messages name the VARIABLE and the RULE it
 * broke, never what it contained. A boot failure lands in a log aggregator, a
 * CI transcript, and an operator's terminal scrollback; a secret printed into
 * any of those is a secret that has to be rotated. This is asserted in the
 * suite, not merely intended.
 *
 * ## What this does NOT do
 *
 * It does not make the platform production-ready, and it must not be read as
 * evidence of that. It refuses a configuration that is visibly wrong; nothing
 * here can tell whether `PAYMENT_DEFAULT_PROVIDER` names an adapter that has
 * ever settled real money, whether the SMS credential delivers, or whether the
 * host exists. Those are the External Enablement Gate's, and they stay open.
 */

export interface AppEnv {
  NODE_ENV: string;
  PORT: number;
  DATABASE_URL?: string;
  JWT_ACCESS_SECRET?: string;
  OTP_HMAC_SECRET?: string;
}

type Env = Record<string, unknown>;

/** Reads a variable as a trimmed string; empty and whitespace-only are absent. */
function read(config: Env, key: string): string | null {
  const raw = config[key];
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  return value === '' ? null : value;
}

// ---------------------------------------------------------------------------
// The secret contract
// ---------------------------------------------------------------------------

/**
 * Every secret this application reads, what it protects, and whether
 * production may boot without it.
 *
 * Written down as DATA rather than prose because a list in a document drifts
 * from the code that reads it, and because this table is what the readiness
 * surface and the deployment runbook are both derived from. A secret that is
 * not here is a secret nobody has decided how to handle.
 *
 * No value is stored here, ever. This names variables.
 */
export interface SecretContractEntry {
  readonly name: string;
  /** What an attacker gets by learning it. */
  readonly protects: string;
  readonly requiredInProduction: boolean;
  /** Minimum length, where a short value is itself a vulnerability. */
  readonly minLength?: number;
}

export const SECRET_CONTRACT: readonly SecretContractEntry[] = [
  {
    name: 'DATABASE_URL',
    protects: 'the whole application database, as the application role',
    requiredInProduction: true,
  },
  {
    name: 'FINANCIAL_DATABASE_URL',
    protects: 'the append-only financial ledger, as the INSERT+SELECT writer role (ADR-017)',
    requiredInProduction: true,
  },
  {
    name: 'JWT_ACCESS_SECRET',
    protects: 'every access token; forging one is impersonating any user, including an admin',
    requiredInProduction: true,
    minLength: 32,
  },
  {
    name: 'OTP_HMAC_SECRET',
    protects: 'stored OTP hashes; learning it turns the OTP table into plaintext login codes',
    requiredInProduction: true,
    minLength: 32,
  },
  {
    name: 'MEDIA_UPLOAD_TOKEN_SECRET',
    protects: 'upload authorization tokens. Falls back to JWT_ACCESS_SECRET when unset',
    requiredInProduction: false,
    minLength: 32,
  },
  {
    name: 'MEDIA_DOWNLOAD_TOKEN_SECRET',
    protects: 'protected-file download tokens, including identity documents. Falls back to JWT_ACCESS_SECRET',
    requiredInProduction: false,
    minLength: 32,
  },
  {
    name: 'MEDIA_S3_SECRET_ACCESS_KEY',
    protects: 'the object-storage bucket holding portfolio media and verification documents',
    requiredInProduction: false, // required only when the s3 driver is selected; see below
    minLength: 16,
  },
  {
    name: 'SMS_HTTP_AUTH_VALUE',
    protects: 'the SMS gateway account that sends every login code',
    requiredInProduction: false, // GAP-11: no vendor selected. EXTERNAL.
  },
] as const;

/**
 * Values that must never appear in production, whatever variable holds them.
 *
 * Two sources: the fallbacks this codebase itself hardcodes for development
 * (`app.module.ts` and `media.service.ts` both fall back to
 * `dev-only-insecure-secret-override-in-env`), and the placeholder vocabulary
 * that ends up in a hastily-filled `.env`. Compared case-insensitively against
 * the whole value and as a substring, because `dev-only-...-1` is the same
 * mistake with a suffix.
 */
const FORBIDDEN_SECRET_FRAGMENTS = [
  'dev-only',
  'insecure',
  'changeme',
  'change-me',
  'placeholder',
  'your-secret',
  'yoursecret',
  'example',
  'password',
  'secret123',
  'todo',
  'xxxx',
];

/**
 * The part of a variable that is actually the secret.
 *
 * A connection string is not an opaque credential -- it is a URL whose
 * PASSWORD component is the credential and whose host, database name, and
 * options are not. Scanning the whole string for placeholder vocabulary is
 * therefore both too strict and too loose: it would refuse a perfectly good
 * `postgres://app:<real>@db.example-corp.internal/beauclick` for the word in
 * its hostname, and it teaches operators that this check produces noise, which
 * is how a real finding gets waved through.
 *
 * Anything that does not parse as a URL is scanned whole, because then it IS
 * the secret.
 */
function secretPortionOf(value: string): string {
  try {
    const url = new URL(value);
    // A URL with no credential has nothing to scan; returning the empty string
    // is correct, not a miss.
    return url.password || url.username || '';
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function checkSecrets(config: Env, errors: string[]): void {
  const s3Selected = (read(config, 'MEDIA_STORAGE_DRIVER') ?? 'local').toLowerCase() === 's3';
  const seen = new Map<string, string[]>();

  for (const entry of SECRET_CONTRACT) {
    const value = read(config, entry.name);
    const required = entry.requiredInProduction || (s3Selected && entry.name.startsWith('MEDIA_S3_'));

    if (value === null) {
      if (required) errors.push(`${entry.name} is required in production — it protects ${entry.protects}.`);
      continue;
    }

    if (entry.minLength !== undefined && value.length < entry.minLength) {
      // The LENGTH is reported, not the value: it is the fact that failed and
      // it is not itself a secret.
      errors.push(
        `${entry.name} is ${value.length} characters; at least ${entry.minLength} are required. It protects ${entry.protects}.`,
      );
    }

    const lowered = secretPortionOf(value).toLowerCase();
    const matched = FORBIDDEN_SECRET_FRAGMENTS.find((fragment) => lowered.includes(fragment));
    if (matched) {
      errors.push(
        `${entry.name} contains the placeholder text "${matched}", so it is a development or template value rather than a real secret.`,
      );
    }

    // Reuse detection. Grouped by value so the message can name the SET of
    // variables sharing one secret without printing the secret.
    const group = seen.get(value);
    if (group) group.push(entry.name);
    else seen.set(value, [entry.name]);
  }

  for (const names of seen.values()) {
    if (names.length > 1) {
      // A shared key means one leak compromises every purpose that key serves,
      // and rotating for one forces rotating for all. Explicitly EXCLUDED from
      // this rule are the media secrets' documented fallback to
      // JWT_ACCESS_SECRET when UNSET -- that is an absent variable, not two
      // variables set to the same string, and this loop only sees what is set.
      errors.push(`These share one secret value and must not: ${names.join(', ')}. One leak would compromise all of them.`);
    }
  }
}

function checkPublicUrls(config: Env, errors: string[]): void {
  for (const key of ['PUBLIC_API_BASE_URL', 'PUBLIC_WEB_BASE_URL']) {
    const value = read(config, key);
    if (value === null) {
      errors.push(
        `${key} is required in production. It builds the gateway callback URL and the customer's post-payment return; a wrong or missing value strands payments.`,
      );
      continue;
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      errors.push(`${key} is not an absolute URL.`);
      continue;
    }
    if (url.protocol !== 'https:') {
      errors.push(
        `${key} must be https in production. The gateway callback and every media token travel through it, and plaintext hands both to anything on the path.`,
      );
    }
  }
}

function checkCors(config: Env, errors: string[]): void {
  const value = read(config, 'CORS_ALLOWED_ORIGINS');
  if (value === null) {
    errors.push('CORS_ALLOWED_ORIGINS is required in production. Unset, the API falls back to a localhost origin and the real frontend cannot call it.');
    return;
  }

  const origins = value.split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.length === 0) {
    errors.push('CORS_ALLOWED_ORIGINS is set but lists no origins.');
    return;
  }

  for (const origin of origins) {
    if (origin === '*') {
      // `main.ts` passes this list straight to `enableCors` with
      // `credentials: true`. A wildcard there lets any site on the internet
      // drive this API with a signed-in user's browser.
      errors.push('CORS_ALLOWED_ORIGINS must not contain "*". With credentials enabled, a wildcard lets any site drive this API as a signed-in user.');
      continue;
    }
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      errors.push(`CORS_ALLOWED_ORIGINS contains "${origin}", which is not a valid origin.`);
      continue;
    }
    if (url.protocol !== 'https:') {
      errors.push(`CORS_ALLOWED_ORIGINS contains a non-https origin "${origin}".`);
    }
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') {
      errors.push(`CORS_ALLOWED_ORIGINS contains the loopback origin "${origin}", which is a development value.`);
    }
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      // An "origin" with a path never matches anything the browser sends, so
      // every cross-origin request fails at preflight with no explanation.
      errors.push(`CORS_ALLOWED_ORIGINS entry "${origin}" carries a path or query. An origin is scheme://host[:port] only.`);
    }
  }
}

/**
 * The sandbox-presented-as-production check.
 *
 * `SandboxPaymentProvider.isEnabled()` already refuses to serve under
 * `NODE_ENV=production`, with no override, and that gate is load-bearing for
 * `EXC-001` and is not weakened here. What it does NOT do is tell anybody. A
 * production deployment carrying `PAYMENT_ENVIRONMENT=sandbox` boots, serves
 * every other route, and fails only when a customer reaches checkout -- with a
 * Persian 503 that reads like a transient gateway problem.
 *
 * So the same fact is refused twice, at two different times, for two different
 * reasons: the provider gate stops a sandbox from taking real money, and this
 * stops a deployment that thinks it can from starting at all.
 */
function checkPaymentEnvironment(config: Env, errors: string[]): void {
  const paymentEnvironment = (read(config, 'PAYMENT_ENVIRONMENT') ?? 'sandbox').toLowerCase();
  if (paymentEnvironment !== 'production') {
    errors.push(
      `PAYMENT_ENVIRONMENT must be "production" when NODE_ENV=production (currently "${paymentEnvironment}"). ` +
        'The sandbox gateway is refused under NODE_ENV=production regardless, so this deployment could not take a payment at all.',
    );
  }

  const provider = read(config, 'PAYMENT_DEFAULT_PROVIDER');
  if (provider === null) {
    errors.push(
      'PAYMENT_DEFAULT_PROVIDER is required in production. The registry refuses to guess a gateway rather than letting import order decide which one takes money.',
    );
  } else if (provider.toLowerCase() === 'sandbox') {
    errors.push(
      'PAYMENT_DEFAULT_PROVIDER=sandbox is refused in production. The sandbox is a simulated bank and is disabled under NODE_ENV=production; naming it here means no payment can complete.',
    );
  }
}

function checkStorage(config: Env, errors: string[]): void {
  const driver = (read(config, 'MEDIA_STORAGE_DRIVER') ?? 'local').toLowerCase();

  if (driver === 'local') {
    // Mirrors `MediaModule`'s own refusal, deliberately duplicated: running
    // here means it is reported ALONGSIDE every other configuration error
    // rather than being the one that happens to throw first. The documented
    // escape hatch is honoured, because accepting the consequence knowingly is
    // a decision this file has no standing to overrule.
    if (read(config, 'MEDIA_ALLOW_LOCAL_DRIVER_IN_PRODUCTION') !== 'true') {
      errors.push(
        'MEDIA_STORAGE_DRIVER=local is refused in production: portfolio images and identity documents would live on one container\'s own disk and vanish with it. Set MEDIA_STORAGE_DRIVER=s3, or MEDIA_ALLOW_LOCAL_DRIVER_IN_PRODUCTION=true to accept that deliberately.',
      );
    }
    return;
  }

  if (driver !== 's3') {
    errors.push(`MEDIA_STORAGE_DRIVER "${driver}" is not a known driver. Valid values: local, s3.`);
    return;
  }

  // Half-configured object storage fails at the first upload, not at boot --
  // which in practice means it fails for a professional submitting a
  // verification document, not for the operator who deployed it.
  for (const key of ['MEDIA_S3_ACCESS_KEY_ID', 'MEDIA_S3_ENDPOINT', 'MEDIA_S3_BUCKET']) {
    if (read(config, key) === null) errors.push(`${key} is required when MEDIA_STORAGE_DRIVER=s3.`);
  }
  const endpoint = read(config, 'MEDIA_S3_ENDPOINT');
  if (endpoint !== null && !endpoint.startsWith('https://')) {
    errors.push('MEDIA_S3_ENDPOINT must be https in production: the request carries the storage credential in a signed header.');
  }
}

function checkSearch(config: Env, errors: string[]): void {
  // `SearchModule` refuses to bind the in-memory engine in production for the
  // same reason. Reported here too, so it joins the collected list.
  if (read(config, 'OPENSEARCH_URL') === null) {
    errors.push(
      'OPENSEARCH_URL is required in production. Without it the in-memory engine would serve an empty marketplace with no visible error (ADR-021).',
    );
  }
}

function checkDevelopmentSeams(config: Env, errors: string[]): void {
  // Both are already inert under NODE_ENV=production. Their PRESENCE is still
  // refused, because a production environment carrying a QA-login flag is a
  // production environment that was copied from a development one -- and the
  // next variable copied along with it may not have a gate of its own.
  if (read(config, 'DEV_QA_LOGIN') !== null) {
    errors.push('DEV_QA_LOGIN must not be present in production. It is inert here, but its presence means this configuration was copied from a development environment.');
  }
  if (read(config, 'DISABLE_BACKGROUND_SWEEPS') === 'true') {
    errors.push(
      'DISABLE_BACKGROUND_SWEEPS=true is refused in production. The outbox sweep is the durability guarantee behind every event; without it an unpublished row is never retried.',
    );
  }
}

/**
 * Applies in EVERY environment, not only production.
 *
 * `.env.example` has claimed since Phase 3 that "the config validator refuses
 * to boot on the invalid combination" of cookie settings. No such validator
 * existed. `cookieSettingsFromEnv` does throw for `none` without `secure`
 * outside production, and production forces `secure: true` so the dangerous
 * pair cannot occur there -- but an unrecognised `AUTH_COOKIE_SAMESITE` was
 * cast straight through to the `Set-Cookie` header, where a browser ignores
 * the attribute and silently applies its own default. A typo therefore changed
 * the cookie's cross-site behaviour with nothing anywhere reporting it.
 */
function checkCookiePolicy(config: Env, errors: string[]): void {
  const sameSite = read(config, 'AUTH_COOKIE_SAMESITE');
  if (sameSite !== null && !['lax', 'strict', 'none'].includes(sameSite.toLowerCase())) {
    errors.push(`AUTH_COOKIE_SAMESITE must be one of lax, strict, none (received "${sameSite}").`);
  }
  const secure = read(config, 'AUTH_COOKIE_SECURE');
  if (secure !== null && !['true', 'false'].includes(secure.toLowerCase())) {
    errors.push(`AUTH_COOKIE_SECURE must be "true" or "false" (received "${secure}").`);
  }
  if (sameSite?.toLowerCase() === 'none' && secure?.toLowerCase() !== 'true') {
    errors.push('AUTH_COOKIE_SAMESITE=none requires AUTH_COOKIE_SECURE=true. A SameSite=None cookie without Secure is dropped by every modern browser.');
  }
}

// ---------------------------------------------------------------------------

/**
 * The production rule set, exported so the readiness surface and the suite can
 * ask "would this configuration boot in production?" without setting
 * `NODE_ENV` and restarting a process.
 *
 * Returns every failure. An empty array means every rule passed -- which is
 * NOT the same as production-ready, and the readiness surface says so.
 */
export function productionConfigurationErrors(config: Env): string[] {
  const errors: string[] = [];
  checkSecrets(config, errors);
  checkPublicUrls(config, errors);
  checkCors(config, errors);
  checkPaymentEnvironment(config, errors);
  checkStorage(config, errors);
  checkSearch(config, errors);
  checkDevelopmentSeams(config, errors);
  return errors;
}

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  // Compared EXACTLY, never lowercased. Every gate in this codebase --
  // `SandboxPaymentProvider.isEnabled`, `MediaModule`'s local-driver refusal,
  // the financial datasource requirement, `SearchModule`'s OpenSearch
  // requirement -- tests `NODE_ENV === 'production'`. Normalising here would
  // make `NODE_ENV=Production` run the production RULES below while the
  // sandbox gateway, the container-disk media driver, and the in-memory search
  // engine all stayed enabled: a deployment that passed validation and was
  // still a development environment wearing a production label. The only safe
  // treatment of a value the rest of the system will not recognise is to
  // refuse it.
  const nodeEnv = read(config, 'NODE_ENV') ?? 'development';

  const errors: string[] = [];

  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    errors.push(`NODE_ENV must be exactly one of development, test, production (received "${nodeEnv}").`);
  }

  checkCookiePolicy(config, errors);

  if (nodeEnv === 'production') errors.push(...productionConfigurationErrors(config));

  if (errors.length > 0) {
    throw new Error(
      `Refusing to start: ${errors.length} environment configuration ${errors.length === 1 ? 'problem' : 'problems'}.\n` +
        errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n'),
    );
  }

  return config;
}
