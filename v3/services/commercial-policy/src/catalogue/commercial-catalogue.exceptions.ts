import { HttpStatus } from '@nestjs/common';

import { DomainException } from '@beauclick/http';

/**
 * The catalogue's refusals.
 *
 * ## Why these are distinguishable, and where the line is
 *
 * Issue #40 asks that validation failures be distinguishable without leaking
 * internal state, and those are two requirements pulling in opposite
 * directions. The line drawn here:
 *
 *  * an administrator holding `bc_manage_commercial_plans` may already read the
 *    entire catalogue, so telling them a key exists, a version is retired, or a
 *    window overlaps discloses nothing they could not fetch. Those refusals are
 *    specific, because a vague one would make the surface unusable;
 *  * nobody else reaches these codes at all. Every route is capability-gated, so
 *    an unauthorized caller receives `FORBIDDEN` from the guard and never
 *    learns whether the key in their URL exists.
 *
 * What is never disclosed, to anyone: a constraint name, a SQL fragment, a
 * trigger's text, or a row id the caller did not supply.
 *
 * Messages are Persian, as `V3_API_CONTRACT_BLUEPRINT.md` §6 requires of every
 * intentional error.
 */

export class CommercialKeyExistsException extends DomainException {
  constructor() {
    super('COMMERCIAL_KEY_EXISTS', 'این شناسه از پیش تعریف شده است.', HttpStatus.CONFLICT);
  }
}

export class CommercialNotFoundException extends DomainException {
  constructor() {
    super('COMMERCIAL_NOT_FOUND', 'موردی با این مشخصات یافت نشد.', HttpStatus.NOT_FOUND);
  }
}

/**
 * The lifecycle refused the transition, or the row is frozen.
 *
 * One code for both, deliberately. "This is already published" and "this is
 * retired and can never change" are the same answer to the caller — *not
 * through this route, ever* — and the `detail` says which without either being
 * a different kind of failure.
 */
export class CommercialLifecycleConflictException extends DomainException {
  constructor(detail: string) {
    super('COMMERCIAL_LIFECYCLE_CONFLICT', 'وضعیت این نسخه اجازه این تغییر را نمی‌دهد.', HttpStatus.CONFLICT, {
      detail,
    });
  }
}

/** Two versions of one key cannot be active at once. Raised from the database's own refusal. */
export class CommercialActivationOverlapException extends DomainException {
  constructor() {
    super(
      'COMMERCIAL_ACTIVATION_OVERLAP',
      'بازه فعال‌سازی با نسخه دیگری هم‌پوشانی دارد.',
      HttpStatus.CONFLICT,
    );
  }
}

/** The terms are structurally wrong — a gap between tiers, an overlap, a bad bound. */
export class CommercialTermsInvalidException extends DomainException {
  constructor(problems: readonly string[]) {
    super('COMMERCIAL_TERMS_INVALID', 'شرایط واردشده معتبر نیست.', HttpStatus.UNPROCESSABLE_ENTITY, {
      problems,
    });
  }
}

/**
 * `V33-DEC-009`: an unconfigured plan or price schedule refuses safely rather
 * than falling back to any default.
 *
 * This is that refusal, and it is a distinct code precisely so a caller cannot
 * mistake it for a validation error and retry with different input. There is
 * nothing to retry: nothing is configured.
 */
export class CommercialNotConfiguredException extends DomainException {
  constructor(detail: string) {
    super(
      'COMMERCIAL_NOT_CONFIGURED',
      'برای این مورد هیچ پیکربندی فعالی وجود ندارد.',
      HttpStatus.CONFLICT,
      { detail },
    );
  }
}

/**
 * Every administrator mutation states why.
 *
 * Refused BEFORE the mutation is attempted, so a blank reason leaves nothing
 * written in either the domain tables or the audit log — which is the property
 * the rollback tests assert. A privileged action with no stated reason is one
 * nobody can review later, and that is the whole failure `libs/audit` exists to
 * prevent.
 */
export class CommercialReasonRequiredException extends DomainException {
  constructor() {
    super('COMMERCIAL_REASON_REQUIRED', 'ثبت دلیل برای این عملیات الزامی است.', HttpStatus.BAD_REQUEST);
  }
}
