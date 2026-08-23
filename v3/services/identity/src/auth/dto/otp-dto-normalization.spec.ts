import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RequestOtpDto } from './request-otp.dto';
import { VerifyOtpDto } from './verify-otp.dto';
import { canonicalizePhone } from '../phone.util';

/**
 * BeauClick is a Persian-only product (V3_FRONTEND_ARCHITECTURE.md §7: no
 * language switcher exists). A Persian-speaking user on a Persian soft
 * keyboard types their phone number as ۰۹۱۲۳۴۵۶۷۸۹, not 09123456789 --
 * and Arabic-locale IMEs that Persian speakers genuinely use emit the
 * Arabic-Indic range (٠٩١٢…) instead.
 *
 * `canonicalizePhone` was built to accept exactly that, and says so. These
 * tests assert the DTO gate IN FRONT of it agrees, because a validator
 * that rejects what the canonicalizer accepts makes the canonicalizer's
 * Persian support unreachable over HTTP -- which reads to the user as
 * "this site will not let me log in".
 *
 * Same rule for the OTP code itself: a code typed as ۱۲۳۴۵۶ must verify
 * against the ASCII code that was actually issued, not burn one of the
 * five attempts and eventually lock the code out.
 *
 * The mapping used here is `normalizeDigits` from @beauclick/persian-utils
 * -- the same one search's own DTO already uses (services/search/src/dto/
 * search.dto.ts), for the same reason, stated there as "one implementation
 * of the mapping, used both directions, so the two cannot disagree".
 */

function validateDto<T extends object>(cls: new () => T, payload: Record<string, unknown>) {
  const dto = plainToInstance(cls, payload);
  const errors = validateSync(dto as object, { whitelist: true });
  return { dto, errors };
}

const ASCII_PHONE = '09123456789';
const PERSIAN_PHONE = '۰۹۱۲۳۴۵۶۷۸۹';
const ARABIC_INDIC_PHONE = '٠٩١٢٣٤٥٦٧٨٩';

describe('RequestOtpDto — phone digit normalization', () => {
  it('accepts an ASCII-digit phone (the already-working baseline)', () => {
    const { errors } = validateDto(RequestOtpDto, { phone: ASCII_PHONE, purpose: 'login' });
    expect(errors).toHaveLength(0);
  });

  it('accepts a Persian-digit phone, because canonicalizePhone does', () => {
    // Proof the two layers must agree: the canonicalizer resolves this to
    // the identical E.164 number as the ASCII spelling.
    expect(canonicalizePhone(PERSIAN_PHONE)).toBe('+989123456789');
    expect(canonicalizePhone(PERSIAN_PHONE)).toBe(canonicalizePhone(ASCII_PHONE));

    const { errors } = validateDto(RequestOtpDto, { phone: PERSIAN_PHONE, purpose: 'login' });
    expect(errors).toHaveLength(0);
  });

  it('accepts an Arabic-Indic-digit phone, which Persian-speaker IMEs emit', () => {
    expect(canonicalizePhone(ARABIC_INDIC_PHONE)).toBe('+989123456789');

    const { errors } = validateDto(RequestOtpDto, { phone: ARABIC_INDIC_PHONE, purpose: 'login' });
    expect(errors).toHaveLength(0);
  });

  it('still rejects a genuinely invalid number, in either numeral system', () => {
    // Normalization must widen the accepted numeral systems, never widen
    // what counts as a valid Iranian mobile number.
    expect(validateDto(RequestOtpDto, { phone: '12345', purpose: 'login' }).errors.length).toBeGreaterThan(0);
    expect(validateDto(RequestOtpDto, { phone: '۱۲۳۴۵', purpose: 'login' }).errors.length).toBeGreaterThan(0);
    // A landline (does not start with 9 after the trunk prefix) stays invalid.
    expect(validateDto(RequestOtpDto, { phone: '۰۲۱۸۸۷۷۶۶۵۵', purpose: 'login' }).errors.length).toBeGreaterThan(0);
  });
});

describe('VerifyOtpDto — phone and code digit normalization', () => {
  it('accepts a Persian-digit phone', () => {
    const { errors } = validateDto(VerifyOtpDto, { phone: PERSIAN_PHONE, code: '123456', purpose: 'login' });
    expect(errors).toHaveLength(0);
  });

  it('folds a Persian-digit CODE to ASCII, so it hashes to the issued code', () => {
    // The code is HMAC'd verbatim by OtpService. '۱۲۳۴۵۶' and '123456'
    // hash differently, so without folding here a correct code read off an
    // SMS and retyped on a Persian keyboard is scored as WRONG -- and
    // decrements attemptsRemaining, locking the code out after five tries.
    const { dto, errors } = validateDto(VerifyOtpDto, {
      phone: ASCII_PHONE,
      code: '۱۲۳۴۵۶',
      purpose: 'login',
    });
    expect(errors).toHaveLength(0);
    expect(dto.code).toBe('123456');
  });

  it('folds an Arabic-Indic code too', () => {
    const { dto, errors } = validateDto(VerifyOtpDto, {
      phone: ASCII_PHONE,
      code: '٤٥٦٧٨٩',
      purpose: 'login',
    });
    expect(errors).toHaveLength(0);
    expect(dto.code).toBe('456789');
  });

  it('leaves an ASCII code untouched', () => {
    const { dto } = validateDto(VerifyOtpDto, { phone: ASCII_PHONE, code: '098765', purpose: 'login' });
    expect(dto.code).toBe('098765');
  });

  it('still enforces the six-digit length after folding', () => {
    // Folding must not become a way to smuggle a short or long code past
    // the length check.
    expect(validateDto(VerifyOtpDto, { phone: ASCII_PHONE, code: '۱۲۳', purpose: 'login' }).errors.length).toBeGreaterThan(0);
    expect(
      validateDto(VerifyOtpDto, { phone: ASCII_PHONE, code: '۱۲۳۴۵۶۷۸', purpose: 'login' }).errors.length,
    ).toBeGreaterThan(0);
  });
});
