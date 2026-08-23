import { Transform } from 'class-transformer';
import { IsIn, IsString, Length, Matches } from 'class-validator';
import { normalizeDigits } from '@beauclick/persian-utils';

/** See request-otp.dto.ts for why this fold has to happen before validation. */
const foldDigits = () => Transform(({ value }) => (typeof value === 'string' ? normalizeDigits(value) : value));

export class VerifyOtpDto {
  @foldDigits()
  @Matches(/^(\+98|0098|98|0)?9\d{9}$/, { message: 'شماره موبایل نامعتبر است.' })
  phone!: string;

  /**
   * The code is folded too, and this one is not cosmetic: `OtpService`
   * HMACs the string verbatim, so '۱۲۳۴۵۶' and '123456' hash differently.
   * A correct code read off an SMS and retyped on a Persian keyboard would
   * otherwise be scored WRONG *and* decrement `attemptsRemaining` --
   * locking the code out entirely after five tries, with the deliberately
   * generic "invalid or expired" message giving the user no way to tell why.
   *
   * `@Length(6, 6)` still runs after the fold, so folding cannot smuggle a
   * short or long code past the length check.
   */
  @foldDigits()
  @IsString()
  @Length(6, 6)
  code!: string;

  @IsIn(['login', 'change_phone', 'confirm_deletion'])
  purpose: 'login' | 'change_phone' | 'confirm_deletion' = 'login';
}
