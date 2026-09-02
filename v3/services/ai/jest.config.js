module.exports = {
  displayName: 'ai',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  moduleNameMapper: {
    '^@beauclick/ai-contract$': '<rootDir>/../../packages/ai-contract/src/index.ts',
    '^@beauclick/http$': '<rootDir>/../../libs/http/src/index.ts',
    '^@beauclick/auth$': '<rootDir>/../../libs/auth/src/index.ts',
    '^@beauclick/events$': '<rootDir>/../../libs/events/src/index.ts',
    '^@beauclick/event-contracts$': '<rootDir>/../../libs/event-contracts/src/index.ts',
    '^@beauclick/observability$': '<rootDir>/../../libs/observability/src/index.ts',
    '^@beauclick/persian-utils$': '<rootDir>/../../packages/persian-utils/src/index.ts',
    '^@beauclick/subject-data$': '<rootDir>/../../libs/subject-data/src/index.ts',
  },
};
