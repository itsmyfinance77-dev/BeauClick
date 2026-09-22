import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio, isInSrgbGamut, parseOklch, WCAG_AA_NORMAL_TEXT, type Oklch } from '@beauclick/design-tokens';

/**
 * The dark-mode token override in `app/admin/page.tsx`'s `.page` scope
 * (`overview.module.css`) — checked the same way
 * `packages/design-tokens/src/contrast.spec.ts` checks the shared palette,
 * against every pair the page actually renders text in. See that file's own
 * `.page` doc comment for where each value comes from.
 *
 * Reads the values from the stylesheet's own text, not from a copy retyped
 * here — a value that drifts in one place and not the other fails this
 * suite instead of shipping unnoticed.
 */

// A plain path, not `import`/`require.resolve('./overview.module.css')`:
// jest's own `moduleNameMapper` sends every `.css` reference through
// `test/style-mock.js` (a class-name proxy, real CSS never loads into
// jsdom), and that redirect applies to `require.resolve` too -- it would
// silently hand back the MOCK file's path, not the stylesheet's.
const CSS_PATH = join(__dirname, '..', 'app', 'admin', 'overview.module.css');
const CSS = readFileSync(CSS_PATH, 'utf8');

/** Pulls `--bc-color-<name>: oklch(...)` out of the `.page` block's own declarations. */
function darkToken(name: string): Oklch {
  const match = new RegExp(`--bc-color-${name}:\\s*(oklch\\([^;]+\\));`).exec(CSS);
  if (!match) throw new Error(`.page does not declare --bc-color-${name}`);
  return parseOklch(match[1]);
}

const T: Record<string, Oklch> = {
  surfacePage: darkToken('surface-page'),
  surface: darkToken('surface'),
  surfaceTint: darkToken('surface-tint'),
  border: darkToken('border'),
  borderStrong: darkToken('border-strong'),
  text: darkToken('text'),
  textMuted: darkToken('text-muted'),
  textFaint: darkToken('text-faint'),
  primary: darkToken('primary'),
  warning: darkToken('warning'),
  warningSoft: darkToken('warning-soft'),
  success: darkToken('success'),
  successSoft: darkToken('success-soft'),
  error: darkToken('error'),
  errorSoft: darkToken('error-soft'),
};

describe('every dark token the overview page declares parses and stays in sRGB gamut', () => {
  it.each(Object.keys(T))('%s', (name) => {
    expect(isInSrgbGamut(T[name])).toBe(true);
  });
});

/**
 * Every (foreground, background) pair the page actually renders text in --
 * enumerated from the components it uses (`PageHeader`, `Card`/`StatCard`,
 * `Badge`, `TextLink`, `Alert`/`ErrorState`, `Button` variant `ghost`), not
 * the full cross-product.
 */
const RENDERED_TEXT_PAIRS: [fg: string, bg: string, where: string][] = [
  ['text', 'surfacePage', 'PageHeader <h1>, inherited from .page'],
  ['text', 'surface', 'StatCard value, queue label'],
  ['textMuted', 'surfacePage', 'PageHeader subtitle'],
  ['textMuted', 'surface', 'StatCard label, queue meta text'],
  ['textFaint', 'surface', 'the faintest caption this page renders'],
  ['textMuted', 'surfaceTint', 'Badge tone="neutral" (its fg is --bc-color-ink-soft = textMuted)'],
  ['primary', 'surface', 'TextLink "مشاهده" inside a queue row'],
  ['primary', 'surfacePage', 'TextLink, if ever rendered directly on the page ground'],
  ['warning', 'warningSoft', 'Badge tone="warning" ("نیازمند بررسی")'],
  ['success', 'successSoft', 'Badge tone="success" ("بدون مورد")'],
  ['error', 'errorSoft', 'Alert inside ErrorState, on a load failure'],
  // The ghost retry Button reads --bc-color-ink (= text) for its label and
  // sits on the page ground (its own background is transparent).
  ['text', 'surfacePage', 'ErrorState retry Button (variant="ghost")'],
];

describe('every text/background pair the overview page renders clears WCAG AA', () => {
  it.each(RENDERED_TEXT_PAIRS)('%s on %s — %s', (fg, bg) => {
    const ratio = contrastRatio(T[fg], T[bg]);
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });
});

describe('the queue-edge / Badge tones are visually distinct from the neutral border and from each other', () => {
  // Not a WCAG requirement (a decorative accent, same treatment the light
  // palette's own border/surface pairing already gets) -- but the whole
  // point of a coloured edge is that busy/clear/unknown read as different
  // colours, so pin that they are not near-identical.
  it('warning, success and the neutral border are pairwise distinguishable', () => {
    const pairs: [Oklch, Oklch][] = [
      [T.warning, T.borderStrong],
      [T.success, T.borderStrong],
      [T.warning, T.success],
    ];
    for (const [a, b] of pairs) {
      const [, Ca, Ha] = a;
      const [, Cb, Hb] = b;
      const hueDelta = Math.min(Math.abs(Ha - Hb), 360 - Math.abs(Ha - Hb));
      // Different enough in hue, or one is essentially achromatic (the
      // neutral border) and the other is not.
      expect(hueDelta > 15 || Math.abs(Ca - Cb) > 0.03).toBe(true);
    }
  });
});
