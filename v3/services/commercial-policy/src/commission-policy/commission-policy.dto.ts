import { IsIn, IsISO8601, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

import {
  CATALOGUE_KEY_PATTERN,
  COMMISSION_BASES,
  COMMISSION_COMPONENTS,
  COMMISSION_RULE_KINDS,
  CommissionBase,
  CommissionComponent,
  CommissionRuleKind,
  MAX_COMMISSION_AMOUNT_TOMAN,
  MAX_COMMISSION_BASIS_POINTS,
} from '@beauclick/commercial-policy-contract';

import { ReasonDto } from '../catalogue/commercial-catalogue.dto';

/**
 * The administrator request vocabulary of `#43b-1` — ADR-052 §1.
 *
 * ## No `activationStartsAt`, no actor, no lifecycle, no arithmetic version
 *
 * As on every other publication surface: the activation instant is the
 * database's (and here it must equal the transaction clock exactly), the actor
 * is the session's, and the lifecycle is a transition rather than a field.
 * `arithmeticVersion` is the engine's own exported constant and is likewise not
 * accepted from a caller — a client that could choose it could pin an order to
 * arithmetic the platform has since corrected. A request carrying any of these
 * is refused with 400 by the global whitelist (`forbidNonWhitelisted`).
 *
 * ## Nullable by omission, never by a magic value
 *
 * `basisPoints`, `fixedToman` and `base` are optional here because three of
 * the four shapes leave some of them out. "Left out" is the only way to say
 * absent: there is no sentinel, and the service's shape check (and the
 * database's CHECK matrix behind it) refuses any combination the four shapes
 * do not name.
 */
export class CreateCommissionPolicyDto extends ReasonDto {
  @IsString()
  @Matches(CATALOGUE_KEY_PATTERN)
  policyKey!: string;

  @IsIn(COMMISSION_COMPONENTS as unknown as string[])
  component!: CommissionComponent;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName!: string;
}

export class WriteCommissionVersionDto extends ReasonDto {
  @IsIn(COMMISSION_RULE_KINDS as unknown as string[])
  ruleKind!: CommissionRuleKind;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_COMMISSION_BASIS_POINTS)
  basisPoints?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_COMMISSION_AMOUNT_TOMAN)
  fixedToman?: number;

  @IsOptional()
  @IsIn(COMMISSION_BASES as unknown as string[])
  base?: CommissionBase;

  /** The optional FORWARD bound. Absent means open-ended, which is the ordinary case. */
  @IsOptional()
  @IsISO8601()
  activationEndsAt?: string;
}
