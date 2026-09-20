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
  text: token('text'),
  textMuted: token('textMuted'),
  textFaint: token('textFaint'),
  surface: token('surface'),
  surfacePage: token('surfacePage'),
  surfaceMuted: token('surfaceMuted'),
  surfaceTint: token('surfaceTint'),
  primary: token('primary'),
  primarySoft: token('primarySoft'),
  primaryOnSoft: token('primaryOnSoft'),
  accent: token('accent'),
  accentSoft: softToken('accent'),
  accentOnSoft: token('accentOnSoft'),
  success: token('success'),
  successSoft: softToken('success'),
  warning: token('warning'),
  warningSoft: softToken('warning'),
  error: token('error'),
  errorSoft: softToken('error'),
  info: token('info'),
  infoSoft: softToken('info'),
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
  ['text', 'surface', 'body text in Card'],
  ['text', 'surfacePage', 'body text on the page'],
  ['text', 'surfaceMuted', 'body text in a table head or readable block'],
  ['text', 'surfaceTint', 'body text on a tinted panel'],
  ['text', 'primarySoft', 'ProShell context band'],
  ['text', 'warningSoft', 'AdminShell context band'],
  ['text', 'accentSoft', 'business context band — the bronze platform'],

  ['textMuted', 'surface', 'secondary text in Card'],
  ['textMuted', 'surfacePage', 'PageHeader subtitle'],
  ['textMuted', 'surfaceMuted', 'secondary text in a readable block'],
  ['textMuted', 'surfaceTint', 'neutral Badge'],
  ['textMuted', 'primarySoft', 'ProShell exit link'],
  ['textMuted', 'warningSoft', 'AdminShell exit link'],

  ['textFaint', 'surface', '13px label or caption in Card'],
  ['textFaint', 'surfacePage', '13px label or caption on the page'],
  ['textFaint', 'surfaceMuted', '13px label in a readable block'],
  ['textFaint', 'surfaceTint', '13px label on a tinted panel'],

  ['primary', 'surface', 'TextLink, primary Badge foreground'],
  ['primary', 'surfacePage', 'nav link, current page'],
  ['primary', 'surfaceTint', 'link on a tinted panel'],
  ['primaryOnSoft', 'primarySoft', 'primary Badge, active tab'],
  ['surface', 'primary', 'primary Button label'],

  ['accentOnSoft', 'surface', 'bronze text on a card'],
  ['accentOnSoft', 'accentSoft', 'bronze Badge, loyalty tier label'],

  ['success', 'surface', 'confirmed booking status'],
  ['success', 'successSoft', 'success Badge, success Alert'],

  ['warning', 'surface', 'pending booking status'],
  ['warning', 'warningSoft', 'warning Badge, AdminShell current nav link'],

  ['error', 'surface', 'field error text, danger Button label'],
  ['error', 'surfacePage', 'error text outside a Card'],
  ['error', 'errorSoft', 'error Alert, error Badge'],

  ['info', 'surface', 'informational text on a card'],
  ['info', 'infoSoft', 'info Alert — the fourth status role, new in V3.3'],
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
    ['textFaint', 'surface', 3.98],
    ['textFaint', 'surfaceTint', 3.58],
  ])('R31-11: %s on %s is above its pre-correction ratio of %s', (fg, bg, before) => {
    expect(contrastRatio(T[fg], T[bg])).toBeGreaterThan(before as number);
  });

  /**
   * The V3.3 palette's own corrections.
   *
   * `V3_DESIGN_SYSTEM.md` §10 states "همهٔ جفت‌های این سند بررسی شده‌اند" --
   * every pair in the sheet has been checked. Measured here against the same
   * maths the rest of this file uses, seven pairs were below AA and three
   * colours fell outside sRGB. The sheet's values were adopted with the
   * smallest corrections that fix both, and these cases pin the corrections
   * so the original values cannot be restored by a later "sync with design".
   */
  it.each([
    ['textFaint', 'oklch(0.55 0.015 330)', 'the sheet says 0.58, which is 4.32:1 on white'],
    ['success', 'oklch(0.4 0.098 155)', 'the sheet says chroma 0.1, which clips outside sRGB'],
    ['accentOnSoft', 'oklch(0.46 0.09 65)', 'the sheet has no text-safe bronze; 0.62 is 3.70:1'],
  ])('%s is the corrected value %s — %s', (name, value) => {
    expect(COLOR[name].value).toBe(value);
  });

  it.each([
    ['error', 'oklch(0.929 0.035 25)', 'the sheet says L 0.965 at this chroma, which clips'],
    ['info', 'oklch(0.964 0.018 245)', 'the sheet says L 0.968 at this chroma, which clips'],
  ])('%s-soft is the corrected value %s — %s', (name, value) => {
    expect(COLOR[name].soft).toBe(value);
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
    expect(contrastRatio(T.text, T.surface)).toBeCloseTo(contrastRatio(T.surface, T.text), 10);
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

/**
 * The three surfaces that invert the palette.
 *
 * The dark footer, the loyalty card and the operator's bar choose their ink
 * against a dark ground, so none of their pairs appear in
 * `RENDERED_TEXT_PAIRS` above — which asserts against white and the tinted
 * surfaces. Three separate stylesheets said as much in a comment, and a
 * comment is not a check: the pairs were measured once by hand and nothing
 * kept them measured.
 *
 * The grounds and inks are literals in those stylesheets rather than tokens,
 * because they exist on three surfaces and a token implies a system. They
 * are duplicated here on purpose, and the duplication is the point: if a
 * stylesheet's value changes and this list does not, the two disagree and
 * somebody has to look.
 */
describe('design tokens — the inverted surfaces', () => {
  /** `--bc-color-text` is the ground for the footer and the loyalty card. */
  const onText = (fg: Oklch): number => contrastRatio(fg, parseOklch(COLOR.text.value));
  const ADMIN_BAR: Oklch = [0.14, 0.015, 330];
  const ADMIN_CHIP: Oklch = [0.24, 0.015, 330];
  const WHITE: Oklch = [1, 0, 0];

  it.each([
    ['site-footer.module.css .footer colour', [0.9, 0.01, 330] as Oklch],
    ['site-footer.module.css .blurb', [0.72, 0.015, 330] as Oklch],
    ['site-footer.module.css .link', [0.8, 0.012, 330] as Oklch],
    ['site-footer.module.css .legal', [0.66, 0.015, 330] as Oklch],
    ['dashboard.module.css .loyaltyLabel', [0.86, 0.012, 330] as Oklch],
    ['dashboard.module.css .balanceUnit', [0.8, 0.012, 330] as Oklch],
    ['dashboard.module.css .lifetime', [0.72, 0.015, 330] as Oklch],
  ])('%s reads on the dark ground', (_where, fg) => {
    expect(onText(fg as Oklch)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  it.each([
    ['admin-shell.module.css .mode', WHITE, ADMIN_BAR],
    ['admin-shell.module.css .link', [0.8, 0.012, 330] as Oklch, ADMIN_BAR],
    ['admin-shell.module.css .exit', [0.72, 0.015, 330] as Oklch, ADMIN_BAR],
    ['admin-shell.module.css .scope ink on its chip', [0.8, 0.012, 330] as Oklch, ADMIN_CHIP],
    ['admin-shell.module.css .count amber', WHITE, [0.55, 0.11, 75] as Oklch],
    ['admin-shell.module.css .countSystem blue', WHITE, [0.5, 0.1, 245] as Oklch],
  ])('%s reads on the operator bar', (_where, fg, bg) => {
    expect(contrastRatio(fg as Oklch, bg as Oklch)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  it('the loyalty tier chip reads on the bronze accent', () => {
    // The one chip whose ground is a TOKEN rather than a literal, so a
    // change to bronze is caught here as well as by the light-ground pairs.
    expect(contrastRatio([0.18, 0.03, 65], parseOklch(COLOR.accent.value))).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT,
    );
  });

  it.each([
    ['the operator bar', ADMIN_BAR],
    ['its chip ground', ADMIN_CHIP],
    ['the footer rule', [0.34, 0.02, 330] as Oklch],
    ['the amber counter', [0.55, 0.11, 75] as Oklch],
    ['the blue counter', [0.5, 0.1, 245] as Oklch],
  ])('%s renders in sRGB without clipping', (_where, colour) => {
    expect(isInSrgbGamut(colour as Oklch)).toBe(true);
  });
});
