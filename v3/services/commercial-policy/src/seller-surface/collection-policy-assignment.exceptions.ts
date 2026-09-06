import { HttpStatus } from '@nestjs/common';

import { DomainException } from '@beauclick/http';
import { COLLECTION_POLICY_ASSIGNMENT_UNAVAILABLE } from '@beauclick/commercial-policy-contract';

/**
 * The one public refusal for every cause on this surface — V3.3 Story #104
 * (`#41d-2a`), `V33-DEC-031` R4, ADR-048 §7.
 *
 * ## One code, eight conditions
 *
 * A malformed workspace reference, a foreign or stale one, a caller who owns no
 * matching eligible party, an unavailable or nonexistent policy key, a key with
 * no active published version, a concurrent retirement, a lost supersession
 * compare-and-swap, and an assignment-uniqueness race that cannot be treated as
 * the successful idempotent replay are **all this**, with the same status and
 * the same body.
 *
 * A caller cannot tell them apart, so neither the administrator's catalogue nor
 * another seller's workspace can be enumerated one honest error message at a
 * time — the reasoning `CreditPurchaseUnavailableException` records, and the
 * reason `WorkspaceReferenceService.resolve`'s own subscription refusal is
 * caught and re-thrown as this rather than allowed to surface: two different
 * bodies would be the enumeration oracle both are built to prevent.
 *
 * ## 409, not 404
 *
 * A 404 would say "this workspace does not exist", which is untrue for the
 * commonest case — the workspace exists and is the caller's, and what is
 * unavailable is the assignment they asked for, which is a conflict with the
 * current state of the catalogue or of a concurrent request.
 *
 * ## The internal cause never reaches here
 *
 * `CollectionPolicyAssignmentRefusalCause` exists for metrics and audit and is
 * deliberately not a constructor parameter of the response: a value that cannot
 * be attached cannot be leaked by a future author who forgets why it was
 * separate.
 */
export class CollectionPolicyAssignmentUnavailableException extends DomainException {
  constructor() {
    super(
      COLLECTION_POLICY_ASSIGNMENT_UNAVAILABLE,
      'انتخاب سیاست دریافت وجه در حال حاضر برای این کسب‌وکار در دسترس نیست.',
      HttpStatus.CONFLICT,
    );
  }
}
