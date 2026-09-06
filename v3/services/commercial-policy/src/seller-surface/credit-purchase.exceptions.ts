import { HttpStatus } from '@nestjs/common';

import { DomainException } from '@beauclick/http';
import { PURCHASE_UNAVAILABLE } from '@beauclick/commercial-policy-contract';

/**
 * The one public refusal for every pricing cause — V3.3 #57 (`#40c-1`),
 * `V33-DEC-026` R8 and `V33-DEC-027` R6.
 *
 * ## One code, seven conditions
 *
 * A null binding, a missing schedule, a wrong-purpose schedule, no published
 * and active version, incomplete tiers, an out-of-bounds quantity and a
 * concurrent catalogue change are all THIS, with the same body. A caller cannot
 * tell them apart, so the administrator's catalogue cannot be enumerated one
 * refusal at a time — the same reasoning `SUBSCRIPTION_SELLER_NOT_ELIGIBLE`
 * records for ownership.
 *
 * ## Why the code is lower-case, alone in this repository
 *
 * Because `V33-DEC-026` Ruling 8 spelled it `purchase_unavailable`, and on a
 * ratified contract the register is the authority. Written here from the
 * contract constant rather than as a literal, so the two cannot drift, and
 * recorded in ADR-047 §8 so it reads as a decision rather than an oversight.
 *
 * ## 409, not 404
 *
 * A 404 would say "this workspace does not exist", which is untrue and
 * collides with the ownership refusal's meaning. The workspace exists and is
 * the caller's; what is unavailable is a purchase against it, which is a
 * conflict with the current state of the catalogue.
 */
export class CreditPurchaseUnavailableException extends DomainException {
  constructor() {
    super(
      PURCHASE_UNAVAILABLE,
      'خرید اعتبار نوبت‌دهی در حال حاضر برای این کسب‌وکار در دسترس نیست.',
      HttpStatus.CONFLICT,
    );
  }
}
