import tokens from './tokens.json';

/**
 * Design tokens, carried forward verbatim from V2's
 * shared/design-tokens.json (V3_MIGRATION_MATRIX.md: DIRECT REUSE, "already
 * backend-agnostic plain JSON with zero WP coupling").
 *
 * Consumers should prefer the CSS custom properties (see tokens.css, which
 * is generated from this same JSON) for styling, and these typed constants
 * only where a value is genuinely needed in TS (e.g. a breakpoint used in a
 * media-query hook). Never hardcode a token value at a call site.
 */
export const designTokens = tokens;

export const BREAKPOINT_MOBILE = tokens.breakpoint.mobile;
export const CONTENT_MAX_WIDTH = tokens.spacing.contentMaxWidth;
export const FONT_FAMILY = tokens.typography.fontFamily;

/** `--bc-color-primary`, `--bc-radius-card`, ... — the naming convention the generated CSS uses. */
export function cssVar(group: string, name: string): string {
  return `var(--bc-${group}-${name})`;
}

/**
 * The design's three ranges (`V3.3_RESPONSIVE_AND_A11Y_HANDOFF.md` §1):
 * mobile < 640, tablet 640–1023, desktop >= 1024. `tokens.json` is the one
 * place they are written. CSS cannot read JSON, so a stylesheet retypes them
 * in its `@media` queries — `apps/web/test/breakpoints.spec.ts` compares every
 * such query with these values so a retyped number that drifts fails a test
 * rather than shipping as a layout that changes at a width nobody chose.
 */
export const BREAKPOINT_TABLET = tokens.breakpoint.tablet;
export const BREAKPOINT_DESKTOP = tokens.breakpoint.desktop;
