import { format } from 'node:util';
import '@testing-library/jest-dom';

// jsdom has no layout engine and does not implement `scrollIntoView` at all,
// so a component that calls it (AdminShell, scrolling the current nav item
// into view) throws `TypeError: ... is not a function` inside an effect,
// which React surfaces as a render failure across every test that mounts it.
// A no-op stub is standard practice for this exact gap.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// A test that prints to `console.error` / `console.warn` fails.
//
// React reports its own misuse there -- above all `An update to X inside a test
// was not wrapped in act(...)`, where a state update lands outside any act()
// scope. Left as output, one page rendered by a few dozen cases writes hundreds
// of lines per run, and past a point CI's log is cut before jest's own
// `Tests: N failed` summary: the run ends mid-word and the failing suite cannot
// be recovered from it (#298). Failing the case that caused the output turns
// that fog into a defect with a name and a location. The failure quotes the
// first message; a case that expects console output on purpose says so by
// stubbing it itself (`jest.spyOn(console, 'error').mockImplementation(...)`),
// which replaces this recorder for that case.
//
// Output that arrives after a case's own hooks have finished is not seen.
const unexpectedConsole: string[] = [];

beforeEach(() => {
  unexpectedConsole.length = 0;
  for (const level of ['error', 'warn'] as const) {
    jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      unexpectedConsole.push(`console.${level}: ${format(...(args as [unknown, ...unknown[]]))}`);
    });
  }
});

afterEach(() => {
  const seen = [...unexpectedConsole];
  unexpectedConsole.length = 0;
  jest.mocked(console.error).mockRestore?.();
  jest.mocked(console.warn).mockRestore?.();
  if (seen.length > 0) {
    const first = seen[0].replace(/\s+/g, ' ').slice(0, 400);
    throw new Error(
      `${seen.length} unexpected console call(s) during this test. First: ${first}\n` +
        `If the output is expected, stub it in the test: jest.spyOn(console, 'error').mockImplementation(() => {}).`,
    );
  }
});
