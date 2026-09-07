import { ArrayMaxSize, ArrayUnique, IsArray, IsIn } from 'class-validator';

import { BUSINESS_TRAITS, BusinessTrait } from '../entities/business-trait.entity';
import { BUSINESS_VERTICALS, BusinessVertical } from '../entities/business-vertical.entity';

/**
 * The one classification command: replace this business's whole classification.
 *
 * ## Why a full replacement and not a patch
 *
 * `V33-DEC-032` R1 gives a business ONE current vertical and R6 gives it ONE
 * current trait set. A partial edit would need a rule for what an omitted field
 * means -- keep it, or clear it -- and neither is ratified. A full replacement
 * has no such ambiguity: what arrives is what the business is afterwards.
 *
 * ## What this DTO structurally cannot carry
 *
 * The global `ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted`,
 * so any property not declared here is REJECTED rather than ignored. That is
 * what stops `isPrimary`, a second vertical, an owner/user/actor/party id, a
 * business id in the body, a `workspaceRef`, or any medical or clinical field
 * from being accepted quietly. The route resolves the business from the path and
 * the actor from the session; neither is ever a body field.
 *
 * There is deliberately no unclassify/DELETE counterpart. `V33-DEC-032` ratified
 * that absence means "not yet answered"; a route that could re-create that
 * absence would make "never classified" and "deliberately un-classified"
 * indistinguishable, and no ruling defines the second.
 */
export class ReplaceBusinessClassificationDto {
  /** Required. Exactly one member of the closed vertical vocabulary. */
  @IsIn(BUSINESS_VERTICALS)
  vertical!: BusinessVertical;

  /**
   * Required, and an empty array is valid -- a business with no operating trait
   * is an ordinary business, not an incomplete one.
   *
   * `ArrayUnique` refuses a duplicate rather than silently de-duplicating it: a
   * caller who sent `['mobile','mobile']` did not describe a set they
   * understood, and accepting it would hide the mistake.
   */
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(BUSINESS_TRAITS.length)
  @IsIn(BUSINESS_TRAITS, { each: true })
  traits!: BusinessTrait[];
}
