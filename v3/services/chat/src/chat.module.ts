import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '@beauclick/audit';

import { CHAT_CLOCK, systemChatClock } from './chat-clock';
import { ChatAccessService } from './chat-access.service';
import { ChatController } from './chat.controller';
import { ChatModerationController } from './chat-moderation.controller';
import { ChatModerationService } from './chat-moderation.service';
import { ChatRetentionService } from './chat-retention.service';
import { ChatService } from './chat.service';
import { ChatSubjectDataContract } from './chat-subject-data.contract';
import { CHAT_ENTITIES } from './entities/chat.entities';

/**
 * The chat module (ADR-031, ADR-032).
 *
 * ## What it does NOT provide, and why that is the boundary
 *
 * `CHAT_ELIGIBILITY`, `CHAT_SELLER_ACCESS`, and `CHAT_NOTIFICATION` are declared
 * in `ports/chat.ports.ts` and bound by the composition root. **None is provided
 * here.** A module that cannot boot without its ports bound is a module whose
 * boundary is real: there is no default implementation to fall back on, and no
 * way to accidentally ship one.
 *
 * That matters more here than it did for `ai`. The eligibility port is where
 * `V32-DEC-011` lives — the rule that a `cancelled` booking qualifies only with
 * proven prior confirmation — and the seller-access port is where `V32-DEC-010`'s
 * owner-and-managers rule lives. Both read `booking`, `commerce`, and `business`,
 * which `chat` may not import (ADR-011, enforced by lint). Providing a stub here
 * would put those two decisions inside a domain that cannot see the data they
 * are about.
 *
 * ## What it exports, and what it withholds
 *
 * The services and the subject-data contract are exported; the repositories are
 * not. A module composed alongside this one can register chat's erasure and can
 * drive its sweep, and has no route to the tables holding customers' messages —
 * the same asymmetry `JourneyModule` and `AiModule` record.
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature(CHAT_ENTITIES),
    // For `AdminAuditService`. The moderation controller writes an audit row for
    // every read AND every decision, and `libs/audit` refuses to boot if a
    // mutation gated on a privileged capability declares no audit action.
    AuditModule,
  ],
  controllers: [ChatController, ChatModerationController],
  providers: [
    { provide: CHAT_CLOCK, useValue: systemChatClock },
    ChatAccessService,
    ChatService,
    ChatModerationService,
    ChatRetentionService,
    ChatSubjectDataContract,
  ],
  exports: [
    ChatAccessService,
    ChatService,
    ChatModerationService,
    ChatRetentionService,
    ChatSubjectDataContract,
    TypeOrmModule,
  ],
})
export class ChatModule {}
