import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CAPABILITY_KEY } from './require-capability.decorator';
import {
  PRIVILEGED_CAPABILITIES,
  PRIVILEGED_CAPABILITY_VERIFIER,
  PrivilegedCapabilityVerifier,
} from './privileged-capability.port';

const DENIED = { code: 'FORBIDDEN', message: 'اجازه دسترسی به این بخش را ندارید.' };

/**
 * V3_API_CONTRACT_BLUEPRINT.md §3's capability RBAC.
 *
 * ## Why the requirement is read from the handler AND the class
 *
 * The original version read `context.getHandler()` only. Every controller in
 * the platform happened to decorate each route individually, so it worked --
 * and it worked by coincidence.
 *
 * A `@RequireCapability` written on the CONTROLLER was silently ignored: the
 * reflector found nothing on the handler, `canActivate` returned `true` on its
 * first line, and every route on that controller was unauthenticated-adjacent
 * -- reachable by any logged-in user regardless of role. Nothing failed, nothing
 * logged, and the decorator sitting above the class read as protection.
 *
 * That is the worst shape a security control can have: absent, and looking
 * present. Found by V3.2-A's suite when `AiController` used the class-level
 * form and a professional -- who does not hold `bc_use_ai_assistant` -- was
 * served a customer's assistant surface with a 200.
 *
 * `getAllAndOverride` fixes it and keeps the more specific declaration winning:
 * a handler-level capability overrides its controller's, which is what somebody
 * writing both would expect. Reading the class ADDS enforcement where a
 * decorator was written and dropped; it cannot remove any, so no existing route
 * changes behaviour.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(PRIVILEGED_CAPABILITY_VERIFIER)
    private readonly verifier?: PrivilegedCapabilityVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Handler first, then the controller. See the class docblock: reading only
    // the handler made a controller-level decorator a silent no-op.
    const required = this.reflector.getAllAndOverride<string | undefined>(CAPABILITY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest();
    const capabilities: string[] = request.user?.capabilities ?? [];
    if (!capabilities.includes(required)) {
      throw new ForbiddenException(DENIED);
    }

    // The token says yes. For a privileged capability that is not sufficient:
    // the token is a snapshot taken up to a full access-token TTL ago, and a
    // revoked operator must lose the admin surface now, not in fifteen minutes.
    // See privileged-capability.port.ts for the reasoning and the cost.
    if (!PRIVILEGED_CAPABILITIES.includes(required)) return true;

    // No verifier bound means the composition root has not wired one. That is a
    // legitimate configuration for a test module that boots a single service in
    // isolation, and it is NOT a silent downgrade: the token check above has
    // already passed, so this branch is exactly as strict as the guard was
    // before the re-check existed.
    if (!this.verifier) return true;

    const userId: string | undefined = request.user?.userId;
    if (!userId) throw new ForbiddenException(DENIED);

    let stillHolds: boolean;
    try {
      stillHolds = await this.verifier.hasCapability(userId, required);
    } catch {
      // Fail closed. A verifier that cannot answer is not evidence that the
      // caller is authorized.
      throw new ForbiddenException(DENIED);
    }

    if (!stillHolds) throw new ForbiddenException(DENIED);
    return true;
  }
}
