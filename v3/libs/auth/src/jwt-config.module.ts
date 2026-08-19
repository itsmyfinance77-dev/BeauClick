import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

/**
 * The ONE place the access-token signing secret/TTL is configured --
 * imported by both identity-service (to sign) and apps/api's global guard
 * setup (to verify). Keeping this in libs/auth means the secret/TTL can
 * never drift between issuer and verifier.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      // Explicit imports:[ConfigModule] here, even though ConfigModule is
      // registered isGlobal:true at the application root -- a dynamic
      // module built by registerAsync() resolves its own `inject` list
      // against its OWN declared imports, not implicitly against whatever
      // global modules happen to exist elsewhere in the graph. Omitting
      // this throws "Nest can't resolve dependencies of JWT_MODULE_OPTIONS"
      // at boot, a well-known NestJS/@nestjs/config interaction -- this is
      // the standard, documented fix, not a workaround for something
      // specific to this codebase.
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_ACCESS_SECRET') ?? 'dev-only-insecure-secret-override-in-env',
        signOptions: { expiresIn: config.get('JWT_ACCESS_TTL') ?? '15m' },
      }),
    }),
  ],
  exports: [JwtModule],
})
export class BeauClickJwtModule {}
