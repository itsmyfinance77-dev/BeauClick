/**
 * Real-PostgreSQL integration suite (ADR-015). Separate from the default
 * jest.config.js so the fast pg-mem layer stays runnable without a
 * database -- these specs use the *.pg-spec.ts suffix and require
 * TEST_DATABASE_URL (they self-skip via describe.skip when it's unset).
 */
module.exports = {
  displayName: 'api:pg',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.pg-spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  moduleNameMapper: {
    '^@beauclick/http$': '<rootDir>/../../libs/http/src/index.ts',
    '^@beauclick/auth$': '<rootDir>/../../libs/auth/src/index.ts',
    '^@beauclick/ownership$': '<rootDir>/../../libs/ownership/src/index.ts',
    '^@beauclick/testing$': '<rootDir>/../../libs/testing/src/index.ts',
    '^@beauclick/identity$': '<rootDir>/../../services/identity/src/index.ts',
    '^@beauclick/provider$': '<rootDir>/../../services/provider/src/index.ts',
    '^@beauclick/money$': '<rootDir>/../../libs/money/src/index.ts',
    '^@beauclick/events$': '<rootDir>/../../libs/events/src/index.ts',
    '^@beauclick/booking$': '<rootDir>/../../services/booking/src/index.ts',
    '^@beauclick/commerce$': '<rootDir>/../../services/commerce/src/index.ts',
    '^@beauclick/payment$': '<rootDir>/../../services/payment/src/index.ts',
    '^@beauclick/financial$': '<rootDir>/../../services/financial/src/index.ts',
    '^@beauclick/search$': '<rootDir>/../../services/search/src/index.ts',
    '^@beauclick/media$': '<rootDir>/../../libs/media/src/index.ts',
    '^@beauclick/audit$': '<rootDir>/../../libs/audit/src/index.ts',
  },
  testTimeout: 30000,
  // Real DB tests share one server; run serially so TRUNCATE between cases
  // can't race a parallel worker's writes.
  maxWorkers: 1,
};
