/**
 * Persian/Arabic-Indic digit conversion.
 *
 * Split out of `format.ts` in V3.1 Phase G for one structural reason: closing
 * `R31-09` required `format.ts`'s date helpers to delegate to `zoned.ts`, and
 * `zoned.ts` already imported `toPersianDigits` from `format.ts`. Leaving both
 * imports in place would have created a module cycle whose correctness rested
 * on function-declaration hoisting surviving every bundler this package is
 * built by. One leaf module both sides depend on has no such dependency.
 *
 * The functions themselves are unchanged, and `format.ts` re-exports them, so
 * no importer anywhere sees a difference.
 */

const PERSIAN_DIGITS = [ '۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹' ];

export function toPersianDigits( input: string | number ): string {
	return String( input ).replace( /[0-9]/g, ( d ) => PERSIAN_DIGITS[ Number( d ) ] );
}

/**
 * The inverse of `toPersianDigits`: Persian (۰–۹, U+06F0–U+06F9) and
 * Arabic-Indic (٠–٩, U+0660–U+0669) digits folded to ASCII.
 *
 * Added in Phase 3 for the input direction. Every number a Persian-speaking
 * user types — a price filter, a page number, a budget — arrives in Persian
 * digits, and `Number('۵۰۰')` is `NaN`. Without this, a perfectly valid
 * filter is rejected as malformed, which reads to the user as the feature
 * being broken.
 *
 * BOTH digit ranges are folded, not just the Persian one: Arabic-Indic
 * digits arrive from Arabic-locale keyboards and mobile IMEs that Persian
 * speakers genuinely use, and V2's own search normalizer had exactly this
 * pair for exactly that reason.
 *
 * Note the asymmetry with `toPersianDigits`, which is deliberate: output is
 * always Persian, input accepts anything. A user must never have to know
 * which numeral system the system prefers.
 */
export function normalizeDigits( input: string ): string {
	return input.replace( /[۰-۹٠-٩]/g, ( d ) => {
		const code = d.charCodeAt( 0 );
		const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
		return String( code - base );
	} );
}
