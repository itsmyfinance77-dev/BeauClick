import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NOTIFICATION_ENTITIES } from './entities/notification.entities';
import { InAppChannel, LoggingEmailChannel, LoggingSmsChannel, RECIPIENT_RESOLVER, RecipientResolverPort } from './channels/channels';
import { NOTIFICATION_CHANNELS_TOKEN, NotificationChannelPort } from './channels/notification-channel.port';
import { NotificationAdminController, NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { PreferenceService } from './preference.service';
import { TemplateRegistry } from './templates/template.registry';

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
    TemplateRegistry,
    PreferenceService,
    NotificationService,
    InAppChannel,
    {
      provide: LoggingSmsChannel,
      inject: [RECIPIENT_RESOLVER],
      useFactory: (recipients: RecipientResolverPort) => new LoggingSmsChannel(recipients),
    },
    {
      provide: LoggingEmailChannel,
      inject: [RECIPIENT_RESOLVER],
      useFactory: (recipients: RecipientResolverPort) => new LoggingEmailChannel(recipients),
    },
    {
      provide: NOTIFICATION_CHANNELS_TOKEN,
      inject: [InAppChannel, LoggingSmsChannel, LoggingEmailChannel],
      useFactory: (inApp: InAppChannel, sms: LoggingSmsChannel, email: LoggingEmailChannel): NotificationChannelPort[] => [
        inApp,
        sms,
        email,
      ],
    },
  ],
  exports: [NotificationService, PreferenceService, TemplateRegistry, TypeOrmModule],
})
export class NotificationModule {}
