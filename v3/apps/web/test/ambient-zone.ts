/**
 * Runs the enclosing `describe` with the process's own timezone set to `zone`
 * (#321), then puts it back.
 *
 * A wall-clock bug that reads the ambient zone is invisible on a machine
 * already on Asia/Tehran -- which this project's development machines are --
 * so a test of "the platform's zone, not the operator's" has to move the
 * operator somewhere else. The spec file must run in
 * `./ambient-zone-environment.js`, which is what can actually move it.
 */
declare const __setAmbientZone: ((zone?: string) => void) | undefined;

export function withAmbientZone(zone: string): void {
  beforeAll(() => {
    if (typeof __setAmbientZone !== 'function') {
      throw new Error('withAmbientZone needs `@jest-environment ./test/ambient-zone-environment.js` in the spec file.');
    }
    __setAmbientZone(zone);
  });
  afterAll(() => {
    if (typeof __setAmbientZone === 'function') __setAmbientZone();
  });
}

/** The zone this process is reading wall clocks in right now. */
export const ambientZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
