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
  },
};
