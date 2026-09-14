import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsObject, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

import { RequireCapability } from '@beauclick/auth';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import {
  AssignableOutcomePolicyListV1,
  BOOKING_OUTCOME_KEY_PATTERN,
  BookingOutcomeRetentionRule,
  MAX_OUTCOME_GRACE_MINUTES,
  MAX_OUTCOME_HOURS,
  OUTCOME_POLICY_ASSIGNMENT_REASON_MAX_LENGTH,
  OUTCOME_POLICY_ASSIGNMENT_REASON_MIN_LENGTH,
  OutcomePolicyAssignmentViewV1,
} from '@beauclick/commercial-policy-contract';

import { EmptyQueryDto } from '../seller-surface/seller-subscription-surface.dto';
import { OutcomeRetentionRuleDto } from '../outcome-policy/booking-outcome-policy.dto';
import { MANAGE_OWN_COLLECTION_POLICY } from '../collection-policy-assignment/collection-policy-assignment.controller';
import { OutcomePolicyAssignmentService } from './outcome-policy-assignment.service';

/**
 * The PUT body, and nothing else — V3.3 Story #159 (`#42b`).
 *
 * The key, the four selected members and a reason. No actor, owner, party,
 * business, professional, staff, version, administrator value, cap, evidence
 * reference, activation instant or timestamp field — **absent**, so the global
 * `forbidNonWhitelisted` answers any of them with a 400.
 *
 * The DTO checks TYPE; the contract validator checks SHAPE (a kind carrying the
 * wrong field); the active version decides MEMBERSHIP; the database refuses a
 * third time.
 */
export class AssignOutcomePolicyDto {
  @IsString()
  @Matches(BOOKING_OUTCOME_KEY_PATTERN)
  policyKey!: string;

  @IsInt()
  @Min(0)
  @Max(MAX_OUTCOME_HOURS)
  cutoffHours!: number;

  @IsObject()
  @ValidateNested()
  @Type(() => OutcomeRetentionRuleDto)
  lateCancellationRetention!: OutcomeRetentionRuleDto;

  @IsInt()
  @Min(0)
  @Max(MAX_OUTCOME_GRACE_MINUTES)
  noShowGraceMinutes!: number;

  @IsObject()
  @ValidateNested()
  @Type(() => OutcomeRetentionRuleDto)
  noShowRetention!: OutcomeRetentionRuleDto;

  @IsString()
  @MinLength(OUTCOME_POLICY_ASSIGNMENT_REASON_MIN_LENGTH)
  @MaxLength(OUTCOME_POLICY_ASSIGNMENT_REASON_MAX_LENGTH)
  reason!: string;
}

/**
 * A plain rule carrying exactly the fields the request carried.
 *
 * Built field by field rather than passing the DTO instance on: a class
 * instance may carry declared-but-absent properties as own keys, and the
 * contract validator must see precisely what the caller sent so that a `none`
 * rule with a stray `basisPoints` is refused rather than silently tidied.
 */
function ruleOf(dto: OutcomeRetentionRuleDto): BookingOutcomeRetentionRule {
  const rule: Record<string, unknown> = { kind: dto.kind };
  if (dto.basisPoints !== undefined) rule.basisPoints = dto.basisPoints;
  if (dto.amountToman !== undefined) rule.amountToman = dto.amountToman;
  return rule as unknown as BookingOutcomeRetentionRule;
}

/**
 * The seller-readable list of selectable outcome policies — Story #159.
 *
 * Authenticated and deliberately NOT capability-gated, for the reason #104's
 * `SellerCollectionPoliciesController` records: a seller who has not chosen yet
 * is exactly who this list is for. Each item is a key, a display name and the
 * allowed members; nothing administrative.
 */
@Controller('v1/me/outcome-policies')
export class SellerOutcomePoliciesController {
  constructor(private readonly assignments: OutcomePolicyAssignmentService) {}

  @Get()
  async list(
    @CurrentUser() _user: AuthenticatedUser,
    @Query() _query: EmptyQueryDto,
  ): Promise<AssignableOutcomePolicyListV1> {
    return { items: await this.assignments.assignablePolicies() };
  }
}

/**
 * A seller's own outcome-policy selection — Story #159 (`#42b`).
 *
 * `PUT` requires the existing non-privileged `bc_manage_own_collection_policy`
 * (granted to `professional` and `business` only — ADR-051 §3 reuses it rather
 * than minting a second capability for the same owner, the same workspace and
 * the same kind of governed choice). Neither route trusts the capability for
 * the workspace: live ownership through the opaque reference decides that, and
 * `:workspaceRef` carries no format pipe so a malformed reference fails exactly
 * like a foreign one.
 */
@Controller('v1/me/outcome-policy-assignments')
export class OutcomePolicyAssignmentController {
  constructor(private readonly assignments: OutcomePolicyAssignmentService) {}

  /** The current selection, or `assignment: null`. Read-only and never audited. */
  @Get(':workspaceRef')
  async current(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceRef') workspaceRef: string,
    @Query() _query: EmptyQueryDto,
  ): Promise<OutcomePolicyAssignmentViewV1> {
    return this.assignments.currentAssignment(user.userId, workspaceRef);
  }

  /** Selects inside the active version, superseding the current selection. Idempotent on the same key and members. */
  @Put(':workspaceRef')
  @RequireCapability(MANAGE_OWN_COLLECTION_POLICY)
  async assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceRef') workspaceRef: string,
    @Query() _query: EmptyQueryDto,
    @Body() dto: AssignOutcomePolicyDto,
  ): Promise<OutcomePolicyAssignmentViewV1> {
    return this.assignments.assign(user.userId, {
      workspaceRef,
      policyKey: dto.policyKey,
      selection: {
        cutoffHours: dto.cutoffHours,
        lateCancellationRetention: ruleOf(dto.lateCancellationRetention),
        noShowGraceMinutes: dto.noShowGraceMinutes,
        noShowRetention: ruleOf(dto.noShowRetention),
      },
      reason: dto.reason,
    });
  }
}
