import type { ValidationError } from 'class-validator';

/**
 * The client-safe shape of one `class-validator` `ValidationError`, after
 * `sanitizeValidationErrors` (#172).
 *
 * Deliberately excludes `value` and `target`: `class-validator` populates
 * both by default (a `ValidationError`'s `target` is the ENTIRE object being
 * validated, not just the failing field -- see `sanitizeValidationErrors`'s
 * own docblock), and neither has ever been vetted for what a caller may put
 * in it. `property` and `constraints` are safe because they are either a
 * field NAME (never a value) or a message that is either one of this
 * codebase's own hand-authored Persian strings or one of class-validator's
 * built-in templates -- none of which embed the submitted value (see the
 * non-vacuity note in `sanitize-validation-errors.spec.ts`).
 */
export interface SafeValidationError {
  property: string;
  constraints: string[];
  children?: SafeValidationError[];
}

/**
 * Strips `value` and `target` from a `class-validator` `ValidationError[]`
 * -- recursively, through `children` -- before it can reach
 * `ValidationException.details` and, from there, the public HTTP response.
 *
 * #172: the global `ValidationPipe`'s `exceptionFactory`
 * (`apps/api/src/main.ts`) used to hand the RAW array straight to
 * `new ValidationException(errors)`. Every `ValidationError.target` is the
 * whole object being validated (every field the caller submitted, valid or
 * not) and every `ValidationError.value` is the exact submitted value of the
 * failing field -- both were serialised verbatim into the client-facing
 * `400` body by `BeauClickExceptionFilter`, which forwards any
 * `DomainException`'s `details` unchanged (correct for the hand-curated
 * `details` other exceptions use; wrong for an entire third-party library's
 * internal error object). This is the one function standing between that
 * object and the client.
 *
 * `property` and `constraints` are kept because a client needs to know
 * WHICH field was wrong and WHY in order to fix its request -- dropping them
 * too would make the error useless, not just safe.
 */
export function sanitizeValidationErrors(errors: readonly ValidationError[]): SafeValidationError[] {
  return errors.map(sanitizeOne);
}

function sanitizeOne(error: ValidationError): SafeValidationError {
  const safe: SafeValidationError = {
    property: error.property,
    constraints: error.constraints ? Object.values(error.constraints) : [],
  };
  if (error.children && error.children.length > 0) {
    safe.children = sanitizeValidationErrors(error.children);
  }
  return safe;
}
