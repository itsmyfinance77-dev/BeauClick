import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CommercialPolicyControlGate } from '../commercial-policy-control.gate';
import { BookingCreditEnforcementControlService } from './booking-credit-enforcement-control.service';
import { BookingCreditEnforcementGovernanceService } from './booking-credit-enforcement-governance.service';
import { BookingCreditEnforcementController } from './booking-credit-enforcement.controller';
import { BookingCreditEnforcementSubjectDataContract } from './booking-credit-enforcement-subject-data.contract';
import { ENFORCEMENT_ENTITIES } from './booking-credit-enforcement.entities';

/**
 * The booking-credit enforcement control plane -- V3.3 Story #95 (`#58b-1`),
 * ADR-050.
 *
 * ## A SIXTH module in this service, and why it is separate
 *
 * Story #39's `CommercialPolicyModule` resolves terms; #40a's catalogue is what
 * a seller MAY subscribe to; #56a's foundation is what they HOLD; #69's
 * surface is how they see it; #104's assignment is which collection policy
 * governs them. This module is whether the platform's booking-credit
 * enforcement is globally active, whether it is emergency-stopped, and which
 * sellers are explicitly inside the regime. Different question, different
 * tables, different callers -- and it must not reach the ledger's mutation
 * surface any more than the seller surface may.
 *
 * ## `CommercialPolicyControlGate` is provided here, not re-implemented
 *
 * The gate has been a pure function with no production caller since #39
 * (`V33-DEC-028` finding 5). This module gives it one. Listing it as a
 * provider here rather than importing `CommercialPolicyModule.register([])`
 * keeps this module free of the terms registry it has no use for; the class
 * is stateless, so a second instance is not a second answer.
 *
 * ## No AuditModule import
 *
 * `AuditModule` is `@Global()`, so `AdminAuditService` resolves here without
 * one -- the same arrangement every commercial module documents.
 */
@Module({
  imports: [TypeOrmModule.forFeature([...ENFORCEMENT_ENTITIES])],
  // ONE controller, and it is the administrator sub-resource (ADR-050 §5):
  // seven routes since #141 added activation; a fast test pins the exact set.
  controllers: [BookingCreditEnforcementController],
  providers: [
    CommercialPolicyControlGate,
    BookingCreditEnforcementControlService,
    BookingCreditEnforcementGovernanceService,
    BookingCreditEnforcementSubjectDataContract,
  ],
  exports: [BookingCreditEnforcementControlService, BookingCreditEnforcementGovernanceService, BookingCreditEnforcementSubjectDataContract],
})
export class BookingCreditEnforcementModule {}
