import { assertJestZeroSkipped } from './assert-jest-zero-skipped';

const clean = `
Test Suites: 41 passed, 41 total
Tests:       1107 passed, 1107 total
Snapshots:   0 total
`;

describe('assertJestZeroSkipped', () => {
  it('accepts exactly one complete non-empty suite and test summary', () => {
    expect(() => assertJestZeroSkipped(clean)).not.toThrow();
  });

  it.each([
    ['suite skipped', 'Test Suites: 1 skipped, 40 passed, 41 total\nTests: 1107 passed, 1107 total'],
    ['test skipped', 'Test Suites: 41 passed, 41 total\nTests: 1 skipped, 1106 passed, 1107 total'],
    ['todo test', 'Test Suites: 41 passed, 41 total\nTests: 1 todo, 1106 passed, 1107 total'],
    ['failed test', 'Test Suites: 41 passed, 41 total\nTests: 1 failed, 1106 passed, 1107 total'],
  ])('refuses a planted %s marker', (_case, output) => {
    expect(() => assertJestZeroSkipped(output)).toThrow(/did not fully execute/);
  });

  it.each([
    ['missing output', ''],
    ['only suites', 'Test Suites: 41 passed, 41 total'],
    ['unparseable totals', 'Test Suites: all good\nTests: all good'],
    ['duplicated run', `${clean}\n${clean}`],
  ])('fails closed for %s rather than treating it as green', (_case, output) => {
    expect(() => assertJestZeroSkipped(output)).toThrow();
  });

  it('parses the ANSI-decorated labels emitted by forced-color Jest', () => {
    const decorated = clean.replace('Test Suites:', '\u001b[1mTest Suites:\u001b[22m').replace('Tests:', '\u001b[1mTests:\u001b[22m');
    expect(() => assertJestZeroSkipped(decorated)).not.toThrow();
  });
});
