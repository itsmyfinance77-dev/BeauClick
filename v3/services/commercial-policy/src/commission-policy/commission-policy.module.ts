import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CommissionPolicyController } from './commission-policy.controller';
import { COMMISSION_POLICY_ENTITIES } from './commission-policy.entities';
import { CommissionPolicyService } from './commission-policy.service';
import { CommissionPolicySubjectDataContract } from './commission-policy-subject-data.contract';

/**
 * The `#43b-1` publication plane — V3.3 Story #173, ADR-052 §1.
 *
 * An additive module in this service. It reads and writes its own two tables
 * and nothing else: no port into `commerce`, `booking`, `payment` or
 * `financial`, no clock seam, no outbox, no event, no scheduler.
 * `AuditModule` is `@Global()`, so `AdminAuditService` resolves without an
 * import and the boot-time assertion still refuses to start if any mutation
 * on the controller declares no `@AuditAction`.
 *
 * It exports the service and the subject-data contract — never the
 * repositories — for the same reason every other module here withholds them.
 * No production module consumes the service yet: `#43b-2` (#192) is the first
 * reader, and `story-43b1-boundary.spec.ts` proves nothing reads it today.
 */
@Module({
  imports: [TypeOrmModule.forFeature([...COMMISSION_POLICY_ENTITIES])],
  controllers: [CommissionPolicyController],
  providers: [CommissionPolicyService, CommissionPolicySubjectDataContract],
  exports: [CommissionPolicyService, CommissionPolicySubjectDataContract],
})
export class CommissionPolicyModule {}
