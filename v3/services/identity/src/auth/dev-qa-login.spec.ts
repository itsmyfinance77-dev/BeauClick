import { devQaLoginPolicyFromEnv } from './dev-qa-login';

/**
 * The production guarantee, asserted as a permanent regression.
 *
 * The single most important property of the dev-QA-login is that it is OFF in
 * production no matter what else is set. These cases pin exactly that, plus the
 * whole enable/allow-list matrix `V3.1_DEV_QA_AUTH.md` §7 requires, at the level
 * where the guard actually lives — the policy function every request re-reads.
 */
describe('devQaLoginPolicyFromEnv — the production guard', () => {
  const QA = '+989121110001';

  it('is DISABLED in production even with the flag AND an allow-list set', () => {
    const policy = devQaLoginPolicyFromEnv({
      NODE_ENV: 'production',
      DEV_QA_LOGIN: '1',
      DEV_QA_LOGIN_PHONES: QA,
    } as NodeJS.ProcessEnv);
    // The load-bearing assertion: production wins over every other variable.
    expect(policy.enabled).toBe(false);
  });

  it('is DISABLED in production regardless of the allow-list contents', () => {
    for (const phones of ['', QA, '*', 'anything,at,all']) {
      const policy = devQaLoginPolicyFromEnv({
        NODE_ENV: 'production',
        DEV_QA_LOGIN: '1',
        DEV_QA_LOGIN_PHONES: phones,
      } as NodeJS.ProcessEnv);
      expect(policy.enabled).toBe(false);
    }
  });

  it('is DISABLED in development when the flag is unset', () => {
    expect(
      devQaLoginPolicyFromEnv({ NODE_ENV: 'development', DEV_QA_LOGIN_PHONES: QA } as NodeJS.ProcessEnv).enabled,
    ).toBe(false);
  });

  it('is DISABLED in development when the flag is anything other than exactly "1"', () => {
    for (const flag of ['0', 'true', 'yes', 'on', ' 1', '1 ']) {
      expect(
        devQaLoginPolicyFromEnv({
          NODE_ENV: 'development',
          DEV_QA_LOGIN: flag,
          DEV_QA_LOGIN_PHONES: QA,
        } as NodeJS.ProcessEnv).enabled,
      ).toBe(false);
    }
  });

  it('is ENABLED only in a non-production env with the exact flag', () => {
    for (const env of ['development', 'test', undefined]) {
      expect(
        devQaLoginPolicyFromEnv({
          NODE_ENV: env,
          DEV_QA_LOGIN: '1',
          DEV_QA_LOGIN_PHONES: QA,
        } as NodeJS.ProcessEnv).enabled,
      ).toBe(true);
    }
  });

  it('authenticates NOBODY when no allow-list is configured, even when enabled', () => {
    const policy = devQaLoginPolicyFromEnv({
      NODE_ENV: 'development',
      DEV_QA_LOGIN: '1',
    } as NodeJS.ProcessEnv);
    expect(policy.enabled).toBe(true);
    // A positive allow-list: a forgotten variable fails to "nothing works".
    expect(policy.allowedPhones).toEqual([]);
  });

  it('parses the allow-list into trimmed, non-empty entries', () => {
    const policy = devQaLoginPolicyFromEnv({
      NODE_ENV: 'development',
      DEV_QA_LOGIN: '1',
      DEV_QA_LOGIN_PHONES: ` ${QA} , +989121110002 ,, `,
    } as NodeJS.ProcessEnv);
    expect(policy.allowedPhones).toEqual([QA, '+989121110002']);
  });
});
