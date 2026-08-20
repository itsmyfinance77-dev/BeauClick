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
