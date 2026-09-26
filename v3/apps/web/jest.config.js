module.exports = {
  displayName: 'web',
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.spec.tsx', '<rootDir>/test/**/*.spec.ts'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  moduleNameMapper: {
    '\\.css$': '<rootDir>/test/style-mock.js',
    '^@/(.*)$': '<rootDir>/$1',
    '^@beauclick/persian-utils$': '<rootDir>/../../packages/persian-utils/src/index.ts',
    '^@beauclick/design-tokens$': '<rootDir>/../../packages/design-tokens/src/index.ts',
    '^@beauclick/payment-contract$': '<rootDir>/../../packages/payment-contract/src/index.ts',
    '^@beauclick/referral-contract$': '<rootDir>/../../packages/referral-contract/src/index.ts',
    '^@beauclick/wishlist-contract$': '<rootDir>/../../packages/wishlist-contract/src/index.ts',
    '^@beauclick/ai-contract$': '<rootDir>/../../packages/ai-contract/src/index.ts',
    // V3.3 `#43b-1` / #173. The admin commission surface re-declares this
    // package's closed vocabularies as literal unions rather than importing
    // them into the browser bundle; one test asserts the two still agree,
    // and that test needs the real contract.
    '^@beauclick/commercial-policy-contract$': '<rootDir>/../../packages/commercial-policy-contract/src/index.ts',
  },
};
