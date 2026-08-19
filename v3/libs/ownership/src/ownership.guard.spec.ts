import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OwnershipGuard } from './ownership.guard';
import { NotFoundOrNotYoursException } from './not-found-or-not-yours.exception';
import { OwnerResolver } from './owner-resolver.interface';

class AlwaysOwnerOneResolver implements OwnerResolver {
  async resolve(): Promise<string | null> {
    return 'user-1';
  }
}

class AlwaysNullResolver implements OwnerResolver {
  async resolve(): Promise<string | null> {
    return null;
  }
}

/** reflector.get is mocked directly in each test to return the metadata OwnershipGuard would have looked up -- the handler function's real identity doesn't matter here, only that switchToHttp()/getHandler() are callable. */
function fakeContext(userId: string | undefined): ExecutionContext {
  const request = { user: userId ? { userId } : undefined, params: { id: 'resource-1' } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handlerPlaceholder() {},
  } as unknown as ExecutionContext;
}

describe('OwnershipGuard', () => {
  it('allows a request when no @ResolveOwner metadata is present (nothing to enforce here)', async () => {
    const reflector = { get: () => undefined } as unknown as Reflector;
    const moduleRef = { get: jest.fn() } as never;
    const guard = new OwnershipGuard(reflector, moduleRef);
    const ctx = fakeContext('user-1');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows the request when the resolved owner matches the session user', async () => {
    const reflector = { get: () => AlwaysOwnerOneResolver } as unknown as Reflector;
    const moduleRef = { get: async () => new AlwaysOwnerOneResolver() } as never;
    const guard = new OwnershipGuard(reflector, moduleRef);
    const ctx = fakeContext('user-1');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('throws NotFoundOrNotYours when the resolved owner does NOT match the session user (forged id)', async () => {
    const reflector = { get: () => AlwaysOwnerOneResolver } as unknown as Reflector;
    const moduleRef = { get: async () => new AlwaysOwnerOneResolver() } as never;
    const guard = new OwnershipGuard(reflector, moduleRef);
    const ctx = fakeContext('user-2-the-attacker');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(NotFoundOrNotYoursException);
  });

  it('throws the SAME exception type when the resolver finds no resource at all (existence never leaks)', async () => {
    const reflector = { get: () => AlwaysNullResolver } as unknown as Reflector;
    const moduleRef = { get: async () => new AlwaysNullResolver() } as never;
    const guard = new OwnershipGuard(reflector, moduleRef);
    const ctx = fakeContext('user-1');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(NotFoundOrNotYoursException);
  });
});
