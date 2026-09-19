import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SellerRiskClassService } from './seller-risk-class.service';
import { SettlementScheduleController } from './settlement-schedule.controller';
import { SETTLEMENT_SCHEDULE_ENTITIES } from './settlement-schedule.entities';
import { SettlementScheduleResolutionService } from './settlement-schedule-resolution.service';
import { SettlementScheduleService } from './settlement-schedule.service';
import { SettlementScheduleSubjectDataContract } from './settlement-schedule-subject-data.contract';

/**
 * The `#43d` settlement plane — V3.3 Story #175, ADR-052 §1 and §8.
 *
 * An additive module. It reads and writes its own three tables and nothing
 * else: no port into `commerce`, `booking`, `payment` or `financial`, no
 * clock seam, no outbox, no event, no scheduler. `AuditModule` is
 * `@Global()`, so `AdminAuditService` resolves without an import and the
 * boot-time assertion still refuses to start if any mutation on the
 * controller declares no `@AuditAction`.
 *
 * It exports the two writers, the READ-ONLY resolver and the subject-data
 * contract — never the repositories. No production module consumes the
 * resolver yet: `#43e` (#176) is the first reader and is `gate:external`
 * behind the payout rail, and `story-43d-boundary.spec.ts` proves nothing
 * reads it today.
 */
@Module({
  imports: [TypeOrmModule.forFeature([...SETTLEMENT_SCHEDULE_ENTITIES])],
  controllers: [SettlementScheduleController],
  providers: [
    SettlementScheduleService,
    SellerRiskClassService,
    SettlementScheduleResolutionService,
    SettlementScheduleSubjectDataContract,
  ],
  exports: [
    SettlementScheduleService,
    SellerRiskClassService,
    SettlementScheduleResolutionService,
    SettlementScheduleSubjectDataContract,
  ],
})
export class SettlementScheduleModule {}
