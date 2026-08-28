import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NOTIFICATION_ENTITIES } from './entities/notification.entities';
import { InAppChannel, LoggingEmailChannel, SmsChannel, RECIPIENT_RESOLVER, RecipientResolverPort } from './channels/channels';
import { NullSmsProvider, SMS_PROVIDER, SmsProvider } from './channels/sms/sms-provider.port';
import { HttpSmsProvider, httpSmsConfigFromEnv } from './channels/sms/http-sms-provider';
import { NOTIFICATION_CHANNELS_TOKEN, NotificationChannelPort } from './channels/notification-channel.port';
import { NotificationAdminController, NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { PreferenceService } from './preference.service';
import { TemplateRegistry } from './templates/template.registry';
import { NotificationSubjectDataContract } from './notification-subject-data.contract';

/**
 * The channel list is assembled here, and its ORDER is not meaningful --
 * every channel is dispatched independently and keyed by name, so adding one
 * cannot change another's behaviour. That is the property V2's WooCommerce
 * hook-priority pricing lacked, and the reason the pricing engine was rebuilt
 * in Phase 2; the same discipline is applied here from the start.
 */
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(NOTIFICATION_ENTITIES)],
  controllers: [NotificationController, NotificationAdminController],
  providers: [
    NotificationSubjectDataContract,
    TemplateRegistry,
    PreferenceService,
    NotificationService,
    InAppChannel,
    {
      /**
       * Which SMS provider this deployment got (`GAP-11`).
       *
       * Read from the environment at boot rather than injected by the
       * composition root, because the choice is deployment configuration and
       * nothing else -- there is no code path that selects a provider, which
       * is what makes selecting a vendor a config change.
       *
       * Falls back to `NullSmsProvider` when unconfigured, and the fallback is
       * VISIBLE: `SmsChannel.providerVerified` becomes false and `/health`
       * says so, so an environment that believes it is sending and is not
       * cannot look like one that is.
       */
      provide: SMS_PROVIDER,
      useFactory: (): SmsProvider => {
        const config = httpSmsConfigFromEnv(process.env);
        return config ? new HttpSmsProvider(config) : new NullSmsProvider();
      },
    },
    {
      provide: SmsChannel,
      inject: [RECIPIENT_RESOLVER, SMS_PROVIDER],
      useFactory: (recipients: RecipientResolverPort, provider: SmsProvider) => new SmsChannel(recipients, provider),
    },
    {
      provide: LoggingEmailChannel,
      inject: [RECIPIENT_RESOLVER],
      useFactory: (recipients: RecipientResolverPort) => new LoggingEmailChannel(recipients),
    },
    {
      provide: NOTIFICATION_CHANNELS_TOKEN,
      inject: [InAppChannel, SmsChannel, LoggingEmailChannel],
      useFactory: (inApp: InAppChannel, sms: SmsChannel, email: LoggingEmailChannel): NotificationChannelPort[] => [
        inApp,
        sms,
        email,
      ],
    },
  ],
  exports: [
    NotificationSubjectDataContract,
    NotificationService,
    PreferenceService,
    TemplateRegistry,
    SMS_PROVIDER,
    TypeOrmModule,
  ],
})
export class NotificationModule {}
