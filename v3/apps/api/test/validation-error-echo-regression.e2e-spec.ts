import 'reflect-metadata';
import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BeauClickExceptionFilter, ValidationException, sanitizeValidationErrors } from '@beauclick/http';
import { RecordLegalEvidenceDto, WriteBookingOutcomePolicyVersionDto } from '@beauclick/commercial-policy';

/**
 * #172 regression: the global `ValidationPipe`'s `exceptionFactory`
 * (`apps/api/src/main.ts`) used to hand class-validator's RAW
 * `ValidationError[]` straight to `new ValidationException(errors)`, whose
 * `details` `BeauClickExceptionFilter` then serialised verbatim into the
 * public 400 response -- `target` (the whole submitted body) and `value`
 * (the exact submitted value) included, recursively through `children`.
 *
 * This suite drives the REAL production admin commercial-policy DTOs
 * (`RecordLegalEvidenceDto`, `WriteBookingOutcomePolicyVersionDto`) through
 * the REAL `class-validator`/`class-transformer` pipeline with the exact
 * options `main.ts` passes, then through the REAL `sanitizeValidationErrors`
 * -> `ValidationException` -> `BeauClickExceptionFilter.catch()` chain --
 * i.e. the actual production error-response code, not a re-implementation of
 * it -- using the same fake-`ArgumentsHost` pattern as
 * `beauclick-exception.filter.spec.ts`. No Nest application, database, or
 * network is involved: these DTOs live in `@beauclick/commercial-policy`,
 * which the fast in-memory (`test-app.factory.ts`) harness does not wire up
 * (its own docblock: "no commercial-policy module, no control singleton and
 * no governance table"), so this is the fastest route to a genuine
 * production-code proof for this specific route family without a real
 * Postgres instance.
 */

const PIPE_VALIDATOR_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

function fakeHost() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as unknown as ArgumentsHost;
  return { host, status, json };
}

/** The literal wire-format body `BeauClickExceptionFilter` sends for a given `ValidationException`. */
function wireBodyFor(exception: ValidationException): unknown {
  const filter = new BeauClickExceptionFilter();
  const { host, json } = fakeHost();
  filter.catch(exception, host);
  return json.mock.calls[0][0];
}

describe('production validation-error response (#172)', () => {
  it('admin legal-evidence: a bad enum field does not cause the free-text `reference`/`summary` sibling fields to leak, even though they themselves are valid', async () => {
    const canaryReference = 'CANARY_EVIDENCE_REFERENCE_where the file actually lives';
    const canarySummary = 'CANARY_EVIDENCE_SUMMARY_what the evidence actually shows';

    const instance = plainToInstance(RecordLegalEvidenceDto, {
      reason: 'a valid admin justification, well within length limits',
      evidenceKey: 'a-valid-evidence-key',
      subject: 'CANARY_BAD_SUBJECT_not_a_real_enum_member', // the ONE deliberately-invalid field
      referenceKind: 'document_reference',
      reference: canaryReference, // valid on its own -- must not leak via `target`
      summary: canarySummary, // valid on its own -- must not leak via `target`
    });
    const errors = await validate(instance, PIPE_VALIDATOR_OPTIONS);
    // Sanity: this really did fail validation (on `subject` only) -- otherwise
    // the assertions below would be vacuous.
    expect(errors.map((e) => e.property)).toEqual(['subject']);

    const body = wireBodyFor(new ValidationException(sanitizeValidationErrors(errors)));
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain(canaryReference);
    expect(serialized).not.toContain(canarySummary);
    expect(serialized).not.toContain('"value"');
    expect(serialized).not.toContain('"target"');
    // Non-vacuity: the caller must still be told `subject` was the problem.
    expect(serialized).toContain('subject');

    // POSITIVE CONTROL: the exact same errors, unsanitized (i.e. #172's
    // pre-fix behavior), DO leak both free-text fields through this SAME
    // real filter -- proving this test would have caught the regression.
    const preFixBody = wireBodyFor(new ValidationException(errors));
    const preFixSerialized = JSON.stringify(preFixBody);
    expect(preFixSerialized).toContain(canaryReference);
    expect(preFixSerialized).toContain(canarySummary);
  });

  it('admin booking-outcome-policy: a malformed nested `lateRetentionOptions[]` member does not leak through `children[].children[]`', async () => {
    const canary = 'CANARY_NESTED_AMOUNT_TOMAN_not_a_number';

    const instance = plainToInstance(WriteBookingOutcomePolicyVersionDto, {
      reason: 'a valid admin justification',
      cutoffHoursAllowed: [1, 2],
      lateRetentionOptions: [{ kind: 'fixed_toman', amountToman: canary }],
      noShowGraceMinutesAllowed: [10],
      noShowRetentionOptions: [{ kind: 'fixed_toman', amountToman: 1000 }],
      rescheduleFreeCountBeforeCutoff: 1,
      disputeWindowHours: 24,
      appealWindowHours: 48,
    });
    const errors = await validate(instance, PIPE_VALIDATOR_OPTIONS);
    // Sanity: this really did produce a NESTED error two levels deep
    // (lateRetentionOptions[0].amountToman) -- otherwise the recursion this
    // test exists to check was never exercised.
    const topError = errors.find((e) => e.property === 'lateRetentionOptions');
    expect(topError?.children?.[0]?.children?.[0]?.property).toBe('amountToman');

    const body = wireBodyFor(new ValidationException(sanitizeValidationErrors(errors)));
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain('"value"');
    expect(serialized).not.toContain('"target"');
    expect(serialized).toContain('amountToman');

    // POSITIVE CONTROL.
    const preFixSerialized = JSON.stringify(wireBodyFor(new ValidationException(errors)));
    expect(preFixSerialized).toContain(canary);
  });

  it('preserves status, code, and Persian message exactly as before -- only `details` changed shape', async () => {
    const instance = plainToInstance(RecordLegalEvidenceDto, { reason: '', evidenceKey: '', subject: '', referenceKind: '', reference: '', summary: '' });
    const errors = await validate(instance, PIPE_VALIDATOR_OPTIONS);
    const exception = new ValidationException(sanitizeValidationErrors(errors));

    expect(exception.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(exception.code).toBe('VALIDATION_ERROR');

    const body = wireBodyFor(exception) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('اطلاعات ارسال‌شده نامعتبر است.');
  });
});
