import { HttpStatus } from '@nestjs/common';

import { DomainException } from '@beauclick/http';

/**
 * The seller finance surface's refusals — V3.3 #72, `V33-DEC-020`.
 *
 * ## Only ONE new code, and it discloses nothing
 *
 * Every reference failure on the workspace-aware routes reuses
 * `NotFoundOrNotYoursException` from `libs/ownership`: one code, one Persian
 * message, no `details`, so malformed, foreign, stale and unowned references
 * produce byte-identical bodies without any further effort. Adding a
 * finance-specific "bad reference" code would have been the enumeration oracle
 * the whole surface is built to avoid.
 *
 * The one genuinely new outcome is below, and it names a fact about the
 * caller's OWN account, told only to that caller.
 */

/**
 * The caller owns more than one finance workspace and used a legacy singular
 * route, which cannot answer for both.
 *
 * ## Why a refusal rather than a choice
 *
 * This is the #72 defect stated as a status code. The singular routes used to
 * resolve one party business-first and answer about it silently, so a dual
 * owner was shown an incomplete financial position with nothing indicating
 * another workspace existed. `V33-DEC-020` forbids first-in-array,
 * business-first, professional-first and affiliation-derived selection alike —
 * which leaves refusing, and naming where the answer actually lives.
 *
 * A `409`, not a `400`: the request was well-formed and authorized, and the
 * conflict is with the caller's own account shape rather than their input.
 *
 * ## The code is lower-case, and that is deliberate
 *
 * `V33-DEC-020` ratifies the literal `finance_workspace_selection_required`.
 * Every other browser-facing code in this repository is SCREAMING_SNAKE, so
 * this is the one exception — kept as ratified rather than silently
 * case-normalised, because the decision is the contract and a code is a literal
 * a client compares against.
 *
 * ## What it does NOT disclose
 *
 * Only that the caller owns more than one workspace. Not how many, not which
 * types, not any figure from either, and nothing about anybody else. A caller
 * who owns two already knows they own two.
 */
export class FinanceWorkspaceSelectionRequiredException extends DomainException {
  constructor() {
    super(
      'finance_workspace_selection_required',
      'شما بیش از یک کسب‌وکار دارید. لطفاً یکی را انتخاب کنید.',
      HttpStatus.CONFLICT,
    );
  }
}
