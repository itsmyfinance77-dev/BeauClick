import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { RequireCapability } from '@beauclick/auth';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import {
  AssignableCollectionPolicyListV1,
  COLLECTION_POLICY_ASSIGNMENT_REASON_MAX_LENGTH,
  COLLECTION_POLICY_ASSIGNMENT_REASON_MIN_LENGTH,
  COLLECTION_POLICY_KEY_PATTERN,
  CollectionPolicyAssignmentViewV1,
} from '@beauclick/commercial-policy-contract';

import { EmptyQueryDto } from '../seller-surface/seller-subscription-surface.dto';
import { CollectionPolicyAssignmentService } from './collection-policy-assignment.service';

/** The capability this surface adds. Non-privileged: it never substitutes for live ownership. */
export const MANAGE_OWN_COLLECTION_POLICY = 'bc_manage_own_collection_policy';

/**
 * The PUT body, and nothing else — V3.3 Story #104 (`#41d-2a`).
 *
 * There is no actor, owner, seller, party, business, professional, staff,
 * service, assignment id, policy version, mode, amount, percentage, base,
 * activation instant or timestamp field anywhere below. Not
 * validated-and-rejected: **absent**. The global `ValidationPipe` runs with
 * `whitelist` and `forbidNonWhitelisted`, so a property no shape declares is a
 * 400 rather than a silently dropped field — which matters here because the
 * request becomes a governed commercial commitment, and a typo'd `policyKey`
 * that was quietly discarded would supersede an assignment with whatever the
 * declared field happened to hold.
 */
export class AssignCollectionPolicyDto {
  @IsString()
  @Matches(COLLECTION_POLICY_KEY_PATTERN)
  policyKey!: string;

  @IsString()
  @MinLength(COLLECTION_POLICY_ASSIGNMENT_REASON_MIN_LENGTH)
  @MaxLength(COLLECTION_POLICY_ASSIGNMENT_REASON_MAX_LENGTH)
  reason!: string;
}

/**
 * The seller-readable catalogue of assignable collection policies — Story #104.
 *
 * ## Authenticated, and deliberately NOT capability-gated
 *
 * The same call `SellerCommercialPlansController` makes for plans, for the same
 * reason its docblock records: requiring `bc_manage_own_collection_policy` to
 * *browse* would hide the catalogue from a seller who has not yet chosen, which
 * is exactly the seller this list exists for.
 *
 * ## What a response cannot contain
 *
 * `policyKey` and `displayName`. No version number, terms, collection mode,
 * deposit amount, percentage, calculation base, activation window, lifecycle
 * value, actor id, audit field or retirement internal — an absent, draft or
 * retired version is simply not listed, so its absence discloses nothing. The
 * line `CommercialCatalogueController` draws for the administrator plane, drawn
 * again here.
 */
@Controller('v1/me/collection-policies')
export class SellerCollectionPoliciesController {
  constructor(private readonly assignments: CollectionPolicyAssignmentService) {}

  @Get()
  async list(
    @CurrentUser() _user: AuthenticatedUser,
    @Query() _query: EmptyQueryDto,
  ): Promise<AssignableCollectionPolicyListV1> {
    return { items: await this.assignments.assignablePolicies() };
  }
}

/**
 * A seller's own collection-policy assignment — Story #104 (`#41d-2a`).
 *
 * ## The capability gates the mutation; ownership decides the workspace
 *
 * `PUT` requires `bc_manage_own_collection_policy`. Neither route trusts it for
 * anything more: both resolve the caller's live-owned parties inside the
 * request's transaction and match the opaque `workspaceRef` against
 * server-recomputed candidates in constant time. A caller holding the
 * capability who owns no matching party reaches nothing, and `business_staff`
 * is never followed.
 *
 * ## `:workspaceRef` carries no format pipe, and that is deliberate
 *
 * Validating its shape at the parameter would answer a malformed reference
 * differently from a foreign one, which is precisely the enumeration oracle the
 * single refusal exists to prevent. Both are resolved and both fail the same
 * way, with the same status and the same body.
 */
@Controller('v1/me/collection-policy-assignments')
export class CollectionPolicyAssignmentController {
  constructor(private readonly assignments: CollectionPolicyAssignmentService) {}

  /**
   * The current assignment, or `assignment: null` for an unenrolled workspace.
   *
   * Read-only and never audited. Absence is a legitimate state (ADR-048 R2),
   * so it is a 200 rather than a refusal, and nothing here creates a row.
   */
  @Get(':workspaceRef')
  async current(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceRef') workspaceRef: string,
    @Query() _query: EmptyQueryDto,
  ): Promise<CollectionPolicyAssignmentViewV1> {
    return this.assignments.currentAssignment(user.userId, workspaceRef);
  }

  /**
   * Chooses a policy, superseding whatever was current.
   *
   * Idempotent by construction: submitting the key that is already current
   * returns it successfully, writing neither an assignment nor an audit row.
   */
  @Put(':workspaceRef')
  @RequireCapability(MANAGE_OWN_COLLECTION_POLICY)
  async assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceRef') workspaceRef: string,
    @Query() _query: EmptyQueryDto,
    @Body() dto: AssignCollectionPolicyDto,
  ): Promise<CollectionPolicyAssignmentViewV1> {
    return this.assignments.assign(user.userId, {
      workspaceRef,
      policyKey: dto.policyKey,
      reason: dto.reason,
    });
  }
}
