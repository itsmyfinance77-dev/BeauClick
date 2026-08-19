import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CAPABILITY_KEY } from './require-capability.decorator';

@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.get<string | undefined>(CAPABILITY_KEY, context.getHandler());
    if (!required) return true;

    const request = context.switchToHttp().getRequest();
    const capabilities: string[] = request.user?.capabilities ?? [];
    if (!capabilities.includes(required)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'اجازه دسترسی به این بخش را ندارید.' });
    }
    return true;
  }
}
