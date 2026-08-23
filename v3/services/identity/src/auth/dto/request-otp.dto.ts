import { Transform } from 'class-transformer';
import { IsIn, Matches } from 'class-validator';
import { normalizeDigits } from '@beauclick/persian-utils';

/**
 * Fold Persian (۰–۹) and Arabic-Indic (٠–٩) digits to ASCII *before*
 * validation runs.
 *
 * `@Matches`'s `\d` is ASCII-only, so without this the validator rejects
 * exactly the numeral systems `canonicalizePhone` was written to accept
 * (see phone.util.ts) -- making that support unreachable over HTTP and
 * locking Persian-keyboard users out of the only entry point the product
 * has. Same utility, same reason, as search's own DTO
 * (services/search/src/dto/search.dto.ts): one implementation of the
 * mapping so the layers cannot disagree.
 *
 * Non-string input is passed through untouched for the validator to reject
 * on its own terms.
 */
const foldDigits = () => Transform(({ value }) => (typeof value === 'string' ? normalizeDigits(value) : value));

/** Iranian mobile shape after canonicalization: 9 + 9 digits (see phone.util.ts). */
export class RequestOtpDto {
  @foldDigits()
  @Matches(/^(\+98|0098|98|0)?9\d{9}$/, { message: 'شماره موبایل نامعتبر است.' })
  phone!: string;

  @IsIn(['login', 'change_phone', 'confirm_deletion'])
  purpose: 'login' | 'change_phone' | 'confirm_deletion' = 'login';
}
