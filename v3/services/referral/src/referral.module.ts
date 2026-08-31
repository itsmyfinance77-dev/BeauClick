import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { REFERRAL_ENTITIES } from './entities/referral.entities';
import { REFERRAL_CLOCK, systemReferralClock } from './referral-clock';
import { REFERRAL_CODE_GENERATOR, defaultReferralCodeGenerator } from './referral-code.generator';
import { ReferralController } from './referral.controller';
import { ReferralService } from './referral.service';
import { ReferralSubjectDataContract } from './referral-subject-data.contract';

/**
 * The referral module (ADR-035).
 *
 * ## Its two ports, and what they measure about the boundary
 *
 * Story #11 declared **none**, and ADR-035 recorded why: a referral code is
 * generated from a CSPRNG and stored against the session's own user id, and
 * neither step needs a fact from any other domain. It also recorded what would
 * change it — *Story #27 has to ask `identity` how old an account is, and
 * `V32-DEC-019` binds the answer to an indistinguishable refusal.*
 *
 * That is now the case, and it needs `booking` too. `REFERRAL_IDENTITY_PORT` and
 * `REFERRAL_BOOKING_PORT` are declared by this module and bound in
 * `apps/api/src/composition` (ADR-011, ADR-036 §4), exactly as
 * `WISHLIST_TARGET_PORT` is.
 *
 * **Neither has a default implementation here, and that is the whole point of
 * declaring them rather than importing.** A module that cannot boot without its
 * ports bound is a module whose boundary is real: there is nothing to fall back
 * on, and no way to ship a stub by accident. It matters more than usual here,
 * because a permissive stub — "everybody is new", "nobody has booked" — would
 * pass every test written against this module alone while disabling two of the
 * six eligibility rules in production.
 *
 * The clock below is the opposite case and is bound here: like the generator, it
 * is a **seam** rather than a port, and a composition that says nothing about it
 * still gets correct behaviour.
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
  providers: [
    ReferralService,
    ReferralSubjectDataContract,
    // The real CSPRNG generator, bound HERE rather than left to the composition
    // root. It is a seam, not a port: a composition that says nothing about it
    // still gets correct behaviour, which is the opposite of how
    // `WISHLIST_TARGET_PORT` is treated.
    { provide: REFERRAL_CODE_GENERATOR, useValue: defaultReferralCodeGenerator },
    // The wall clock, likewise a seam and not a port. The suite overrides it to
    // freeze time, because the 30-day claim window and the 90-day pending
    // expiry are BOUNDARIES, and a boundary tested by waiting is a boundary
    // nobody has tested (ADR-036 §5).
    { provide: REFERRAL_CLOCK, useValue: systemReferralClock },
    // `REFERRAL_IDENTITY_PORT` and `REFERRAL_BOOKING_PORT` are deliberately
    // ABSENT. See the docblock: no default is the mechanism.
  ],
  exports: [ReferralService, ReferralSubjectDataContract, TypeOrmModule],
})
export class ReferralModule {}
