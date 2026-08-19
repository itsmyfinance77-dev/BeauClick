/**
 * V3_MIGRATION_MATRIX.md Authentication section: "Phone canonicalization |
 * DIRECT REUSE (near-verbatim) | Pure function, zero WP dependency."
 * Normalizes every accepted input format (local 09..., international
 * +98.../0098.../98..., Persian/Arabic-Indic digit variants, spaces/dashes)
 * to one canonical E.164 form (+98XXXXXXXXX) before any comparison,
 * storage, or lookup -- per V3_SECURITY_MODEL.md §1.
 */

const PERSIAN_TO_ASCII_DIGITS: Record<string, string> = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

function toAsciiDigits(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (d) => PERSIAN_TO_ASCII_DIGITS[d] ?? d);
}

/** Returns the canonical +98XXXXXXXXX form, or null if the input isn't a real Iranian mobile number. */
export function canonicalizePhone(input: string): string | null {
  const digitsOnly = toAsciiDigits(input).replace(/[\s\-()]/g, '');
  const match = digitsOnly.match(/^(?:\+98|0098|98|0)?(9\d{9})$/);
  if (!match) return null;
  return `+98${match[1]}`;
}
