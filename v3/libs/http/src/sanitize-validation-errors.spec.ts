import 'reflect-metadata';
import { plainToInstance, Type } from 'class-transformer';
import { IsIn, IsInt, IsString, Length, Matches, Max, MaxLength, Min, ValidateNested, validate } from 'class-validator';
import { sanitizeValidationErrors } from './sanitize-validation-errors';

/**
 * #172 regression suite.
 *
 * These DTOs deliberately mirror the SHAPE of two real, production DTOs this
 * defect was confirmed against (see `ClaudeResultReport.md` in the
 * `validation-echo-audit` worktree): an OTP/phone verification payload
 * (`services/identity/src/auth/dto/verify-otp.dto.ts`) and an admin
 * legal-evidence payload with a nested retention rule
 * (`services/commercial-policy/src/outcome-policy/booking-outcome-policy.dto.ts`).
 * They live here, rather than importing the real classes, because `libs/http`
 * is a foundational library that every domain service depends ON -- it must
 * not depend back on `identity`/`commercial-policy`. The full production
 * DTOs are exercised directly, through the real HTTP stack, in
 * `apps/api/test/auth.e2e-spec.ts` and
 * `apps/api/test/validation-error-echo-regression.e2e-spec.ts`.
 */
class MirrorVerifyOtpDto {
  @IsString()
  @Matches(/^(\+98|0098|98|0)?9\d{9}$/)
  phone!: string;

  @IsString()
  @Length(6, 6)
  code!: string;

  @IsIn(['login', 'change_phone'])
  purpose!: string;
}

class MirrorRetentionRuleDto {
  @IsIn(['fixed_toman', 'percentage_of_collected'])
  kind!: string;

  @IsInt()
  @Min(1)
  @Max(10_000_000_000_000)
  amountToman?: number;
}

class MirrorLegalEvidenceDto {
  @IsString()
  @MaxLength(2000)
  reason!: string;

  @IsString()
  @MaxLength(500)
  reference!: string;

  @ValidateNested({ each: true })
  @Type(() => MirrorRetentionRuleDto)
  options!: MirrorRetentionRuleDto[];
}

const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

describe('sanitizeValidationErrors (#172)', () => {
  it('drops `value` and `target` from a top-level error, keeping `property` and the constraint message', async () => {
    const canaryCode = 'CANARY_OTP_ATTEMPT_9f8a';
    const instance = plainToInstance(MirrorVerifyOtpDto, { phone: '09121234567', code: canaryCode, purpose: 'login' });
    const errors = await validate(instance, PIPE_OPTIONS);

    const safe = sanitizeValidationErrors(errors);
    const serialized = JSON.stringify(safe);

    expect(serialized).not.toContain(canaryCode);
    expect(serialized).not.toContain('"value"');
    expect(serialized).not.toContain('"target"');
    // Non-vacuity: the field name and a human-readable reason must survive --
    // a fix that also deleted `property`/`constraints` would "pass" a naive
    // absence check while making the error useless.
    const codeError = safe.find((e) => e.property === 'code');
    expect(codeError).toBeDefined();
    expect(codeError!.constraints.length).toBeGreaterThan(0);
  });

  it('a VALID sibling field is not exposed via `target` just because another field on the same object failed', async () => {
    const canaryPhone = '09129998877'; // valid shape -- passes @Matches on its own
    const instance = plainToInstance(MirrorVerifyOtpDto, { phone: canaryPhone, code: 'toolong-code', purpose: 'login' });
    const errors = await validate(instance, PIPE_OPTIONS);
    expect(errors.some((e) => e.property === 'phone')).toBe(false); // confirms phone itself is valid

    const serialized = JSON.stringify(sanitizeValidationErrors(errors));
    expect(serialized).not.toContain(canaryPhone);
  });

  it('POSITIVE CONTROL: the same raw errors, unsanitized, DO contain the canary -- proving this test would have caught the pre-#172 behavior', async () => {
    const canaryPhone = '09129998877';
    const instance = plainToInstance(MirrorVerifyOtpDto, { phone: canaryPhone, code: 'toolong-code', purpose: 'login' });
    const errors = await validate(instance, PIPE_OPTIONS);

    // This is exactly what `main.ts`'s exceptionFactory passed to
    // `ValidationException` before #172 -- the raw array, unsanitized.
    expect(JSON.stringify(errors)).toContain(canaryPhone);
  });

  it('strips `value`/`target` recursively through nested `@ValidateNested` children, at every depth', async () => {
    const canary = 'CANARY_NESTED_VALUE_should_not_leak';
    const instance = plainToInstance(MirrorLegalEvidenceDto, {
      reason: 'a valid reason string',
      reference: 'a valid reference string',
      options: [{ kind: 'fixed_toman', amountToman: canary }],
    });
    const errors = await validate(instance, PIPE_OPTIONS);
    // Sanity: this really did produce a nested error (children present) --
    // otherwise the test below would vacuously pass.
    expect(errors.some((e) => e.children && e.children.length > 0)).toBe(true);

    const serialized = JSON.stringify(sanitizeValidationErrors(errors));
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain('"value"');
    expect(serialized).not.toContain('"target"');
    // Non-vacuity: the nested field's own name and reason must survive.
    expect(serialized).toContain('amountToman');
  });

  it('an unknown/whitelist-violating field still names the offending property without echoing its submitted value', async () => {
    const canary = 'CANARY_UNKNOWN_FIELD_VALUE';
    const instance = plainToInstance(MirrorVerifyOtpDto, { phone: '09121234567', code: '123456', purpose: 'login', extra: canary });
    const errors = await validate(instance, PIPE_OPTIONS);

    const serialized = JSON.stringify(sanitizeValidationErrors(errors));
    expect(serialized).not.toContain(canary);
    expect(serialized).toContain('extra'); // the field NAME is still surfaced
  });

  it('ordinary (non-sensitive) validation errors remain informative: field name and message text are unchanged in substance', async () => {
    const instance = plainToInstance(MirrorVerifyOtpDto, { phone: '09121234567', code: '123456', purpose: 'not-a-real-purpose' });
    const errors = await validate(instance, PIPE_OPTIONS);
    const safe = sanitizeValidationErrors(errors);

    expect(safe).toEqual([
      {
        property: 'purpose',
        constraints: expect.arrayContaining([expect.stringContaining('purpose must be one of the following values')]),
      },
    ]);
  });

  it('a fully valid object produces zero errors, so sanitization never runs and nothing is echoed', async () => {
    const instance = plainToInstance(MirrorVerifyOtpDto, { phone: '09121234567', code: '123456', purpose: 'login' });
    const errors = await validate(instance, PIPE_OPTIONS);
    expect(errors).toHaveLength(0);
    expect(sanitizeValidationErrors(errors)).toEqual([]);
  });
});
