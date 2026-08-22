import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BeauClickJwtModule } from '@beauclick/auth';

import { UserEntity } from './entities/user.entity';
import { OtpRequestEntity } from './entities/otp-request.entity';
import { RefreshTokenEntity } from './entities/refresh-token.entity';
import { PhoneConflictEntity } from './entities/phone-conflict.entity';

import { OtpService } from './otp/otp.service';
import { AccountResolverService } from './account/account-resolver.service';
import { TokenService } from './token/token.service';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { MeController } from './me/me.controller';
import { NoopOtpDebugObserver, OTP_DEBUG_OBSERVER } from './otp/otp-debug-observer';

export const IDENTITY_ENTITIES = [UserEntity, OtpRequestEntity, RefreshTokenEntity, PhoneConflictEntity];

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
  controllers: [AuthController, MeController],
  providers: [
    OtpService,
    AccountResolverService,
    TokenService,
    AuthService,
    { provide: OTP_DEBUG_OBSERVER, useClass: NoopOtpDebugObserver },
  ],
  exports: [TokenService, AuthService, BeauClickJwtModule, TypeOrmModule, OTP_DEBUG_OBSERVER],
})
export class IdentityModule {}
