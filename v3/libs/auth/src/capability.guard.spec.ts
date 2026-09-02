import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { CapabilityGuard } from './capability.guard';
import { RequireCapability } from './require-capability.decorator';

/**
 * `CapabilityGuard`, and specifically the class-level regression.
 *
 * The guard originally read `context.getHandler()` only. Every controller in
 * the platform decorated each route individually, so it worked — by
 * coincidence. A `@RequireCapability` written on the CONTROLLER was silently
 * ignored, and every route on that controller became reachable by any logged-in
 * user regardless of role, with nothing failing and nothing logged.
 *
 * Found by V3.2-A's real-PostgreSQL suite: `AiController` used the class-level
 * form and a professional was served the customer assistant surface with a 200.
 * These cases exist so it cannot come back.
 */

class HandlerDecorated {
  @RequireCapability('bc_book_service')
  book(): void {}

  undecorated(): void {}
}

@RequireCapability('bc_use_ai_assistant')
class ClassDecorated {
  read(): void {}
  write(): void {}
}

@RequireCapability('bc_use_ai_assistant')
class BothDecorated {
  @RequireCapability('bc_manage_own_profile')
  specific(): void {}

  inherited(): void {}
}

class Undecorated {
  open(): void {}
}

function contextFor(
  target: new () => object,
  method: string,
  capabilities: string[],
  userId = 'user-1',
): ExecutionContext {
  return {
    getHandler: () => (target.prototype as Record<string, unknown>)[method],
    getClass: () => target,
    switchToHttp: () => ({ getRequest: () => ({ user: { userId, capabilities } }) }),
  } as unknown as ExecutionContext;
}

describe('CapabilityGuard', () => {
  const guard = new CapabilityGuard(new Reflector());

  describe('handler-level requirements', () => {
    it('allows a caller holding the capability', async () => {
      await expect(guard.canActivate(contextFor(HandlerDecorated, 'book', ['bc_book_service']))).resolves.toBe(true);
    });

    it('refuses a caller without it', async () => {
      await expect(guard.canActivate(contextFor(HandlerDecorated, 'book', ['bc_view_own_orders']))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('allows an undecorated handler on an undecorated class', async () => {
      await expect(guard.canActivate(contextFor(Undecorated, 'open', []))).resolves.toBe(true);
    });
  });

  describe('class-level requirements — the regression', () => {
    /**
     * The case that was broken. Before the fix this resolved to `true`: the
     * reflector found nothing on the handler and the guard returned on its
     * first line, so the decorator above the class was decoration.
     */
    it('refuses a caller without the CONTROLLER-level capability', async () => {
      await expect(guard.canActivate(contextFor(ClassDecorated, 'read', ['bc_manage_own_profile']))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('refuses on every route of the controller, not only the first', async () => {
      await expect(guard.canActivate(contextFor(ClassDecorated, 'read', []))).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(contextFor(ClassDecorated, 'write', []))).rejects.toThrow(ForbiddenException);
    });

    it('allows a caller holding the controller-level capability', async () => {
      await expect(guard.canActivate(contextFor(ClassDecorated, 'read', ['bc_use_ai_assistant']))).resolves.toBe(true);
      await expect(guard.canActivate(contextFor(ClassDecorated, 'write', ['bc_use_ai_assistant']))).resolves.toBe(true);
    });
  });

  describe('precedence', () => {
    /**
     * The more SPECIFIC declaration wins, which is what somebody writing both
     * would expect — and the direction that cannot accidentally weaken a
     * controller-wide rule into nothing.
     */
    it('lets a handler-level capability override its controller`s', async () => {
      await expect(
        guard.canActivate(contextFor(BothDecorated, 'specific', ['bc_manage_own_profile'])),
      ).resolves.toBe(true);

      // Holding only the CONTROLLER's capability is not enough for a handler
      // that named its own.
      await expect(guard.canActivate(contextFor(BothDecorated, 'specific', ['bc_use_ai_assistant']))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('falls back to the controller for a handler that names none', async () => {
      await expect(guard.canActivate(contextFor(BothDecorated, 'inherited', ['bc_use_ai_assistant']))).resolves.toBe(
        true,
      );
      await expect(guard.canActivate(contextFor(BothDecorated, 'inherited', ['bc_manage_own_profile']))).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('the refusal', () => {
    it('is Persian and names no capability', async () => {
      try {
        await guard.canActivate(contextFor(ClassDecorated, 'read', []));
        throw new Error('should have refused');
      } catch (error) {
        const refusal = error as ForbiddenException;
        expect(refusal).toBeInstanceOf(ForbiddenException);
        const body = refusal.getResponse() as { code: string; message: string };
        expect(body.code).toBe('FORBIDDEN');
        expect(body.message).toMatch(/[؀-ۿ]/);
        // Telling a caller WHICH capability they lack is telling them what to
        // go and obtain.
        expect(JSON.stringify(body)).not.toContain('bc_use_ai_assistant');
      }
    });

    it('refuses a caller with no session at all', async () => {
      const context = {
        getHandler: () => ClassDecorated.prototype.read,
        getClass: () => ClassDecorated,
        switchToHttp: () => ({ getRequest: () => ({}) }),
      } as unknown as ExecutionContext;
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });
  });
});
