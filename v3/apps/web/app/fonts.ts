import localFont from 'next/font/local';

/**
 * The two typefaces of the V3.3 design language — `V3_DESIGN_SYSTEM.md` §3.
 *
 * "دو قلم. هیچ قلمِ سوم." Vazir carries every word, every numeral and every
 * platform; Anjoman carries the customer platform's DISPLAY headings only
 * (>= 24px), and never appears in body copy, forms, tables, the pro panel or
 * admin. The prototypes also ship Peyda; the design system supersedes them on
 * this point and Peyda is deliberately not imported.
 *
 * ## Why this file exists at all
 *
 * Until now nothing loaded a font. `--bc-font-family` named `'Vazirmatn'` and
 * no `@font-face`, `next/font` or `<link>` ever fetched it, so every Persian
 * glyph in the product rendered in whatever the operating system happened to
 * substitute. That is the single defect that explains the product's whole
 * appearance (`V3.3_DESIGN_CONFORMANCE_AUDIT.md` §1-1).
 *
 * ## Vazir is one variable file, not six static ones
 *
 * `Vazir-Variable.woff2` carries a `wght` axis from 100 to 900, so the entire
 * weight range of the type scale costs 41KB once rather than six downloads.
 * Anjoman has no variable cut, so only the two display weights the scale
 * actually names are shipped: 800 (display 2) and 900 (display 1).
 *
 * `display: 'swap'` throughout: Persian text in a fallback face for 100ms is
 * better than invisible text, and `next/font` emits the size-adjust metrics
 * that keep the swap from reflowing the page.
 */

export const vazir = localFont({
  src: [{ path: './fonts/Vazir-Variable.woff2', weight: '100 900', style: 'normal' }],
  variable: '--bc-font-vazir',
  display: 'swap',
  // The family keeps its Vazirmatn name: that is what `tokens.css` and every
  // prototype reference, and Vazirmatn is this same typeface's current name.
  fallback: ['Vazirmatn', 'Tahoma', 'system-ui', 'sans-serif'],
  adjustFontFallback: false,
});

export const anjoman = localFont({
  src: [
    { path: './fonts/Anjoman-ExtraBold.woff2', weight: '800', style: 'normal' },
    { path: './fonts/Anjoman-Black.woff2', weight: '900', style: 'normal' },
  ],
  variable: '--bc-font-anjoman',
  display: 'swap',
  fallback: ['Vazirmatn', 'Tahoma', 'system-ui', 'sans-serif'],
  adjustFontFallback: false,
  // Display headings are above the fold on the customer platform's landing
  // and search surfaces, so the two cuts are preloaded rather than discovered.
  preload: true,
});
