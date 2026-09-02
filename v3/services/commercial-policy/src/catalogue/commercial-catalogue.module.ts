import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { COMMERCIAL_ENTITIES } from './commercial-catalogue.entities';
import { CommercialCatalogueController } from './commercial-catalogue.controller';
import { CommercialCatalogueService } from './commercial-catalogue.service';
import { CommercialSubjectDataContract } from './commercial-subject-data.contract';

/**
 * The plan and price catalogue (ADR-041, Issue #40 / `#40a`).
 *
 * ## A SECOND module in this service, not a replacement
 *
 * Story #39's `CommercialPolicyModule` — the browser-safe contract, the
 * in-memory `key@version` registry and the four-control gate — is untouched and
 * still composed separately. The two answer different questions: that one
 * resolves the terms one BOOKING accepted, this one is the administrator's
 * catalogue of what a SELLER may subscribe to. Merging them would put a
 * TypeORM dependency into a module Story #39 deliberately kept free of one.
 *
 * ## No AuditModule import, and that is correct rather than an omission
 *
 * `AuditModule` is `@Global()` (see its docblock: every module that registers a
 * privileged mutation must be able to write its record without importing
 * anything). So `AdminAuditService` resolves here without an import, and the
 * boot-time assertion still refuses to start if any mutation on this
 * controller declares no `@AuditAction`.
 *
 * ## No ports, no clock, no outbox, no event handler, no scheduler
 *
 * This module reads and writes its own five tables and nothing else. It asks no
 * other domain for a fact, so it declares no port; it has no boundary, window
 * or retention horizon, so it needs no clock seam; it emits nothing, because no
 * consumer has been named (ADR-041 §12, ADR-039 §8), so there is no outbox
 * table, no `ServiceName` member and nothing to relay.
 *
 * ## What it exports, and what it withholds
 *
 * The service and the subject-data contract. **Not the repositories** — a
 * module composed alongside this one can read the catalogue and register its
 * erasure, and has no route to the tables whose immutability is the whole
 * point. The same asymmetry `WishlistModule`, `ChatModule` and `ReferralModule`
 * all record.
 */
@Module({
  imports: [TypeOrmModule.forFeature(COMMERCIAL_ENTITIES)],
  controllers: [CommercialCatalogueController],
  providers: [CommercialCatalogueService, CommercialSubjectDataContract],
  exports: [CommercialCatalogueService, CommercialSubjectDataContract],
})
export class CommercialCatalogueModule {}
