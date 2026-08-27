/**
 * Colour-contrast maths for the token palette.
 *
 * WHY THIS EXISTS IN SOURCE RATHER THAN IN A ONE-OFF MEASUREMENT.
 *
 * V3.1 Phase A measured contrast for the first time by painting each token
 * onto a canvas and reading the pixel back, and found four token pairs below
 * WCAG AA for normal text (`R31-11`). A measurement taken once in a browser
 * session is not a guarantee: the next person to nudge a lightness value has
 * nothing telling them they broke it. `V3.1_PRODUCT_ROADMAP.md` §15 (V3.1-G)
 * asks for exactly this — "every token pair's contrast ratio is asserted
 * against WCAG AA in a test rather than measured once and forgotten".
 *
 * THE CONVERSION IS THE WHOLE DIFFICULTY. The palette is authored in `oklch()`,
 * and `getComputedStyle` returns it **unconverted**, so a parser that assumes
 * RGB reads `0.2 0.02 290` as a colour and produces confident nonsense — Phase
 * A's first attempt did precisely that, returned identical ratios for unrelated
 * pairs, and was discarded. The implementation below does the real
 * OKLCH -> OKLab -> LMS -> linear sRGB -> gamma-encoded 8-bit conversion, then
 * computes WCAG relative luminance from the 8-bit values.
 *
 * Rounding to 8 bits before computing luminance is deliberate and not a
 * shortcut: it is what a browser actually rasterizes, so it is what a user
 * actually sees. It is also what makes this module reproduce Phase A's
 * canvas-readback numbers to two decimal places on all eleven pairs that
 * method measured — which is the evidence that the maths here is right rather
 * than merely plausible.
 */

/** OKLCH lightness (0..1), chroma, hue in degrees — the authoring form. */
export type Oklch = readonly [L: number, C: number, H: number];

/** Linear-light sRGB, BEFORE gamut clamping. Out-of-range means out of gamut. */
function oklchToLinearSrgb([L, C, H]: Oklch): [number, number, number] {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  // OKLab -> LMS' (Björn Ottosson's matrix), then cube to undo the cube root.
  const lp = L + 0.3963377774 * a + 0.2158037573 * b;
  const mp = L - 0.1055613458 * a - 0.0638541728 * b;
  const sp = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = lp ** 3;
  const m = mp ** 3;
  const s = sp ** 3;

  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

/**
 * True when the colour survives sRGB rasterization unchanged.
 *
 * A token outside the gamut is silently clipped by the browser, so the colour
 * that was authored and the colour that renders are two different colours —
 * and any ratio computed from the authored value is a statement about a colour
 * nobody sees. Worth asserting rather than assuming: the pre-correction
 * `warning` token, `oklch(0.55 0.13 70)`, was out of gamut and nothing said so.
 */
export function isInSrgbGamut(color: Oklch): boolean {
  const EPSILON = 0.0005; // tolerance for float error at the exact boundary
  return oklchToLinearSrgb(color).every((c) => c >= -EPSILON && c <= 1 + EPSILON);
}

/** The 8-bit sRGB triple a browser rasterizes this colour to. */
export function oklchToSrgb8(color: Oklch): [number, number, number] {
  return oklchToLinearSrgb(color).map((c) => {
    const encoded = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(encoded * 255)));
  }) as [number, number, number];
}

/** WCAG 2.1 relative luminance, from the rasterized 8-bit value. */
function relativeLuminance(color: Oklch): number {
  const [r, g, b] = oklchToSrgb8(color).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, 1..21. Order-independent. */
export function contrastRatio(a: Oklch, b: Oklch): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA, normal text (<18.66px regular / <24px bold). */
export const WCAG_AA_NORMAL_TEXT = 4.5;

/** WCAG AA, large text. Recorded for completeness; the palette is asserted at the stricter bar. */
export const WCAG_AA_LARGE_TEXT = 3;

/** Parse the `oklch(L C H)` form the token file is authored in. */
export function parseOklch(value: string): Oklch {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim());
  if (!match) throw new Error(`Not an oklch() colour: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
