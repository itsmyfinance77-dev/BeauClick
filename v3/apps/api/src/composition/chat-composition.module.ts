import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CHAT_ELIGIBILITY, CHAT_SELLER_ACCESS, ChatModule, ChatOutboxEntity } from '@beauclick/chat';
import { BusinessEntity, BusinessModule, BusinessStaffEntity } from '@beauclick/business';
import { OutboxSource } from '@beauclick/events';
import { ProfessionalEntity, ProviderModule } from '@beauclick/provider';

import { ChatSweepScheduler } from '../events/chat-sweep.scheduler';
import { BookingBackedChatEligibility, BusinessBackedChatSellerAccess } from './chat-ports';
import { CHAT_OUTBOX_SOURCES } from './chat-tokens';

/**
 * Chat's two port bindings, `@Global()`.
 *
 * ## Why global, and why this is separate from the composition below
 *
 * `ChatModule` declares `CHAT_ELIGIBILITY` and `CHAT_SELLER_ACCESS` and provides
 * neither. Something has to bind them, and the obvious place — the composition module below — does not work: Nest resolves
 * a provider through the injector of the module that DECLARES the consumer,
 * walking up through that module's own imports. `ChatCompositionModule` imports
 * `ChatModule`; the arrow points the wrong way.
 *
 * This codebase has now hit that four times. `PrivilegedCapabilityModule` records
 * it for its verifier, `PrivacyCompositionModule` for the subject-data contract
 * list — where it resolved to an empty array and produced an export with zero
 * sections and an erasure that erased nothing, both of which look like working
 * code — and `AiPortsModule` for the AI context ports. The fix is the same one
 * `DomainPortsModule` uses: bind infrastructure a domain needs in a `@Global()`
 * module, so the domain never has to import a domain to obtain it.
 *
 * A domain module still cannot reach a SERVICE it should not see. Only the two
 * narrow, chat-declared tokens are exported — not `NotificationService`, not the
 * business or provider repositories, and not `SellerPartyLookup`.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    // The repositories the seller-access adapter reads. A repository provider is
    // scoped to the module that registers it, so being available in the
    // (@Global) DomainPortsModule does not make it visible here.
    TypeOrmModule.forFeature([ProfessionalEntity, BusinessEntity, BusinessStaffEntity]),
    ProviderModule,
    BusinessModule,
  ],
  providers: [
    BookingBackedChatEligibility,
    BusinessBackedChatSellerAccess,
    { provide: CHAT_ELIGIBILITY, useExisting: BookingBackedChatEligibility },
    { provide: CHAT_SELLER_ACCESS, useExisting: BusinessBackedChatSellerAccess },
  ],
  exports: [CHAT_ELIGIBILITY, CHAT_SELLER_ACCESS],
})
export class ChatPortsModule {}

/**
 * The V3.2-B composition root.
 *
 * Small, because `ChatModule` was built to need very little from here: two port
 * bindings, an outbox source, and a sweep. That smallness is the measure of
 * whether ADR-031's boundary holds — a composition root that had to reach into
 * `chat` to make it work would be evidence the dependencies were not really ports.
 *
 * **No chat event handler is composed here.** `chat` produces two events and
 * consumes none: `MessageSent` reaches the notification module through the same
 * generic handler every other notification rule uses, and analytics through the
 * existing generic ingestion handler. There is no bespoke chat consumer and no
 * second place a chat payload is read.
 *
 * **No AI wiring exists, and none may be added.** Human chat is not AI context
 * (ADR-032 §5): there is no chat context port, `ai`'s context type is a closed
 * three-key interface whose key set is asserted against a literal, and adding one
 * would take three visible edits.
 */
@Module({
  imports: [
    ConfigModule,
    // FIRST, so the ports are bound before `ChatModule` is instantiated.
    ChatPortsModule,
    ChatModule,
  ],
  providers: [
    ChatSweepScheduler,
    {
      provide: CHAT_OUTBOX_SOURCES,
      // One table, on the shared application DataSource, drained by the same
      // relay every other schema's outbox is drained by.
      useValue: [{ name: 'chat', entity: ChatOutboxEntity }] satisfies OutboxSource[],
    },
  ],
  exports: [CHAT_OUTBOX_SOURCES, ChatSweepScheduler, ChatPortsModule, ChatModule],
})
export class ChatCompositionModule {}
