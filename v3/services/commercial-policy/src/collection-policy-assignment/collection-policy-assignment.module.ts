import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { COLLECTION_POLICY_ASSIGNMENT_ENTITIES } from './collection-policy-assignment.entities';
import { CollectionPolicyAssignmentService } from './collection-policy-assignment.service';
import { CollectionPolicyAssignmentSubjectDataContract } from './collection-policy-assignment-subject-data.contract';
import {
  CollectionPolicyAssignmentController,
  SellerCollectionPoliciesController,
} from './collection-policy-assignment.controller';
import { WorkspaceReferenceService } from '../seller-surface/workspace-reference';

/**
 * The seller collection-policy assignment surface — V3.3 Story #104
 * (`#41d-2a`), ADR-048 R2.
 *
 * ## A separate module, and what it deliberately does not import
 *
 * It does **not** import `CommercialCatalogueModule`, whose
 * `BookingCollectionPolicyService` is the administrator's privileged mutation
 * surface. The catalogue is read here through two narrow SQL projections
 * instead — the same line `SellerSubscriptionSurfaceModule` draws for plans,
 * and for the same reason: a seller route one autocomplete away from
 * `publishVersion` is a boundary violation waiting to happen.
 *
 * It registers `COLLECTION_POLICY_ASSIGNMENT_ENTITIES` **only**, never
 * `COMMERCIAL_ENTITIES` or `BOOKING_COLLECTION_POLICY_ENTITIES`. Those arrays
 * belong to modules that have no business writing an assignment, and Story #83
 * ships a structural test asserting that separation.
 *
 * ## No AuditModule import, and that is correct
 *
 * `AuditModule` is `@Global()`, so `AdminAuditService` resolves without an
 * import and the boot-time assertion still applies.
 *
 * ## `OWNED_SUBSCRIBER_PARTY_RESOLVER` comes from the composition root
 *
 * The ownership port is bound once, in `apps/api`, and reused here rather than
 * re-implemented: `V33-DEC-031` R1 forbids a second ownership predicate, a
 * second secret and a second reference format, and one resolver is what makes
 * "a staff professional owns nothing" true in both surfaces at once.
 *
 * ## No outbox, no event, no scheduler
 *
 * Nothing consumes an assignment yet — #115 will read it synchronously through
 * a port — so there is no event to relay (ADR-039 §8).
 */
@Module({
  imports: [TypeOrmModule.forFeature(COLLECTION_POLICY_ASSIGNMENT_ENTITIES)],
  controllers: [SellerCollectionPoliciesController, CollectionPolicyAssignmentController],
  providers: [
    CollectionPolicyAssignmentService,
    CollectionPolicyAssignmentSubjectDataContract,
    WorkspaceReferenceService,
  ],
  exports: [CollectionPolicyAssignmentService, CollectionPolicyAssignmentSubjectDataContract],
})
export class CollectionPolicyAssignmentModule {}
