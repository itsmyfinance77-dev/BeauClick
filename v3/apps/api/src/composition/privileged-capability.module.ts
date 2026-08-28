import { Global, Module } from '@nestjs/common';

import { PRIVILEGED_CAPABILITY_VERIFIER } from '@beauclick/auth';
import { IdentityModule, RoleService } from '@beauclick/identity';

/**
 * The live privileged-capability re-check, bound once and reachable
 * everywhere.
 *
 * WHY THIS IS A GLOBAL MODULE rather than a provider on `AppModule`, which is
 * where it started. A provider declared in a module's own `providers` array is
 * visible to that module's controllers and providers -- and to nothing it
 * imports. `CapabilityGuard` is an `APP_GUARD` registered on `AppModule`, so
 * the original arrangement worked for the guard and only for the guard.
 *
 * V3.1 Phase C added a second consumer: the protected-download route re-checks
 * `bc_moderate_verification` against live data before handing over a
 * verification document, and `MediaService` injects the verifier
 * `@Optional()`. In an imported module that optional injection resolved to
 * `undefined`, and `viewerHasCapability` correctly fell back to `false` --
 * which fails CLOSED, so nothing was ever wrongly authorized, but every
 * moderator was refused every document. Found by the suite, not in production.
 *
 * `@Global()` fixes it once for every future consumer, and the binding stays
 * in `apps/api` because `libs/auth` may not import `services/identity`
 * (ADR-011). The fail-closed behaviour is unchanged: a module that somehow
 * still cannot see this gets `undefined` and denies.
 */
@Global()
@Module({
  imports: [IdentityModule],
  providers: [
    {
      provide: PRIVILEGED_CAPABILITY_VERIFIER,
      useFactory: (roles: RoleService) => ({
        hasCapability: (userId: string, capability: string) => roles.hasCapability(userId, capability),
      }),
      inject: [RoleService],
    },
  ],
  exports: [PRIVILEGED_CAPABILITY_VERIFIER],
})
export class PrivilegedCapabilityModule {}
