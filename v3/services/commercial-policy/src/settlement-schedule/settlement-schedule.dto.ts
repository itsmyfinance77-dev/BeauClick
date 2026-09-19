import { IsIn, IsISO8601, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

import {
  CATALOGUE_KEY_PATTERN,
  MAX_RESERVE_BASIS_POINTS,
  MAX_SETTLEMENT_AMOUNT_TOMAN,
  MAX_SETTLEMENT_INTERVAL_DAYS,
  SELLER_RISK_CLASSES,
  SellerRiskClass,
} from '@beauclick/commercial-policy-contract';

import { ReasonDto } from '../catalogue/commercial-catalogue.dto';

/**
 * The administrator request vocabulary of `#43d` — ADR-052 §1 and §8.
 *
 * ## No activation instant, no actor, no lifecycle
 *
 * As on every other publication surface: the activation instant is the
 * database's (and here it must equal the transaction clock exactly), the
 * actor is the session's, and the lifecycle is a transition rather than a
 * field. A request carrying any of them is refused with 400 by the global
 * whitelist.
 *
 * ## Nullable by omission, never by a sentinel
 *
 * `minimumPayoutToman`, `reserveBasisPoints` and `reserveCapToman` are
 * optional because "no minimum" and "no reserve" are real states. Omission is
 * the only way to say absent; zero means zero, which is a different decision
 * and the service keeps them apart.
 */
export class CreateSettlementSchedulePolicyDto extends ReasonDto {
  @IsString()
  @Matches(CATALOGUE_KEY_PATTERN)
  policyKey!: string;

  @IsString()
  @Matches(CATALOGUE_KEY_PATTERN)
  planKey!: string;

  @IsIn(SELLER_RISK_CLASSES as unknown as string[])
  riskClass!: SellerRiskClass;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName!: string;
}

export class WriteSettlementScheduleVersionDto extends ReasonDto {
  /** NOT optional and with no default: there is no implicit cadence. */
  @IsInt()
  @Min(1)
  @Max(MAX_SETTLEMENT_INTERVAL_DAYS)
  settlementIntervalDays!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_SETTLEMENT_AMOUNT_TOMAN)
  minimumPayoutToman?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_RESERVE_BASIS_POINTS)
  reserveBasisPoints?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_SETTLEMENT_AMOUNT_TOMAN)
  reserveCapToman?: number;

  @IsOptional()
  @IsISO8601()
  activationEndsAt?: string;
}

/**
 * A deliberate classification. The reason is mandatory and inherited from
 * `ReasonDto`: a class that changes when a seller's money moves is not
 * something anybody records without saying why.
 */
export class AssignSellerRiskClassDto extends ReasonDto {
  @IsIn(['professional', 'business'])
  partyType!: 'professional' | 'business';

  @IsUUID()
  partyId!: string;

  @IsIn(SELLER_RISK_CLASSES as unknown as string[])
  riskClass!: SellerRiskClass;
}
