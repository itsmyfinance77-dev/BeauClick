import { formatToman } from '@beauclick/persian-utils';

/**
 * An amount of money, rendered the one way this product renders money —
 * `V3_DESIGN_SYSTEM.md` §«پول»: Persian digits and `٬` as the thousands
 * separator.
 *
 * `formatToman` was called directly in seventeen files. This is that one
 * rendering named once, and the place the design's money rules land when they
 * change.
 *
 * ## It renders no element of its own, deliberately
 *
 * It returns the text and nothing else, so the DOM is byte-for-byte what
 * `{formatToman(amount)}` produced. That is not laziness about styling: it is
 * the only shape that lets a caller wrap money in a `<dd>`, a `<td>`, a
 * `<strong>`, a bidi isolate or a 30px price block without this component
 * having an opinion — and it keeps «۲۰۰٬۰۰۰ تومان» a single run of text
 * rather than splitting the figure away from its unit.
 *
 * It carries no CSS either, and does not need any: `globals.css` already sets
 * `font-variant-numeric: tabular-nums` on `body`, so every figure in the app
 * is tabular by inheritance. A rule here would be a redundant declaration
 * that looks load-bearing.
 *
 * ## What this deliberately does not do
 *
 * **It does not render «تومان».** The design's rule is «واحد یک بار در هر
 * بلوک نه روی هر رقم» — the unit belongs to the block (a column header, a
 * stat label, a sentence), not to the figure, so a figure component cannot be
 * the thing that decides. Callers place the unit as they do today.
 *
 * ## Integer Toman
 *
 * `formatToman` rounds, and that rounding never fires here: every `…Toman`
 * field the API returns goes through `@beauclick/money`, whose `assertAmount`
 * THROWS on a fractional Toman rather than rounding it, and whose percentage
 * splits (`percentOf`) round to an integer before anything is stored. So the
 * rounding is a safety net over values that are already whole, not a
 * behaviour any screen depends on.
 */
export function PriceDisplay({ amount }: { amount: number }) {
  return <>{formatToman(amount)}</>;
}
