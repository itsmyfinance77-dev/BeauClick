import { SECRET_CONTRACT, productionConfigurationErrors, validateEnv } from './env.validation';

/**
 * Production environment validation (V3.1 Phase F).
 *
 * Two properties matter more than any individual rule and are asserted
 * directly rather than left to inspection:
 *
 *  1. **A development configuration cannot boot as production.** Every case in
 *     `refuses` starts from a configuration that WOULD boot -- so each one
 *     isolates exactly the mistake it names, rather than passing because
 *     something else was also missing.
 *  2. **No message ever contains a secret.** A boot failure lands in a log
 *     aggregator, a CI transcript, and an operator's scrollback. A secret
 *     printed into any of those has to be rotated.
 */

/** A configuration that passes every production rule. The baseline for the negative cases. */
function validProduction(overrides: Record<string, string | undefined> = {}): Record<string, unknown> {
  const base: Record<string, string> = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://app:9Kd2mQx7vRt4wZp1@db.internal:5432/beauclick',
    FINANCIAL_DATABASE_URL: 'postgres://fin:3Ln8bYc5tWq2eXr6@db.internal:5432/beauclick',
    JWT_ACCESS_SECRET: 'Zk4Rr9Tq2Lm7Wx1Vb6Nc3Hs8Jd5Fg0Py',
    OTP_HMAC_SECRET: 'Qw3Er7Ty1Ui9Op5As2Df8Gh4Jk6Lz0Xc',
    // V3.3-A Story #69. A DEDICATED value, sharing with nothing above -- the
    // baseline must not itself be an example of the reuse the rule refuses.
    WORKSPACE_REFERENCE_HMAC_SECRET: 'Mn6Bv4Cx2Zl8Ka5Sd1Fj7Gh3Rt9Yu0Iq',
    PUBLIC_API_BASE_URL: 'https://api.beauclick.example/api',
    PUBLIC_WEB_BASE_URL: 'https://beauclick.example',
    CORS_ALLOWED_ORIGINS: 'https://beauclick.example',
    OPENSEARCH_URL: 'https://search.internal:9200',
    PAYMENT_ENVIRONMENT: 'production',
    PAYMENT_DEFAULT_PROVIDER: 'some-selected-gateway',
    MEDIA_STORAGE_DRIVER: 's3',
    MEDIA_S3_ACCESS_KEY_ID: 'AK5RQ2LM7WX1VB6N',
    MEDIA_S3_SECRET_ACCESS_KEY: 'b7Yc5tWq2eXr6Zk4Rr9Tq2Lm7Wx1Vb6N',
    MEDIA_S3_ENDPOINT: 'https://objects.example',
    MEDIA_S3_BUCKET: 'beauclick-media',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

/** Every secret VALUE the baseline uses, so no message may contain any of them. */
const SECRET_VALUES = Object.values(validProduction()).filter(
  (v): v is string => typeof v === 'string' && /[0-9]/.test(v) && v.length >= 16,
);

describe('validateEnv', () => {
  it('accepts a fully configured production environment', () => {
    expect(() => validateEnv(validProduction())).not.toThrow();
    expect(productionConfigurationErrors(validProduction())).toEqual([]);
  });

  it('leaves development and test alone, so the app still runs with nothing configured', () => {
    expect(() => validateEnv({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => validateEnv({ NODE_ENV: 'test' })).not.toThrow();
    expect(() => validateEnv({})).not.toThrow();
  });

  it('refuses an unrecognised NODE_ENV, in which every production gate silently disappears', () => {
    // Each gate in the codebase compares against the literal 'production', so
    // `NODE_ENV=Production` disables the sandbox refusal, the local-storage
    // refusal, and the financial-datasource requirement all at once.
    expect(() => validateEnv({ NODE_ENV: 'Production' })).toThrow(/NODE_ENV must be exactly one of/);
    expect(() => validateEnv({ NODE_ENV: 'prod' })).toThrow(/NODE_ENV must be exactly one of/);
    // And the production rules must NOT have run for it: a capitalised value
    // is not a production environment to any other gate in the codebase, so
    // reporting it as a half-configured production deployment would be a
    // second, more confusing lie.
    expect(() => validateEnv({ NODE_ENV: 'Production' })).toThrow(/1 environment configuration problem\./);
  });

  describe('refuses a production configuration that', () => {
    const cases: [string, Record<string, string | undefined>, RegExp][] = [
      ['is missing the database URL', { DATABASE_URL: undefined }, /DATABASE_URL is required/],
      ['is missing the financial writer URL', { FINANCIAL_DATABASE_URL: undefined }, /FINANCIAL_DATABASE_URL is required/],
      ['is missing the token secret', { JWT_ACCESS_SECRET: undefined }, /JWT_ACCESS_SECRET is required/],
      ['is missing the OTP secret', { OTP_HMAC_SECRET: undefined }, /OTP_HMAC_SECRET is required/],
      /*
       * V3.3-A Story #69 (`V33-DEC-019`). Four cases rather than one, because
       * the story requires all four failure modes to be refused and each is a
       * different rule in `checkSecrets`.
       *
       * The reuse case is the one worth naming: `WORKSPACE_REFERENCE_HMAC_SECRET`
       * set to the SAME string as `JWT_ACCESS_SECRET` boots happily under any
       * check that only asks whether a variable is present, and it is exactly
       * what a hurried operator does when told "add another secret". A leak of
       * either would then be a leak of both, and the workspace reference's
       * whole security property is that only the server can mint one.
       */
      [
        'is missing the dedicated workspace-reference secret',
        { WORKSPACE_REFERENCE_HMAC_SECRET: undefined },
        /WORKSPACE_REFERENCE_HMAC_SECRET is required/,
      ],
      [
        'has a workspace-reference secret shorter than its own digest',
        { WORKSPACE_REFERENCE_HMAC_SECRET: 'Mn6Bv4Cx2Zl8Ka5' },
        /WORKSPACE_REFERENCE_HMAC_SECRET is 15 characters; at least 32 are required/,
      ],
      [
        'carries a placeholder workspace-reference secret',
        { WORKSPACE_REFERENCE_HMAC_SECRET: 'dev-only-insecure-workspace-reference-secret-override-in-env' },
        /WORKSPACE_REFERENCE_HMAC_SECRET contains the placeholder text/,
      ],
      [
        'reuses the token secret for workspace references',
        { WORKSPACE_REFERENCE_HMAC_SECRET: 'Zk4Rr9Tq2Lm7Wx1Vb6Nc3Hs8Jd5Fg0Py' },
        /These share one secret value and must not: JWT_ACCESS_SECRET, WORKSPACE_REFERENCE_HMAC_SECRET/,
      ],

      [
        'carries the code\'s own development fallback secret',
        { JWT_ACCESS_SECRET: 'dev-only-insecure-secret-override-in-env' },
        /placeholder text/,
      ],
      ['carries a placeholder secret', { OTP_HMAC_SECRET: 'changeme-changeme-changeme-change' }, /placeholder text/],
      ['has a token secret too short to resist offline guessing', { JWT_ACCESS_SECRET: 'short' }, /at least 32/],

      ['serves its public API over plaintext', { PUBLIC_API_BASE_URL: 'http://api.example/api' }, /must be https/],
      ['has a malformed public URL', { PUBLIC_WEB_BASE_URL: 'not-a-url' }, /not an absolute URL/],

      ['allows any origin to drive the API', { CORS_ALLOWED_ORIGINS: '*' }, /must not contain "\*"/],
      ['still allows a developer\'s browser origin', { CORS_ALLOWED_ORIGINS: 'http://localhost:3100' }, /loopback origin/],
      ['lists an origin with a path, which matches nothing', { CORS_ALLOWED_ORIGINS: 'https://beauclick.example/app' }, /carries a path/],

      ['points at the SANDBOX bank', { PAYMENT_ENVIRONMENT: 'sandbox' }, /PAYMENT_ENVIRONMENT must be "production"/],
      ['names the sandbox as its gateway', { PAYMENT_DEFAULT_PROVIDER: 'sandbox' }, /PAYMENT_DEFAULT_PROVIDER=sandbox is refused/],
      ['names no gateway at all', { PAYMENT_DEFAULT_PROVIDER: undefined }, /PAYMENT_DEFAULT_PROVIDER is required/],

      ['writes media to a container disk', { MEDIA_STORAGE_DRIVER: 'local' }, /MEDIA_STORAGE_DRIVER=local is refused/],
      ['selects s3 but configures half of it', { MEDIA_S3_BUCKET: undefined }, /MEDIA_S3_BUCKET is required/],
      ['sends the storage credential over plaintext', { MEDIA_S3_ENDPOINT: 'http://objects.example' }, /MEDIA_S3_ENDPOINT must be https/],

      ['would serve an empty marketplace', { OPENSEARCH_URL: undefined }, /OPENSEARCH_URL is required/],

      ['was copied from a development environment', { DEV_QA_LOGIN: '1' }, /DEV_QA_LOGIN must not be present/],
      ['turned off the outbox durability sweep', { DISABLE_BACKGROUND_SWEEPS: 'true' }, /DISABLE_BACKGROUND_SWEEPS=true is refused/],
    ];

    it.each(cases)('%s', (_label, overrides, expected) => {
      expect(() => validateEnv(validProduction(overrides))).toThrow(expected);
    });
  });

  describe('placeholder detection understands connection strings', () => {
    it('refuses a database URL whose PASSWORD is a placeholder', () => {
      expect(() => validateEnv(validProduction({ DATABASE_URL: 'postgres://app:changeme@db.internal:5432/beauclick' }))).toThrow(
        /DATABASE_URL contains the placeholder text/,
      );
    });

    it('accepts a real credential on a host that merely CONTAINS placeholder vocabulary', () => {
      // Scanning a whole connection string would refuse this for the word in
      // its hostname -- and a check that produces noise is a check operators
      // learn to wave through.
      expect(() =>
        validateEnv(validProduction({ DATABASE_URL: 'postgres://app:7Hs3Kd9Vb2Nc5Rt8@db.example-corp.internal:5432/beauclick' })),
      ).not.toThrow();
    });
  });

  it('refuses one secret serving two purposes', () => {
    const shared = 'Zk4Rr9Tq2Lm7Wx1Vb6Nc3Hs8Jd5Fg0Py';
    expect(() => validateEnv(validProduction({ JWT_ACCESS_SECRET: shared, OTP_HMAC_SECRET: shared }))).toThrow(
      /share one secret value/,
    );
  });

  it('allows the media secrets to be UNSET, which is their documented fallback', () => {
    // Absent is not "set to the same string": the media services fall back to
    // JWT_ACCESS_SECRET by design, and the reuse rule must not fire on that.
    expect(() =>
      validateEnv(validProduction({ MEDIA_UPLOAD_TOKEN_SECRET: undefined, MEDIA_DOWNLOAD_TOKEN_SECRET: undefined })),
    ).not.toThrow();
  });

  it('honours the documented escape hatch for local storage rather than overruling it', () => {
    expect(() =>
      validateEnv(validProduction({ MEDIA_STORAGE_DRIVER: 'local', MEDIA_ALLOW_LOCAL_DRIVER_IN_PRODUCTION: 'true' })),
    ).not.toThrow();
  });

  it('reports EVERY problem at once, not the first one it meets', () => {
    // An operator fixing one variable per deploy is doing five deploys, and on
    // a host that has already stopped the old process each of those is an
    // outage window.
    const broken = validProduction({
      JWT_ACCESS_SECRET: undefined,
      OTP_HMAC_SECRET: undefined,
      CORS_ALLOWED_ORIGINS: '*',
      PAYMENT_ENVIRONMENT: 'sandbox',
      OPENSEARCH_URL: undefined,
    });
    const errors = productionConfigurationErrors(broken);
    expect(errors.length).toBeGreaterThanOrEqual(5);

    const message = (() => {
      try {
        validateEnv(broken);
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(message).toContain('5 environment configuration problems');
    expect(message).toContain('JWT_ACCESS_SECRET');
    expect(message).toContain('CORS_ALLOWED_ORIGINS');
    expect(message).toContain('PAYMENT_ENVIRONMENT');
  });

  describe('never echoes a secret value', () => {
    it.each([
      ['a short secret', { JWT_ACCESS_SECRET: 'Rr9Tq2Lm7Wx1' }],
      ['a placeholder secret', { OTP_HMAC_SECRET: 'changeme-Zk4Rr9Tq2Lm7Wx1Vb6Nc3Hs' }],
      ['a reused secret', { OTP_HMAC_SECRET: 'Zk4Rr9Tq2Lm7Wx1Vb6Nc3Hs8Jd5Fg0Py' }],
      // V3.3-A Story #69. The workspace-reference secret is held to the same
      // rule as every other: its VALUE never reaches a message, whichever of
      // the three ways it is wrong.
      ['a short workspace-reference secret', { WORKSPACE_REFERENCE_HMAC_SECRET: 'Mn6Bv4Cx2Zl8Ka5' }],
      [
        'a reused workspace-reference secret',
        { WORKSPACE_REFERENCE_HMAC_SECRET: 'Zk4Rr9Tq2Lm7Wx1Vb6Nc3Hs8Jd5Fg0Py' },
      ],
    ])('%s', (_label, overrides) => {
      const config = validProduction(overrides);
      let message = '';
      try {
        validateEnv(config);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toBe('');

      for (const value of [...SECRET_VALUES, ...Object.values(overrides)]) {
        if (typeof value !== 'string' || value.length < 12) continue;
        expect(message).not.toContain(value);
      }
    });

    it('reports a length rather than a value when a secret is too short', () => {
      let message = '';
      try {
        validateEnv(validProduction({ JWT_ACCESS_SECRET: 'Rr9Tq2Lm7Wx1' }));
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('is 12 characters');
      expect(message).not.toContain('Rr9Tq2Lm7Wx1');
    });
  });

  describe('cookie policy — checked in EVERY environment', () => {
    it('refuses SameSite=None without Secure', () => {
      // `.env.example` has claimed this validation existed since Phase 3.
      expect(() => validateEnv({ NODE_ENV: 'development', AUTH_COOKIE_SAMESITE: 'none' })).toThrow(
        /requires AUTH_COOKIE_SECURE=true/,
      );
    });

    it('accepts SameSite=None WITH Secure', () => {
      expect(() =>
        validateEnv({ NODE_ENV: 'development', AUTH_COOKIE_SAMESITE: 'none', AUTH_COOKIE_SECURE: 'true' }),
      ).not.toThrow();
    });

    it('refuses a typo that a browser would silently ignore', () => {
      // An unrecognised SameSite reaches the Set-Cookie header, where the
      // browser drops the attribute and applies its own default -- changing
      // the cookie's cross-site behaviour with nothing reporting it.
      expect(() => validateEnv({ NODE_ENV: 'development', AUTH_COOKIE_SAMESITE: 'strinct' })).toThrow(
        /AUTH_COOKIE_SAMESITE must be one of/,
      );
    });

    it('refuses a non-boolean AUTH_COOKIE_SECURE', () => {
      expect(() => validateEnv({ NODE_ENV: 'development', AUTH_COOKIE_SECURE: 'yes' })).toThrow(
        /AUTH_COOKIE_SECURE must be/,
      );
    });
  });

  describe('the secret contract', () => {
    it('names what each secret protects, so a rotation runbook can be derived from it', () => {
      for (const entry of SECRET_CONTRACT) {
        expect(entry.name).toMatch(/^[A-Z][A-Z0-9_]+$/);
        expect(entry.protects.length).toBeGreaterThan(10);
      }
    });

    it('lists no duplicates', () => {
      const names = SECRET_CONTRACT.map((e) => e.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });
});
