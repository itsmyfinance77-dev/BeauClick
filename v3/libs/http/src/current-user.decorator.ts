import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthenticatedUser {
  userId: string;
  roles: string[];
  capabilities: string[];
  /**
   * The refresh-token row this access token was minted from (`QA-20`), or
   * `null` for a token issued before the claim existed.
   *
   * Never use it as authorization. It identifies WHICH of the caller's own
   * sessions is speaking, and nothing more -- every route that acts on a
   * session still resolves ownership from `userId`.
   */
  sessionId: string | null;
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
