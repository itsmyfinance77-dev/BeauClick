import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
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
  imports: [
    TypeOrmModule.forFeature(IDENTITY_ENTITIES),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 30 }]),
    BeauClickJwtModule,
  ],
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
