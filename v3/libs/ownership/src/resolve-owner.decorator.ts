import { CustomDecorator, SetMetadata } from '@nestjs/common';
import { OwnerResolverClass } from './owner-resolver.interface';

export const OWNER_RESOLVER_KEY = 'beauclick:ownerResolver';

/**
 * Declares that a route's authorization depends on resolving the real
 * owner of the target resource, not merely on the caller being logged in.
 * `resolverClass` must be registered as a provider in the module that owns
 * the route (it's instantiated via Nest's ModuleRef in OwnershipGuard, so
 * it can inject a repository/service the same as any other provider).
 */
export const ResolveOwner = (resolverClass: OwnerResolverClass): CustomDecorator<string> => SetMetadata(OWNER_RESOLVER_KEY, resolverClass);
