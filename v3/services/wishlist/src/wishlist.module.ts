import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WISHLIST_ENTITIES } from './entities/wishlist.entities';
import { WishlistController } from './wishlist.controller';
import { WishlistService } from './wishlist.service';
import { WishlistSubjectDataContract } from './wishlist-subject-data.contract';

/**
 * The wishlist module (ADR-033).
 *
 * ## What it does NOT provide, and why that is the boundary
 *
 * `WISHLIST_SAVEABLE_TARGET` is declared in `ports/wishlist.ports.ts` and bound
 * by the composition root. **It is not provided here.** A module that cannot
 * boot without its port bound is a module whose boundary is real: there is no
 * default implementation to fall back on, and no way to ship a stub by accident.
 *
 * That matters here for a specific reason. The port carries `V32-DEC-021`'s
 * saveable predicate, which reads `provider.professionals.verification_status`
 * and two `deleted_at` columns — data `wishlist` may not import (ADR-011,
 * enforced by lint). Providing a permissive stub would put a product decision
 * inside a module that cannot see the data it is about, and the stub would pass
 * every test written against this module alone.
 *
 * ## What it exports, and what it withholds
 *
 * The service and the subject-data contract are exported; the repository is not.
 * A module composed alongside this one can register wishlist's erasure and can
 * read the caller's own list, and has no route to the table holding every
 * customer's saved ids — the same asymmetry `JourneyModule`, `AiModule`, and
 * `ChatModule` all record.
 *
 * ## No AuditModule
 *
 * Unlike `ChatModule`, this module imports no `AuditModule`. `libs/audit`'s
 * boot-time check requires an `@AuditAction` on any mutation gated by a
 * PRIVILEGED capability; every route here is gated by authentication alone and
 * acts only on the caller's own data, so there is no privileged mutation to
 * record. Adding an administrative route later would change that, and the boot
 * check would say so rather than letting it through.
 */
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(WISHLIST_ENTITIES)],
  controllers: [WishlistController],
  providers: [WishlistService, WishlistSubjectDataContract],
  exports: [WishlistService, WishlistSubjectDataContract, TypeOrmModule],
})
export class WishlistModule {}
