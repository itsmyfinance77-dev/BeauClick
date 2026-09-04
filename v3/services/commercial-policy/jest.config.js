module.exports = {
  displayName: 'commercial-policy',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  moduleNameMapper: {
    '^@beauclick/workspace-reference$': '<rootDir>/../../libs/workspace-reference/src/index.ts',
    '^@beauclick/commercial-policy-contract$': '<rootDir>/../../packages/commercial-policy-contract/src/index.ts',
    '^@beauclick/audit$': '<rootDir>/../../libs/audit/src/index.ts',
    '^@beauclick/auth$': '<rootDir>/../../libs/auth/src/index.ts',
    '^@beauclick/http$': '<rootDir>/../../libs/http/src/index.ts',
    '^@beauclick/subject-data$': '<rootDir>/../../libs/subject-data/src/index.ts',
  },
};
