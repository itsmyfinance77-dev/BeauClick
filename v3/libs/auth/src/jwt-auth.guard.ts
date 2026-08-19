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
      request.user = { userId: payload.sub, roles: payload.roles, capabilities: payload.capabilities };
      return true;
    } catch {
      if (isPublic) return true;
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'نشست شما منقضی شده است. دوباره وارد شوید.' });
    }
  }
}
