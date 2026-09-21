/**
 * A readable name for a signed-in device.
 *
 * The API gives a raw `userAgent` string and, when the client sent one, a
 * Latin-only `deviceLabel`. A full browser string is unreadable, so the spec
 * asks for a short label mapped on the front end (`30_DEVICE_SESSIONS.md`) —
 * this is that mapping, and it is only ever a label: it never decides who may
 * sign out what.
 *
 * Order matters: Edge and Opera also say "Chrome", and Chrome on iOS says
 * "Safari", so the more specific token is looked for first.
 */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Windows/, 'Windows'],
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

/** For a device that sent nothing readable: never the raw string, and never a guess. */
export const UNKNOWN_DEVICE_LABEL = 'دستگاه ناشناخته';

export interface DeviceName {
  /** The browser and system, both Latin (they are product names and stay Latin, left-to-right). */
  browser: string | null;
  system: string | null;
}

export function deviceName(userAgent: string | null | undefined): DeviceName {
  const ua = userAgent ?? '';
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  return { browser, system };
}

/** «Chrome · Windows», or the neutral fallback when neither can be read. */
export function deviceTitle(userAgent: string | null | undefined): string {
  const { browser, system } = deviceName(userAgent);
  const parts = [browser, system].filter(Boolean);
  return parts.length ? parts.join(' · ') : UNKNOWN_DEVICE_LABEL;
}
