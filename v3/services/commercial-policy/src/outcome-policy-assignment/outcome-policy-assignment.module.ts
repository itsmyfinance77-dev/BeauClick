import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OUTCOME_POLICY_ASSIGNMENT_ENTITIES } from './outcome-policy-assignment.entities';
import { OutcomePolicyAssignmentService } from './outcome-policy-assignment.service';
import { OutcomePolicyAssignmentSubjectDataContract } from './outcome-policy-assignment-subject-data.contract';
import {
  OutcomePolicyAssignmentController,
  SellerOutcomePoliciesController,
} from './outcome-policy-assignment.controller';
import { WorkspaceReferenceService } from '../seller-surface/workspace-reference';

/**
 * The seller's booking-outcome selection surface — V3.3 Story #159 (`#42b`),
 * ADR-051 §3.
 *
 * Shaped exactly like #104's `CollectionPolicyAssignmentModule`, for its
 * recorded reasons: it does NOT import `BookingOutcomePolicyModule` (the
 * administrator's privileged publication surface) and registers no `#42a`
 * entity — it reads the published family through narrow SQL projections — and
 * ownership is the one `OWNED_SUBSCRIBER_PARTY_RESOLVER` bound in the
 * composition root. `AuditModule` is `@Global()`. No outbox, no event: the
 * order path reads a selection synchronously through a port.
 */
@Module({
  imports: [TypeOrmModule.forFeature(OUTCOME_POLICY_ASSIGNMENT_ENTITIES)],
  controllers: [SellerOutcomePoliciesController, OutcomePolicyAssignmentController],
  providers: [OutcomePolicyAssignmentService, OutcomePolicyAssignmentSubjectDataContract, WorkspaceReferenceService],
  exports: [OutcomePolicyAssignmentService, OutcomePolicyAssignmentSubjectDataContract],
})
export class OutcomePolicyAssignmentModule {}
