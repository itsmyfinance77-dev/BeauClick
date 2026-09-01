module.exports = {
  displayName: 'commercial-policy',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  moduleNameMapper: {
    '^@beauclick/commercial-policy-contract$': '<rootDir>/../../packages/commercial-policy-contract/src/index.ts',
  },
};
