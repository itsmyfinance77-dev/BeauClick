module.exports = {
  displayName: 'wishlist',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  moduleNameMapper: {
    '^@beauclick/http$': '<rootDir>/../../libs/http/src/index.ts',
    '^@beauclick/ownership$': '<rootDir>/../../libs/ownership/src/index.ts',
    '^@beauclick/events$': '<rootDir>/../../libs/events/src/index.ts',
    '^@beauclick/subject-data$': '<rootDir>/../../libs/subject-data/src/index.ts',
    '^@beauclick/wishlist-contract$': '<rootDir>/../../packages/wishlist-contract/src/index.ts',
    '^@beauclick/testing$': '<rootDir>/../../libs/testing/src/index.ts',
  },
};
