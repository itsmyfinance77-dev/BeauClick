import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BookingOutcomePolicyController } from './booking-outcome-policy.controller';
import { BOOKING_OUTCOME_POLICY_ENTITIES } from './booking-outcome-policy.entities';
import { BookingOutcomePolicyService } from './booking-outcome-policy.service';
import { BookingOutcomePolicySubjectDataContract } from './booking-outcome-policy-subject-data.contract';
import { CustomerPolicyCopyService } from './customer-policy-copy.service';
import { LegalEvidenceService } from './legal-evidence.service';

/**
 * The `#42a` publication plane — V3.3 Story #42, ADR-051 §1, §5, §10.
 *
 * A seventh, additive module in this service. It reads and writes its own
 * six tables and nothing else: no port into `booking`, `commerce`, `payment`
 * or `financial`, no clock seam, no outbox, no event, no `ServiceName`, no
 * scheduler. `AuditModule` is `@Global()`, so `AdminAuditService` resolves
 * without an import and the boot-time assertion still refuses to start if any
 * mutation on the controller declares no `@AuditAction`.
 *
 * It exports the three services and the subject-data contract — never the
 * repositories — for the same reason every other module here withholds them.
 * No production module consumes the services yet: `#42b` (#159) is the first
 * reader, and `story-42a-boundary.spec.ts` proves nothing reads them today.
 */
@Module({
  imports: [TypeOrmModule.forFeature([...BOOKING_OUTCOME_POLICY_ENTITIES])],
  controllers: [BookingOutcomePolicyController],
  providers: [LegalEvidenceService, BookingOutcomePolicyService, CustomerPolicyCopyService, BookingOutcomePolicySubjectDataContract],
  exports: [LegalEvidenceService, BookingOutcomePolicyService, CustomerPolicyCopyService, BookingOutcomePolicySubjectDataContract],
})
export class BookingOutcomePolicyModule {}
