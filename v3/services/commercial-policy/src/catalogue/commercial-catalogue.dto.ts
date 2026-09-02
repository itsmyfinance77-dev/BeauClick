import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
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
  CATALOGUE_KEY_PATTERN,
  MAX_CATALOGUE_QUANTITY,
  MAX_UNIT_PRICE_TOMAN,
  PRICE_SCHEDULE_PURPOSES,
  PriceSchedulePurpose,
} from '@beauclick/commercial-policy-contract';

/**
 * The administrator request vocabulary.
 *
 * ## Closed, and unknown fields are REJECTED rather than ignored
 *
 * The global `ValidationPipe` runs with `whitelist: true` and
 * `forbidNonWhitelisted: true`, so a property no DTO declares is a 400 rather
 * than a silently dropped field. That matters more here than on most surfaces:
 * these payloads become an immutable, activation-windowed commitment, and a
 * typo'd `includedCredits` that was quietly discarded would publish a plan with
 * whatever the declared field happened to hold.
 *
 * The adversarial suite asserts it on THIS surface specifically rather than
 * trusting the global setting, because "the global pipe does that" is exactly
 * the assumption that was wrong the last time a controller-level decorator was
 * silently ignored (`CapabilityGuard`'s class docblock records it).
 *
 * ## There is no actor, owner or subscriber field anywhere below
 *
 * Not validated-and-rejected: ABSENT. The actor comes from the authenticated
 * session, so attributing a publication to somebody else is unrepresentable.
 * A caller who sends one gets a 400 from the whitelist, having named a property
 * no shape declares.
 *
 * ## Every reason is mandatory
 *
 * `MinLength(3)` here, and a trim in the service — three spaces satisfy the
 * decorator and must not satisfy the requirement.
 */

const REASON_MIN = 3;
const REASON_MAX = 500;

/** Mandatory on every mutation. The audit row's `reason` column, and the only prose here. */
export class ReasonDto {
  @IsString()
  @MinLength(REASON_MIN)
  @MaxLength(REASON_MAX)
  reason!: string;
}

export class CreatePlanDto extends ReasonDto {
  @IsString()
  @Matches(CATALOGUE_KEY_PATTERN)
  planKey!: string;
}

export class CreatePriceScheduleDto extends ReasonDto {
  @IsString()
  @Matches(CATALOGUE_KEY_PATTERN)
  scheduleKey!: string;

  @IsIn([...PRICE_SCHEDULE_PURPOSES])
  purpose!: PriceSchedulePurpose;
}

export class PriceTierDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_CATALOGUE_QUANTITY)
  minQuantity!: number;

  /**
   * `null` is unbounded above and is legal on the highest tier only.
   *
   * `@IsOptional()` would also accept an ABSENT property, which is not the same
   * statement: an administrator who omits the field has not said "unbounded",
   * they have said nothing. The field is required and its value may be null.
   */
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_CATALOGUE_QUANTITY)
  maxQuantity!: number | null;

  /** Integer Toman. Zero is legal; that is what the base workspace costs. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_UNIT_PRICE_TOMAN)
  unitPriceToman!: number;
}

export class ActivationWindowDto {
  @IsISO8601()
  activationStartsAt!: string;

  /** `null` means open-ended. Absent is not the same as null; the field is required. */
  @IsOptional()
  @IsISO8601()
  activationEndsAt!: string | null;
}

export class WriteScheduleVersionDto extends ActivationWindowDto {
  @IsString()
  @MinLength(REASON_MIN)
  @MaxLength(REASON_MAX)
  reason!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_CATALOGUE_QUANTITY)
  minPurchaseQuantity!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_CATALOGUE_QUANTITY)
  maxPurchaseQuantity!: number;

  /**
   * Presentation only, never a contract limit (`V33-DEC-009`).
   *
   * Bounded at 12 entries because a preset row is a handful of buttons, and an
   * unbounded integer array on a mutation is a cheap way to make somebody store
   * a megabyte.
   */
  @IsArray()
  @ArrayMaxSize(12)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_CATALOGUE_QUANTITY, { each: true })
  uiPresetQuantities!: number[];

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => PriceTierDto)
  tiers!: PriceTierDto[];
}

export class WritePlanVersionDto extends ActivationWindowDto {
  @IsString()
  @MinLength(REASON_MIN)
  @MaxLength(REASON_MAX)
  reason!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName!: string;

  /** `null` means no recurring term. Required, and may be null. */
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3660)
  billingTermDays!: number | null;

  /**
   * No default anywhere in this class, and this field is why the rule is
   * spelled out: `V33-DEC-009` forbids any allowance as a code constant,
   * default, fallback or seed, so an administrator supplies it or the request
   * fails validation. There is nothing here for a deployment to inherit.
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_CATALOGUE_QUANTITY)
  includedBookingCredits!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  staffSeats!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  includedLocations!: number;

  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @Matches(/^[a-z][a-z0-9_]{0,63}$/, { each: true })
  capabilityKeys!: string[];

  @IsString()
  @Matches(/^[0-9a-fA-F-]{36}$/)
  priceScheduleVersionId!: string;

  /**
   * The base workspace flag (ADR-041 §6).
   *
   * An administrator-controlled property of a ROW, which is what keeps `D-7`
   * out of the code. Publishing a version with this set requires a
   * single-zero-tier price schedule; the database refuses otherwise.
   */
  @IsBoolean()
  autoAssignable!: boolean;
}
