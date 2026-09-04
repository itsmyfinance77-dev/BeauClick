module.exports = {
  displayName: 'financial',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  moduleNameMapper: {
    '^@beauclick/workspace-reference$': '<rootDir>/../../libs/workspace-reference/src/index.ts',
    '^@beauclick/http$': '<rootDir>/../../libs/http/src/index.ts',
    '^@beauclick/auth$': '<rootDir>/../../libs/auth/src/index.ts',
    '^@beauclick/ownership$': '<rootDir>/../../libs/ownership/src/index.ts',
    '^@beauclick/events$': '<rootDir>/../../libs/events/src/index.ts',
    '^@beauclick/money$': '<rootDir>/../../libs/money/src/index.ts',
    '^@beauclick/testing$': '<rootDir>/../../libs/testing/src/index.ts',
  },
};
