module.exports = {
  displayName: 'http',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  moduleNameMapper: {
    '^@beauclick/events$': '<rootDir>/../events/src/index.ts',
    '^@beauclick/observability$': '<rootDir>/../observability/src/index.ts',
  },
};
