import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  BOOKING_COLLECTION_DEPOSIT_KINDS,
  BOOKING_COLLECTION_MODES,
  BOOKING_COLLECTION_PERCENTAGE_BASES,
  BookingCollectionDepositKind,
  BookingCollectionMode,
  BookingCollectionPercentageBase,
  CATALOGUE_KEY_PATTERN,
  MAX_COLLECTION_AMOUNT_TOMAN,
} from '@beauclick/commercial-policy-contract';

import { ReasonDto } from './commercial-catalogue.dto';

/**
 * The administrator request vocabulary for booking collection policy —
 * V3.3 Story #83 (`#41d-1`), ADR-048 §5.
 *
 * ## There is no `activationStartsAt`, and its absence is the control
 *
 * `V33-DEC-029` Ruling 7 requires a database-authoritative activation instant.
 * The strongest way to state that in a request shape is to have no field for
 * it: a caller who sends one gets a 400 from the global whitelist for naming a
 * property no shape declares, rather than a value the service must remember to
 * discard. `activationEndsAt` is the only window value a caller may supply, and
 * it may only point forward.
 *
 * ## Unknown fields are REJECTED rather than ignored
 *
 * The global `ValidationPipe` runs with `whitelist: true` and
 * `forbidNonWhitelisted: true`. That matters more here than on most surfaces:
 * these payloads become an immutable, activation-windowed commitment, and a
 * typo'd `depositBasisPoints` that was quietly discarded would publish a policy
 * with whatever the declared field happened to hold. The adversarial suite
 * asserts it on THIS surface specifically rather than trusting the global
 * setting.
 *
 * ## The deposit shape is validated as a shape, not as a bag of optionals
 *
 * `class-validator` has no native discriminated union, so `@ValidateNested`
 * carries the flat, per-kind fields and `BookingCollectionPolicyService`
 * re-validates the assembled union with
 * `validateBookingCollectionTermsV1`. Both run: the DTO catches a wrong TYPE
 * before a value reaches the domain, and the contract catches a wrong SHAPE —
 * a percentage rule with no base, a fixed amount on a pay-at-venue policy — that
 * no per-field decorator can see. The database CHECKs are the third and
 * authoritative layer.
 *
 * ## There is no actor, owner, seller, party, service, assignment, price,
 * computed amount, acceptance, published timestamp or lifecycle field
 *
 * Not validated-and-rejected: ABSENT. The actor comes from the authenticated
 * session; the lifecycle is a transition, not an input; assignment is #104; and
 * acceptance is #42's, after Legal.
 */

const DISPLAY_NAME_MAX = 120;

/** The flat deposit rule. The service assembles and re-validates it as a union. */
export class CollectionDepositRuleDto {
  @IsIn([...BOOKING_COLLECTION_DEPOSIT_KINDS])
  kind!: BookingCollectionDepositKind;

  /** `fixed` only. Positive integer Toman, bounded representationally. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_COLLECTION_AMOUNT_TOMAN)
  amountToman?: number;

  /** `percentage` only. 1..10000 basis points; 0 collects nothing and 10001 more than the price. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  basisPoints?: number;

  /** `percentage` only, and required there. No default: `V33-DEC-029` Ruling 4. */
  @IsOptional()
  @IsIn([...BOOKING_COLLECTION_PERCENTAGE_BASES])
  percentageBase?: BookingCollectionPercentageBase;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_COLLECTION_AMOUNT_TOMAN)
  minimumToman?: number;

  /** Explicitly nullable: "no ceiling" is a decision, not an omission. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_COLLECTION_AMOUNT_TOMAN)
  maximumToman?: number | null;
}

export class CreateBookingCollectionPolicyDto extends ReasonDto {
  @IsString()
  @Matches(CATALOGUE_KEY_PATTERN)
  policyKey!: string;

  /** Administrative prose. Never customer-facing copy — that is `V33-DEC-017`, on #42. */
  @IsString()
  @MinLength(1)
  @MaxLength(DISPLAY_NAME_MAX)
  displayName!: string;
}

export class WriteBookingCollectionPolicyVersionDto extends ReasonDto {
  @IsIn([...BOOKING_COLLECTION_MODES])
  collectionMode!: BookingCollectionMode;

  @ValidateNested()
  @Type(() => CollectionDepositRuleDto)
  deposit!: CollectionDepositRuleDto;

  /**
   * The optional forward bound. Deliberately the ONLY window field.
   *
   * `IsISO8601` and not a `Date`: the pipe parses it, and an unparseable string
   * must be a 400 rather than an `Invalid Date` the service has to notice.
   */
  @IsOptional()
  @IsISO8601()
  activationEndsAt?: string | null;
}
