module.exports = {
  displayName: 'business',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  moduleNameMapper: {
    '^@beauclick/event-contracts$': '<rootDir>/../../libs/event-contracts/src/index.ts',
    '^@beauclick/events$': '<rootDir>/../../libs/events/src/index.ts',
    '^@beauclick/http$': '<rootDir>/../../libs/http/src/index.ts',
    '^@beauclick/auth$': '<rootDir>/../../libs/auth/src/index.ts',
    '^@beauclick/ownership$': '<rootDir>/../../libs/ownership/src/index.ts',
    '^@beauclick/testing$': '<rootDir>/../../libs/testing/src/index.ts',
    // V3.3 #107: the classification service writes its audit row through
    // `AdminAuditService`. `AuditModule` is @Global so runtime DI resolves it,
    // but this unit suite compiles the import and would not resolve it without
    // the mapping -- a runtime-global is not a substitute for a real dependency.
    '^@beauclick/audit$': '<rootDir>/../../libs/audit/src/index.ts',
    '^@beauclick/subject-data$': '<rootDir>/../../libs/subject-data/src/index.ts',
    // V3.3 #108: the location service derives its opaque `locationRef` through
    // the shared reference primitive.
    '^@beauclick/workspace-reference$': '<rootDir>/../../libs/workspace-reference/src/index.ts',
  },
};
