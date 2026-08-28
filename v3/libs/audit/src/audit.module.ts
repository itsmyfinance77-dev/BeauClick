import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminAuditLogEntity } from './admin-audit-log.entity';
import { AdminAuditService } from './admin-audit.service';
import { AuditEnforcementService } from './audit-enforcement';
import { AuditSubjectDataContract } from './audit-subject-data.contract';

/**
 * Global on purpose.
 *
 * Every module that registers a privileged mutation needs to write an audit
 * record, and the boot-time assertion makes that a requirement rather than a
 * choice. Requiring each of them to remember to import this module would add a
 * second way to fail -- one that surfaces as a DI error at boot rather than as
 * a missing record, but a second way nonetheless.
 *
 * The entity list is exported so the composition root can register it on the
 * main DataSource alongside every other domain's.
 */
@Global()
@Module({
  imports: [DiscoveryModule, TypeOrmModule.forFeature([AdminAuditLogEntity])],
  providers: [
    AuditSubjectDataContract,AdminAuditService, AuditEnforcementService],
  exports: [
    AuditSubjectDataContract,AdminAuditService, AuditEnforcementService, TypeOrmModule],
})
export class AuditModule {}

export const AUDIT_ENTITIES = [AdminAuditLogEntity];
