import { CanActivate, CustomDecorator, ExecutionContext, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

export const PUBLIC_ROUTE_KEY = 'beauclick:publicRoute';
/**
 * Explicit opt-out for genuinely public routes. Every other route requires
 * a verified JWT by default -- fail closed, not open.
 * (Explicit CustomDecorator return type: pnpm's strict per-package
 * node_modules means each consuming package resolves its own
 * @nestjs/common instance -- an inferred return type referencing it isn't
 * portable across package boundaries, TS2742.)
 */
export const Public = (): CustomDecorator<string> => SetMetadata(PUBLIC_ROUTE_KEY, true);

export interface AccessTokenPayload {
  sub: string;
  roles: string[];
  capabilities: string[];
  /**
   * The refresh-token row this access token was minted from (`QA-20`).
   *
   * WHY THE ACCESS TOKEN CARRIES IT. `GET /v1/auth/sessions` has to answer
   * "which of these is the device I am holding right now" -- otherwise the
   * device-management screen offers a list of indistinguishable rows and the
   * one button that matters, "sign out my other devices", cannot be built
   * without the risk of signing yourself out. The access token is the only
   * artifact the request actually presents, so it is the only place that
   * question can be answered from.
   *
   * WHY IT IS SAFE TO PUT HERE. `sid` is the refresh row's UUID, not the
   * refresh TOKEN -- the token itself is stored only as a SHA-256 hash and
   * never leaves `TokenService.issuePair`. Knowing the id lets a bearer
   * identify their own session; it does not let them use it, and every route
   * that acts on a session id re-checks ownership against the caller.
   *
   * OPTIONAL, and that is load-bearing rather than defensive. Tokens minted
   * before this claim existed are still valid for their full 15 minutes, so a
   * deploy must not 401 every signed-in user. `current` reads `false` for
   * those, which is the honest answer -- it is not known -- and self-corrects
   * on the next refresh.
   */
  sid?: string;
}

/**
 * V3_API_CONTRACT_BLUEPRINT.md §2: verifies the JWT and populates
 * req.user -- the ONLY place a request's identity is established. Lives in
 * libs/auth (not services/identity) because every module needs this same
 * verification, and services/* must never import another services/*
 * directly (ADR-011's Nx module-boundary rule) -- identity-service ISSUES
 * tokens, this guard VERIFIES them, and both only need to agree on the
 * signing secret via shared config, not a direct code dependency.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.get<boolean | undefined>(PUBLIC_ROUTE_KEY, context.getHandler());
    const request = context.switchToHttp().getRequest();

    const authHeader: string | undefined = request.headers?.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;

    if (!token) {
      if (isPublic) return true;
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'برای این عملیات باید وارد حساب کاربری خود شوید.' });
    }

    try {
      const payload = this.jwt.verify<AccessTokenPayload>(token);
      request.user = { userId: payload.sub, roles: payload.roles, capabilities: payload.capabilities, sessionId: payload.sid ?? null };
      return true;
    } catch {
      if (isPublic) return true;
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'نشست شما منقضی شده است. دوباره وارد شوید.' });
    }
  }
}
