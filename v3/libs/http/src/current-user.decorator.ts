import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthenticatedUser {
  userId: string;
  roles: string[];
  capabilities: string[];
}

/**
 * The ONLY sanctioned way a controller reads "who is calling" --
 * always derived from the verified JWT (populated by JwtAuthGuard), never
 * from a request body/query param. V3_SECURITY_MODEL.md §3.
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
  const request = ctx.switchToHttp().getRequest();
  return request.user;
});
