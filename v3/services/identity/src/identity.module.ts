import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BeauClickJwtModule } from '@beauclick/auth';

import { UserEntity } from './entities/user.entity';
import { OtpRequestEntity } from './entities/otp-request.entity';
import { RefreshTokenEntity } from './entities/refresh-token.entity';
import { PhoneConflictEntity } from './entities/phone-conflict.entity';
import { CapabilityEntity, RoleCapabilityEntity, RoleEntity, UserRoleEntity } from './entities/role.entities';

import { OtpService } from './otp/otp.service';
import { AccountResolverService } from './account/account-resolver.service';
import { TokenService } from './token/token.service';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { MeController } from './me/me.controller';
import { NoopOtpDebugObserver, OTP_DEBUG_OBSERVER } from './otp/otp-debug-observer';
import { RoleService } from './rbac/role.service';
import { AdminRolesController } from './admin/admin-roles.controller';
import { AdminAuditController } from './admin/admin-audit.controller';
import { AdminPhoneConflictsController } from './admin/admin-phone-conflicts.controller';
import { PhoneConflictService } from './admin/phone-conflict.service';
import { IdentitySubjectDataContract } from './identity-subject-data.contract';

export const IDENTITY_ENTITIES = [
  UserEntity,
  OtpRequestEntity,
  RefreshTokenEntity,
  PhoneConflictEntity,
  RoleEntity,
  CapabilityEntity,
  RoleCapabilityEntity,
  UserRoleEntity,
];

@Module({
  // ThrottlerModule is deliberately NOT configured here any more. It was,
  // and that was half of why global throttling never actually worked:
  // `ThrottlerModule.forRoot()` is not a @Global module in v6, so its
  // ThrottlerStorage/options were only resolvable inside THIS module's
  // injector -- meaning a root-level APP_GUARD could not have resolved them
  // even once someone registered one. It now lives in AppModule, at the root,
  // where the global guard actually runs. (Same class of DI trap as Phase 4's
  // PRICING_RULES-in-the-wrong-module bug.)
  imports: [TypeOrmModule.forFeature(IDENTITY_ENTITIES), BeauClickJwtModule],
  controllers: [AuthController, MeController, AdminRolesController, AdminAuditController, AdminPhoneConflictsController],
  providers: [
    IdentitySubjectDataContract,
    OtpService,
    AccountResolverService,
    TokenService,
    AuthService,
    RoleService,
    PhoneConflictService,
    { provide: OTP_DEBUG_OBSERVER, useClass: NoopOtpDebugObserver },
  ],
  exports: [
    IdentitySubjectDataContract,TokenService, AuthService, RoleService, BeauClickJwtModule, TypeOrmModule, OTP_DEBUG_OBSERVER],
})
export class IdentityModule {}
