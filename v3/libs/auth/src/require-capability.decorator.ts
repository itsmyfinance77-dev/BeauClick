import { CustomDecorator, SetMetadata } from '@nestjs/common';

export const CAPABILITY_KEY = 'beauclick:capability';

/** V3_API_CONTRACT_BLUEPRINT.md §3: capability-based RBAC, never a role-string check inline in a handler. */
export const RequireCapability = (capability: string): CustomDecorator<string> => SetMetadata(CAPABILITY_KEY, capability);
