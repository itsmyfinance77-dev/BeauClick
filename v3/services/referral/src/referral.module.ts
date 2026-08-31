import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { REFERRAL_ENTITIES } from './entities/referral.entities';
import { ReferralController } from './referral.controller';
import { ReferralService } from './referral.service';
import { ReferralSubjectDataContract } from './referral-subject-data.contract';

/**
 * The referral module (ADR-035).
 *
 * ## It has no ports, and that is the measure of the boundary
 *
 * `WishlistModule` declares a port because it must read `provider` to decide
 * whether a target is showable. This module declares **none**: a referral code
 * is generated from a CSPRNG and stored against the session's own user id, and
 * neither step needs a fact from any other domain. It depends on nothing at
 * runtime except its own schema, `ConfigModule` for the public origin, and the
 * shared libraries.
 *
 * That will change when attribution lands — Story #27 has to ask `identity` how
 * old an account is, and `V32-DEC-019` binds the answer to an indistinguishable
 * refusal. It is not needed here, and a port declared ahead of its consumer is a
 * seam nothing tests.
 *
 * ## What it exports, and what it withholds
 *
 * The service and the subject-data contract are exported; the repository is not.
 * A module composed alongside this one can register referral's erasure and can
 * read the caller's own code, and has no route to the table holding every
 * customer's bearer credential — the same asymmetry `JourneyModule`,
 * `AiModule`, `ChatModule`, and `WishlistModule` all record.
 *
 * ## No AuditModule
 *
 * Unlike `ChatModule`, this module imports no `AuditModule`. `libs/audit`'s
 * boot-time check requires an `@AuditAction` on any mutation gated by a
 * PRIVILEGED capability; the one route here is gated by authentication alone and
 * acts only on the caller's own data, so there is no privileged mutation to
 * record. Adding an administrative route later would change that, and the boot
 * check would say so rather than letting it through.
 *
 * ## No outbox, no event handler, no scheduler
 *
 * `referral` is in `ServiceName` (ADR-035 §1) because `V32-DEC-033` already
 * approves `ReferralQualified` and `ReferralReversed` by name — but this story
 * produces neither, consumes nothing, and has no retention horizon to sweep. A
 * code is destroyed by its owner's erasure and by nothing else.
 */
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(REFERRAL_ENTITIES)],
  controllers: [ReferralController],
  providers: [ReferralService, ReferralSubjectDataContract],
  exports: [ReferralService, ReferralSubjectDataContract, TypeOrmModule],
})
export class ReferralModule {}
