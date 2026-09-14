import { HttpStatus } from '@nestjs/common';

import { DomainException } from '@beauclick/http';
import { OUTCOME_POLICY_ASSIGNMENT_UNAVAILABLE } from '@beauclick/commercial-policy-contract';

/**
 * The one public refusal for every cause on the seller's outcome-policy
 * surface — V3.3 Story #159 (`#42b`), ADR-051 §3, `V33-DEC-031` R4.
 *
 * A malformed, foreign or stale workspace reference, a caller who owns no
 * eligible party, an unknown key, a key with no active version, a member the
 * active version does not offer, a kind carrying the wrong field, a concurrent
 * retirement, a lost compare-and-swap and a uniqueness race are all this — same
 * status, same body — so neither the catalogue nor another seller's workspace
 * can be enumerated one honest message at a time. The reasoning, the 409 and
 * the absence of a cause parameter are exactly #104's
 * `CollectionPolicyAssignmentUnavailableException`, which this mirrors.
 */
export class OutcomePolicyAssignmentUnavailableException extends DomainException {
  constructor() {
    super(
      OUTCOME_POLICY_ASSIGNMENT_UNAVAILABLE,
      'انتخاب سیاست لغو و عدم حضور در حال حاضر برای این کسب‌وکار در دسترس نیست.',
      HttpStatus.CONFLICT,
    );
  }
}
