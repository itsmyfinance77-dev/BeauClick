import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CAPABILITY_KEY } from './require-capability.decorator';
import {
  PRIVILEGED_CAPABILITIES,
  PRIVILEGED_CAPABILITY_VERIFIER,
  PrivilegedCapabilityVerifier,
} from './privileged-capability.port';

const DENIED = { code: 'FORBIDDEN', message: 'اجازه دسترسی به این بخش را ندارید.' };

@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(PRIVILEGED_CAPABILITY_VERIFIER)
    private readonly verifier?: PrivilegedCapabilityVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.get<string | undefined>(CAPABILITY_KEY, context.getHandler());
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
