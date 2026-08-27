import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tokens from './tokens.json';
import {
  contrastRatio,
  isInSrgbGamut,
  parseOklch,
  WCAG_AA_NORMAL_TEXT,
  type Oklch,
} from './contrast';

/**
 * The palette's accessibility contract, asserted rather than measured once.
 *
 * `V3.1_UIUX_BACKLOG.md` item 8 recorded colour contrast as "the most
 * significant unverified accessibility dimension in the product". Phase A
 * measured it and found four failing pairs (`R31-11`). This suite is the part
 * that keeps them fixed: the ratios below are computed from `tokens.json`
 * itself, so a future lightness nudge that breaks AA fails here instead of
 * shipping.
 */

const COLOR = tokens.color as Record<string, { value: string; soft?: string }>;

/** Reads a token from the JSON that both the CSS and the TS constants derive from. */
function token(name: string): Oklch {
  const entry = COLOR[name];
  if (!entry) throw new Error(`No such colour token: ${name}`);
  return parseOklch(entry.value);
}

function softToken(name: string): Oklch {
  const entry = COLOR[name];
  if (!entry?.soft) throw new Error(`Colour token has no soft variant: ${name}`);
  return parseOklch(entry.soft);
}

const T: Record<string, Oklch> = {
  ink: token('ink'),
  inkSoft: token('inkSoft'),
  inkFaint: token('inkFaint'),
  background: token('background'),
  surface: token('surface'),
  surfaceTint: token('surfaceTint'),
  primary: token('primary'),
  primarySoft: token('primarySoft'),
  success: token('success'),
  successSoft: softToken('success'),
  warning: token('warning'),
  warningSoft: softToken('warning'),
  error: token('error'),
  errorSoft: softToken('error'),
};

/**
 * Every (foreground, background) pair the application actually renders text in.
 *
 * Enumerated from the call sites, not invented: each entry names where it comes
 * from so a reader can check the claim, and so a pair that stops being used can
 * be retired deliberately rather than lingering as a constraint nobody needs.
 *
 * It is a REAL-USAGE list on purpose. Asserting the full cross-product would
 * fail on combinations the product never renders (`ink-faint` on `primary`,
 * say) and would push the palette toward a uniformity that serves nothing.
 */
const RENDERED_TEXT_PAIRS: [fg: string, bg: string, where: string][] = [
  ['ink', 'surface', 'body text in Card'],
  ['ink', 'background', 'body text on the page'],
  ['ink', 'surfaceTint', 'body text on a tinted panel'],
  ['ink', 'primarySoft', 'ProShell context band'],
  ['ink', 'warningSoft', 'AdminShell context band'],

  ['inkSoft', 'surface', 'secondary text in Card'],
  ['inkSoft', 'background', 'PageHeader subtitle'],
  ['inkSoft', 'surfaceTint', 'neutral Badge'],
  ['inkSoft', 'primarySoft', 'ProShell exit link'],
  ['inkSoft', 'warningSoft', 'AdminShell exit link'],

  ['inkFaint', 'surface', '12px metadata in Card — ids, timestamps'],
  ['inkFaint', 'background', '12px metadata on the page'],
  ['inkFaint', 'surfaceTint', '12px metadata on a tinted panel'],

  ['primary', 'surface', 'TextLink, primary Badge foreground'],
  ['primary', 'background', 'nav link, current page'],
  ['primary', 'primarySoft', 'primary Badge, active tab'],
  ['primary', 'surfaceTint', 'link on a tinted panel'],
  ['surface', 'primary', 'primary Button label'],

  ['success', 'surface', 'confirmed booking status'],
  ['success', 'successSoft', 'success Badge, success Alert'],

  ['warning', 'surface', 'pending booking status'],
  ['warning', 'warningSoft', 'warning Badge, AdminShell current nav link'],

  ['error', 'surface', 'field error text, danger Button label'],
  ['error', 'background', 'error text outside a Card'],
  ['error', 'errorSoft', 'error Alert, error Badge'],
];

