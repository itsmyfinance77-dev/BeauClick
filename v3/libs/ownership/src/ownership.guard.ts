import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { OWNER_RESOLVER_KEY } from './resolve-owner.decorator';
import { OwnerResolverClass } from './owner-resolver.interface';
import { NotFoundOrNotYoursException } from './not-found-or-not-yours.exception';

/**
 * Enforces V3_SECURITY_MODEL.md §3's "ownerId := resolveOwner(session.userId)"
 * pattern structurally: a route decorated with @ResolveOwner never trusts a
 * request-supplied id for authorization, only whatever the resolver computes
 * server-side from the authenticated session. This guard runs AFTER the JWT
 * auth guard (which populates req.user) -- see AuthModule wiring.
 */
@Injectable()
export class OwnershipGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly moduleRef: ModuleRef,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const resolverClass = this.reflector.get<OwnerResolverClass | undefined>(OWNER_RESOLVER_KEY, context.getHandler());

    // No @ResolveOwner declared -- this guard has nothing to enforce here;
    // the route either needs no ownership check (public/self-only via JWT
    // alone) or declares its own check some other way. Fail OPEN only in
    // the sense of "not this guard's concern", never in the sense of
    // skipping auth -- JwtAuthGuard is a separate, always-applied guard.
    if (!resolverClass) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const sessionUserId: string | undefined = request.user?.userId;
    if (!sessionUserId) {
      throw new UnauthorizedException();
    }

    const resolver = await this.moduleRef.get(resolverClass, { strict: false });
    const resolvedOwnerId = await resolver.resolve(sessionUserId, request.params);

    // Identical response whether the resource doesn't exist or exists but
    // belongs to someone else -- never distinguishable (V3_SECURITY_MODEL.md
    // §3's explicit "must not leak existence" requirement).
    if (!resolvedOwnerId || resolvedOwnerId !== sessionUserId) {
      throw new NotFoundOrNotYoursException();
    }

    return true;
  }
}
