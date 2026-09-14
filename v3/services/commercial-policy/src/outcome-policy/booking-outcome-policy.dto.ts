import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
  BOOKING_OUTCOME_RETENTION_KINDS,
  BookingOutcomeRetentionKind,
  CATALOGUE_KEY_PATTERN,
  CUSTOMER_POLICY_COPY_LOCALES,
  CustomerPolicyCopyLocale,
  LEGAL_EVIDENCE_REFERENCE_KINDS,
  LEGAL_EVIDENCE_SUBJECTS,
  LegalEvidenceReferenceKind,
  LegalEvidenceSubject,
  MAX_LEGAL_EVIDENCE_REFERENCE_LENGTH,
  MAX_LEGAL_EVIDENCE_SUMMARY_LENGTH,
  MAX_OUTCOME_AMOUNT_TOMAN,
  MAX_OUTCOME_GRACE_MINUTES,
  MAX_OUTCOME_HOURS,
  MAX_OUTCOME_RESCHEDULE_FREE_COUNT,
  MAX_OUTCOME_RETENTION_DAYS,
  MAX_OUTCOME_RETENTION_OPTIONS,
  MAX_OUTCOME_SET_MEMBERS,
} from '@beauclick/commercial-policy-contract';

import { ReasonDto } from '../catalogue/commercial-catalogue.dto';

/**
 * The administrator request vocabulary of `#42a` — ADR-051 §1 and §5.
 *
 * ## No `activationStartsAt`, no actor, no lifecycle, no evidence id
 *
 * As on the collection-policy surface: the activation instant is the
 * database's; the actor is the session's; the lifecycle is a transition, not
 * a field; and Legal evidence is named by its administrator-facing KEY, never
 * by a row id. A caller who sends any of those gets a 400 from the global
 * whitelist (`forbidNonWhitelisted`), asserted on this surface by the suite.
 *
 * ## Sets, not values
 *
 * `cutoffHoursAllowed` and `noShowGraceMinutesAllowed` are arrays a seller
 * later chooses inside. A one-member array is legal; a scalar is not a field.
 *
 * ## Three layers
 *
 * The DTO catches a wrong TYPE; the contract validator catches a wrong SHAPE
 * (a percentage with no basis points, a duplicate option, a bodily-harm window
 * shorter than the normal one); the database CHECKs refuse a third time.
 */

const DISPLAY_NAME_MAX = 120;

export class OutcomeRetentionRuleDto {
  @IsIn([...BOOKING_OUTCOME_RETENTION_KINDS])
  kind!: BookingOutcomeRetentionKind;

  /** `percentage_of_collected` only. 1..9999: zero is `none`, ten thousand is `full_collected`. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(9_999)
  basisPoints?: number;

  /** `fixed_toman` only. Positive integer toman. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_OUTCOME_AMOUNT_TOMAN)
  amountToman?: number;
}

export class CreateBookingOutcomePolicyDto extends ReasonDto {
  @IsString()
  @Matches(CATALOGUE_KEY_PATTERN)
  policyKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(DISPLAY_NAME_MAX)
  displayName!: string;
}

export class WriteBookingOutcomePolicyVersionDto extends ReasonDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_OUTCOME_SET_MEMBERS)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(MAX_OUTCOME_HOURS, { each: true })
  cutoffHoursAllowed!: number[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_OUTCOME_RETENTION_OPTIONS)
  @ValidateNested({ each: true })
  @Type(() => OutcomeRetentionRuleDto)
  lateRetentionOptions!: OutcomeRetentionRuleDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_OUTCOME_SET_MEMBERS)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(MAX_OUTCOME_GRACE_MINUTES, { each: true })
  noShowGraceMinutesAllowed!: number[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_OUTCOME_RETENTION_OPTIONS)
  @ValidateNested({ each: true })
  @Type(() => OutcomeRetentionRuleDto)
  noShowRetentionOptions!: OutcomeRetentionRuleDto[];

  @IsInt()
  @Min(0)
  @Max(MAX_OUTCOME_RESCHEDULE_FREE_COUNT)
  rescheduleFreeCountBeforeCutoff!: number;

  @IsInt()
  @Min(1)
  @Max(MAX_OUTCOME_HOURS)
  disputeWindowHours!: number;

  /** Explicitly nullable: "no exceptional window" is a decision, not an omission. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_OUTCOME_HOURS)
  bodilyHarmWindowHours?: number | null;

  @IsInt()
  @Min(1)
  @Max(MAX_OUTCOME_HOURS)
  appealWindowHours!: number;

  /** Explicitly nullable: NULL is "unconfigured", which ADR-051 §10 relies on. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_OUTCOME_RETENTION_DAYS)
  caseFileRetentionDays?: number | null;

  /** Present only together with `legalEvidenceKey`; the service and the database refuse otherwise. */
  @IsOptional()
  @ValidateNested()
  @Type(() => OutcomeRetentionRuleDto)
  legalCap?: OutcomeRetentionRuleDto | null;

  /** The administrator-facing KEY of a recorded `retention_cap` evidence record. Never an id. */
  @IsOptional()
  @IsString()
  @Matches(CATALOGUE_KEY_PATTERN)
  legalEvidenceKey?: string | null;

  @IsOptional()
  @IsISO8601()
  activationEndsAt?: string | null;
}

export class CreateCustomerPolicyCopyDto extends ReasonDto {
  @IsString()
  @Matches(CATALOGUE_KEY_PATTERN)
  copyKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(DISPLAY_NAME_MAX)
  displayName!: string;
}

export class WriteCustomerPolicyCopyVersionDto extends ReasonDto {
  @IsIn([...CUSTOMER_POLICY_COPY_LOCALES])
  locale!: CustomerPolicyCopyLocale;

  /** The Persian text. Byte-bounded by the contract validator, not here. */
  @IsString()
  @MinLength(1)
  body!: string;

  @IsOptional()
  @IsISO8601()
  activationEndsAt?: string | null;
}

export class RecordLegalEvidenceDto extends ReasonDto {
  @IsString()
  @Matches(CATALOGUE_KEY_PATTERN)
  evidenceKey!: string;

  @IsIn([...LEGAL_EVIDENCE_SUBJECTS])
  subject!: LegalEvidenceSubject;

  @IsIn([...LEGAL_EVIDENCE_REFERENCE_KINDS])
  referenceKind!: LegalEvidenceReferenceKind;

  /** Where the evidence is. Never the evidence. */
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_LEGAL_EVIDENCE_REFERENCE_LENGTH)
  reference!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_LEGAL_EVIDENCE_SUMMARY_LENGTH)
  summary!: string;
}