describe('design tokens — WCAG AA contrast', () => {
  it.each(RENDERED_TEXT_PAIRS)('%s on %s (%s) meets AA for normal text', (fg, bg) => {
    const ratio = contrastRatio(T[fg], T[bg]);
    // Reported to two decimals so a failure message states the real number
    // rather than only that a boolean was false.
    expect({ pair: `${fg}/${bg}`, ratio: Number(ratio.toFixed(2)) }).toEqual({
      pair: `${fg}/${bg}`,
      ratio: expect.any(Number),
    });
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  /**
   * The four pairs `R31-11` recorded, pinned individually.
   *
   * The parameterized case above would catch a regression on any of them, but
   * these are the ones that were actually broken, and naming them keeps the
   * finding traceable from the reconciliation document to a specific assertion.
   */
  it.each([
    ['error', 'errorSoft', 4.36],
    ['warning', 'warningSoft', 4.29],
    ['inkFaint', 'surface', 3.98],
    ['inkFaint', 'surfaceTint', 3.58],
  ])('R31-11: %s on %s is above its pre-correction ratio of %s', (fg, bg, before) => {
    expect(contrastRatio(T[fg], T[bg])).toBeGreaterThan(before as number);
  });
});

describe('design tokens — sRGB gamut', () => {
  /**
   * An out-of-gamut token is clipped by the browser, so the authored colour and
   * the rendered colour differ and every ratio computed above would describe a
   * colour nobody sees. `warning` was out of gamut before the Phase G
   * correction; this is what stops that recurring silently.
   */
  it.each(Object.keys(T))('%s renders in sRGB without clipping', (name) => {
    expect(isInSrgbGamut(T[name])).toBe(true);
  });
});

describe('contrast maths', () => {
  /**
   * The anchor for everything else in this file.
   *
   * These eleven numbers were measured in a real browser during Phase A by
   * painting each token onto a canvas and reading the pixel back — the method
   * that forces the browser's OWN oklch->sRGB conversion. If the pure-TS
   * implementation reproduces them, it is converting correctly; if it drifts,
   * every ratio asserted above is describing colours that do not exist.
   *
   * The values are the pre-correction palette, quoted from
   * `V3.1_PHASE_A_IMPLEMENTATION.md` §14a, so they stay valid as a check on the
   * MATHS regardless of what the tokens are changed to afterwards.
   */
  const PHASE_A_MEASURED: [Oklch, Oklch, number][] = [
    [[0.2, 0.02, 290], [1, 0, 0], 18.09], // ink / surface
    [[0.2, 0.02, 290], [0.985, 0.006, 280], 17.34], // ink / background
    [[0.4, 0.16, 290], [1, 0, 0], 9.86], // primary / surface
    [[0.4, 0.16, 290], [0.94, 0.03, 290], 8.21], // primary / primary-soft
    [[0.48, 0.02, 290], [1, 0, 0], 6.57], // ink-soft / surface
    [[0.48, 0.02, 290], [0.965, 0.014, 290], 5.92], // ink-soft / surface-tint
    [[0.5, 0.13, 150], [0.94, 0.04, 150], 4.78], // success / success-soft
    [[0.55, 0.19, 25], [0.95, 0.05, 25], 4.36], // error / error-soft (pre-correction)
    [[0.55, 0.13, 70], [0.95, 0.045, 80], 4.29], // warning / warning-soft (pre-correction)
    [[0.6, 0.02, 290], [1, 0, 0], 3.98], // ink-faint / surface (pre-correction)
    [[0.6, 0.02, 290], [0.965, 0.014, 290], 3.58], // ink-faint / surface-tint (pre-correction)
  ];

  it.each(PHASE_A_MEASURED)(
    'reproduces the browser canvas measurement of %s on %s (%s)',
    (fg, bg, measured) => {
      expect(Number(contrastRatio(fg, bg).toFixed(2))).toBe(measured);
    },
  );

  it('is order-independent', () => {
    expect(contrastRatio(T.ink, T.surface)).toBeCloseTo(contrastRatio(T.surface, T.ink), 10);
  });

  it('rejects a colour that is not oklch()', () => {
    expect(() => parseOklch('#ff0000')).toThrow(/oklch/);
  });
});

describe('tokens.css', () => {
  /**
   * `tokens.css` says in its own header that it is kept in sync with
   * `tokens.json` BY HAND. Everything asserted in this file is computed from
   * the JSON, while every screen is styled from the CSS — so without this case
   * the whole suite could pass green against values the product does not use.
   *
   * That is not hypothetical: this suite's own subject, the R31-11 correction,
   * had to be applied to both files.
   */
  const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8');

  it.each(Object.entries(COLOR))('--bc-color-%s matches tokens.json', (name, entry) => {
    const kebab = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    expect(css).toContain(`--bc-color-${kebab}: ${entry.value};`);
    if (entry.soft) expect(css).toContain(`--bc-color-${kebab}-soft: ${entry.soft};`);
  });
});
